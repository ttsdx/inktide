import { Clock, PerspectiveCamera, Scene, WebGLRenderer, MathUtils } from 'three';
import { CelPipeline, QUALITY_PRESETS, type PipelineQuality } from '../render/CelPipeline.ts';
import { updateOutlineViewport } from '../render/OutlineHull.ts';

export type QualityTier = 'low' | 'medium' | 'high' | 'ultra';

export interface EngineOptions {
  canvas: HTMLCanvasElement;
  /** Hard ceiling on device pixel ratio. Retina caps at 2. */
  maxPixelRatio?: number;
  /** Start tier. The adaptive controller moves from here. */
  tier?: QualityTier;
  /** Disable adaptive scaling (the screenshot harness pins quality). */
  adaptive?: boolean;
  /**
   * Keep the drawing buffer after composite. Required for `toDataURL` captures.
   * On a real GPU it forces a copy every frame; play sessions leave it off.
   */
  preserveDrawingBuffer?: boolean;
  /**
   * Start at the preset's native pixel ratio. Play sessions omit this and
   * open at ~1×, then climb if the GPU has headroom — opening a retina
   * laptop at 2× is what made the sim feel half-speed (dt clamped while
   * frames ran 80–100 ms).
   */
  nativeResStart?: boolean;
}

/**
 * ADAPTIVE RESOLUTION
 *
 * The frame budget is 16.67 ms. We track a windowed median (not a mean — one
 * GC spike should not drop the whole game a tier) and move the pixel ratio in
 * small steps, with a long cooldown after any change so the controller cannot
 * oscillate. Resolution moves first because it is the cheapest lever and the
 * least visible; only if resolution bottoms out do we drop effect tiers.
 */
class AdaptiveQuality {
  private samples: number[] = [];
  private cooldown = 0;
  /** Short enough to react within a second at 60 Hz, long enough to ignore a hitch. */
  private readonly window = 18;

  /** Current scale applied on top of the tier's base pixel ratio. */
  scale = 1.0;
  minScale = 0.5;
  maxScale = 1.0;
  tier: QualityTier = 'high';
  enabled = true;

  push(dtMs: number, dpr: number): 'up' | 'down' | null {
    if (!this.enabled) return null;
    this.samples.push(dtMs);
    if (this.samples.length > this.window) this.samples.shift();
    if (this.cooldown > 0) {
      this.cooldown--;
      return null;
    }
    if (this.samples.length < this.window) return null;

    const sorted = [...this.samples].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    // p90 catches sustained hitching that the median hides.
    const p90 = sorted[Math.floor(sorted.length * 0.9)];

    const effective = (tier: QualityTier, scale: number): number => {
      const base = Math.min(dpr, QUALITY_PRESETS[tier].pixelRatio);
      return Math.max(0.5, base * scale);
    };

    if (median > 18.5 || p90 > 26) {
      if (this.scale > this.minScale + 0.001) {
        this.scale = Math.max(this.minScale, this.scale - 0.12);
        this.cooldown = 36;
        return 'down';
      }
      const next: QualityTier | null =
        this.tier === 'ultra' ? 'high' : this.tier === 'high' ? 'medium' : this.tier === 'medium' ? 'low' : null;
      if (!next) return null;
      // Keep the framebuffer size from jumping *up* when a cheaper preset has
      // a higher base pixel ratio than `minScale * oldBase` (ultra 0.62×2 = 1.24
      // vs high at scale 1 = 1.5). The drop has to make the frame cheaper.
      const keep = effective(this.tier, this.scale);
      this.tier = next;
      const newBase = Math.min(dpr, QUALITY_PRESETS[this.tier].pixelRatio);
      this.scale = MathUtils.clamp(keep / newBase, this.minScale, 1);
      this.cooldown = 72;
      return 'down';
    }

    // Only climb back when there is real headroom, and climb slower than we
    // fall so a marginal machine settles instead of pumping. Resolution first;
    // a tier climb preserves the current pixel ratio and lets scale walk up.
    if (median < 12.5 && p90 < 15.5) {
      if (this.scale < this.maxScale) {
        this.scale = Math.min(this.maxScale, this.scale + 0.08);
        this.cooldown = 72;
        return 'up';
      }
      const next: QualityTier | null =
        this.tier === 'low' ? 'medium' : this.tier === 'medium' ? 'high' : this.tier === 'high' ? 'ultra' : null;
      if (!next) return null;
      const keep = effective(this.tier, this.scale);
      this.tier = next;
      const newBase = Math.min(dpr, QUALITY_PRESETS[this.tier].pixelRatio);
      this.scale = MathUtils.clamp(keep / newBase, this.minScale, 1);
      this.cooldown = 90;
      return 'up';
    }
    return null;
  }

  reset(): void {
    this.samples.length = 0;
    this.cooldown = 8;
  }
}

export class Engine {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  readonly pipeline: CelPipeline;
  readonly clock = new Clock();

  readonly adaptive = new AdaptiveQuality();
  private maxPixelRatio: number;
  private baseTier: QualityTier;

  /** Seconds since start, advanced by the fixed-step accumulator. */
  elapsed = 0;
  /** Last frame's wall-clock delta, clamped. */
  dt = 0;
  frame = 0;
  fps = 60;
  private fpsAccum = 0;
  private fpsFrames = 0;

  private running = false;
  private rafId = 0;
  private readonly updateFns: Array<(dt: number, elapsed: number) => void> = [];
  private lastPixelRatio = 0;

  /**
   * Fired after a tier or scale change has been written into the pipeline and
   * the framebuffer. The ocean, the wake field and the spray all have their
   * own quality knobs, and for a long time those knobs existed and were never
   * turned — the adaptive controller only talked to the post chain. Anything
   * that must move with the tier registers here.
   */
  onQualityChange: ((tier: QualityTier, scale: number) => void) | null = null;

