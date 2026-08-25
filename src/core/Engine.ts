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
  private readonly window = 45;

  /** Current scale applied on top of the tier's base pixel ratio. */
  scale = 1.0;
  minScale = 0.62;
  maxScale = 1.0;
  tier: QualityTier = 'high';
  enabled = true;

  push(dtMs: number): 'up' | 'down' | null {
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

    if (median > 18.5 || p90 > 26) {
      if (this.scale > this.minScale) {
        this.scale = Math.max(this.minScale, this.scale - 0.08);
        this.cooldown = 90;
        return 'down';
      }
      if (this.tier === 'ultra') this.tier = 'high';
      else if (this.tier === 'high') this.tier = 'medium';
      else if (this.tier === 'medium') this.tier = 'low';
      else return null;
      this.scale = 1.0;
      this.cooldown = 150;
      return 'down';
    }

    // Only climb back when there is real headroom, and climb slower than we
    // fall so a marginal machine settles instead of pumping.
    if (median < 12.5 && p90 < 15.5 && this.scale < this.maxScale) {
      this.scale = Math.min(this.maxScale, this.scale + 0.04);
      this.cooldown = 150;
      return 'up';
    }
    return null;
  }

  reset(): void {
    this.samples.length = 0;
    this.cooldown = 60;
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

  constructor(opts: EngineOptions) {
    this.maxPixelRatio = opts.maxPixelRatio ?? 2;
    this.baseTier = opts.tier ?? 'high';
    this.adaptive.tier = this.baseTier;
    this.adaptive.enabled = opts.adaptive !== false;

    this.renderer = new WebGLRenderer({
      canvas: opts.canvas,
      antialias: false, // MSAA is configured on the MRT target instead.
      alpha: false,
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
      preserveDrawingBuffer: true, // the screenshot harness reads the canvas
    });
    this.renderer.autoClear = true;
    this.renderer.setClearColor(0x0a1226, 1);
    this.renderer.debug.checkShaderErrors = import.meta.env?.DEV ?? false;

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
    this.pipeline.setQuality(QUALITY_PRESETS[tier]);
    this.adaptive.reset();
    this.applySize();
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
    // Clamp so an alt-tab does not teleport every boat across the course.
    const dt = MathUtils.clamp(raw, 1 / 240, 1 / 20);
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

    const changed = this.adaptive.push(raw * 1000);
    if (changed) {
      this.pipeline.setQuality(QUALITY_PRESETS[this.adaptive.tier]);
      this.applySize();
    }
  };

  dispose(): void {
    this.stop();
    window.removeEventListener('resize', this.handleResize);
    this.pipeline.dispose();
    this.renderer.dispose();
  }
}