  constructor(opts: EngineOptions) {
    this.maxPixelRatio = opts.maxPixelRatio ?? 2;
    this.baseTier = opts.tier ?? 'high';
    this.adaptive.tier = this.baseTier;
    this.adaptive.enabled = opts.adaptive !== false;
    if (opts.adaptive === false || opts.nativeResStart) {
      this.adaptive.scale = 1;
    } else {
      const dpr = Math.min(window.devicePixelRatio || 1, this.maxPixelRatio);
      const base = Math.min(dpr, QUALITY_PRESETS[this.baseTier].pixelRatio);
      this.adaptive.scale = MathUtils.clamp(1 / Math.max(base, 1e-6), this.adaptive.minScale, 1);
    }

    this.renderer = new WebGLRenderer({
      canvas: opts.canvas,
      antialias: false, // MSAA is configured on the MRT target instead.
      alpha: false,
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
      preserveDrawingBuffer: opts.preserveDrawingBuffer === true,
    });
    this.renderer.autoClear = true;
    this.renderer.setClearColor(0x0a1226, 1);
    // Validating every program on every compile hitch is a development
    // convenience, not a frame. Shader errors still throw; we just skip the
    // extra getProgramParameter round-trip on the 60 Hz path.
    this.renderer.debug.checkShaderErrors = false;

    this.camera = new PerspectiveCamera(58, 1, 0.35, 4000);
    this.camera.position.set(0, 8, 24);

    this.pipeline = new CelPipeline(this.renderer, QUALITY_PRESETS[this.baseTier]);

    window.addEventListener('resize', this.handleResize, { passive: true });
    this.handleResize();
  }

  onUpdate(fn: (dt: number, elapsed: number) => void): void {
    this.updateFns.push(fn);
  }

  get quality(): PipelineQuality {
    return this.pipeline.quality;
  }

  setTier(tier: QualityTier): void {
    this.baseTier = tier;
    this.adaptive.tier = tier;
    this.adaptive.scale = 1;
    this.adaptive.reset();
    this.commitQuality();
  }

  /**
   * Push a synthetic frame time through the same path the render loop uses.
   * The adaptive probe has to go through here: driving `pipeline.setQuality`
   * by hand proved the presets existed, not that the controller reached them.
   */
  pumpAdaptive(dtMs: number): 'up' | 'down' | null {
    const dpr = Math.min(window.devicePixelRatio || 1, this.maxPixelRatio);
    const changed = this.adaptive.push(dtMs, dpr);
    if (changed) this.commitQuality();
    return changed;
  }

  private commitQuality(): void {
    this.pipeline.setQuality(QUALITY_PRESETS[this.adaptive.tier]);
    this.applySize();
    this.onQualityChange?.(this.adaptive.tier, this.adaptive.scale);
  }

  private handleResize = (): void => {
    this.applySize();
  };

  private applySize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const preset = QUALITY_PRESETS[this.adaptive.tier];
    const dpr = Math.min(window.devicePixelRatio || 1, this.maxPixelRatio);
    const pr = Math.max(0.5, Math.min(dpr, preset.pixelRatio) * this.adaptive.scale);

    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();

    // The canvas backing store must be at DEVICE resolution, not CSS
    // resolution. An earlier build pinned the renderer's pixel ratio to 1 and
    // sized the canvas in CSS pixels, on the reasoning that the pipeline sizes
    // its own internal targets. It does — but the final composite pass renders
    // to the canvas, so on a 2x display the game was supersampling internally
    // and then resolving into a half-resolution surface that the browser
    // upscaled. Every edge in the game was soft on retina, and the screenshot
    // harness silently captured half-resolution frames while its report claimed
    // otherwise, which invalidated a lot of outline and foam judgement.
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, true);
    this.pipeline.setSize(w, h, pr);
    this.lastPixelRatio = pr;

    // Screen-constant outline width is computed in clip space, so the shells
    // only need the framebuffer dimensions in device pixels.
    updateOutlineViewport(w * pr, h * pr, this.camera.far);
  }

  get pixelRatio(): number {
    return this.lastPixelRatio;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.clock.start();
    this.loop();
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }

  /** Advance and render exactly one frame with a fixed dt (harness use). */
  stepFixed(dt: number): void {
    this.dt = dt;
    this.elapsed += dt;
    this.frame++;
    for (const fn of this.updateFns) fn(dt, this.elapsed);
    this.pipeline.render(this.scene, this.camera, this.elapsed);
  }

  private loop = (): void => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.loop);

    const raw = this.clock.getDelta();
    // Cap so an alt-tab does not teleport boats. 1/12 (not 1/20): when a
    // retina 2× open hitch ran at ~10 fps the old cap made the race crawl at
    // half speed. Physics still uses this dt, so the cap *is* the game clock.
    const dt = MathUtils.clamp(raw, 1 / 240, 1 / 12);
    this.dt = dt;
    this.elapsed += dt;
    this.frame++;

    this.fpsAccum += raw;
    this.fpsFrames++;
    if (this.fpsAccum >= 0.5) {
      this.fps = this.fpsFrames / this.fpsAccum;
      this.fpsAccum = 0;
      this.fpsFrames = 0;
    }

    for (const fn of this.updateFns) fn(dt, this.elapsed);

    this.pipeline.render(this.scene, this.camera, this.elapsed);

    this.pumpAdaptive(raw * 1000);
  };

  dispose(): void {
    this.stop();
    window.removeEventListener('resize', this.handleResize);
    this.pipeline.dispose();
    this.renderer.dispose();
  }
}
