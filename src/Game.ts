import { Vector3 } from 'three';
import { Engine, type QualityTier } from './core/Engine.ts';
import { Input } from './core/Input.ts';
import { CameraRig, type CameraMode, type ChaseTarget } from './core/CameraRig.ts';
import { Sky } from './world/Sky.ts';
import { Ocean } from './world/Ocean.ts';
import { sampleOcean } from './world/gerstner.ts';
import { LAYER_OPAQUE } from './render/layers.ts';

/**
 * Top-level game object. Owns the engine, the world and the race, and is the
 * single place the screenshot harness talks to.
 *
 * Systems are deliberately leaf-shaped: each one exposes `update(dt, ctx)` and
 * knows nothing about the others. `Game` is the only module allowed to wire
 * them together, which keeps the dependency graph a tree.
 */

export interface HarnessCameraPreset {
  name: string;
  position: [number, number, number];
  target: [number, number, number];
}

export class Game {
  readonly engine: Engine;
  readonly input: Input;
  readonly rig: CameraRig;
  readonly sky: Sky;
  readonly ocean: Ocean;

  private started = false;
  private paused = false;

  /** Fake chase target until the player boat exists. */
  private dummyTarget: ChaseTarget = {
    position: new Vector3(0, 0, 0),
    forward: new Vector3(0, 0, 1),
    up: new Vector3(0, 1, 0),
    speed: 0,
    drift: 0,
    slip: 0,
    airborne: false,
  };

  constructor(
    readonly canvas: HTMLCanvasElement,
    readonly hudRoot: HTMLElement,
  ) {
    const url = new URL(window.location.href);
    const tier = (url.searchParams.get('quality') as QualityTier | null) ?? undefined;
    const adaptive = url.searchParams.get('adaptive') !== '0';

    this.engine = new Engine({
      canvas,
      tier: tier ?? 'high',
      adaptive,
      maxPixelRatio: 2,
    });

    this.input = new Input(canvas);
    this.rig = new CameraRig(this.engine.camera);
    this.sky = new Sky();
    this.ocean = new Ocean();
  }

  async init(): Promise<void> {
    const scene = this.engine.scene;

    this.sky.group.traverse((o) => o.layers.set(LAYER_OPAQUE));
    scene.add(this.sky.group);
    scene.add(this.ocean.mesh);

    // The ocean samples the copied scene depth for its waterline foam.
    this.engine.pipeline.onDepthReady = (tex, w, h) => this.ocean.setSceneDepth(tex, w, h);

    this.rig.mode = 'orbit';
    this.rig.orbitCenter.set(0, 1.5, 0);
    this.rig.orbitRadius = 30;
    this.rig.orbitHeight = 8;

    this.engine.onUpdate(this.update);

    // One warm-up frame so every shader is compiled before the first visible
    // frame — otherwise the first second of play is a compile stutter.
    this.engine.stepFixed(1 / 60);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.engine.start();
  }

  /**
   * Advance simulation state without touching the main render path.
   * Used by the harness to fast-forward cheaply.
   */
  private simulateOnly(dt: number): void {
    this.engine.dt = dt;
    this.engine.elapsed += dt;
    this.engine.frame++;
    this.update(dt, this.engine.elapsed);
  }

  private update = (dt: number, elapsed: number): void => {
    if (this.paused) return;
    const control = this.input.update(dt);

    // Track the ocean surface so the orbit camera never dips underwater.
    const s = sampleOcean(this.dummyTarget.position.x, this.dummyTarget.position.z, elapsed);
    this.dummyTarget.position.y = s.height;
    this.rig.orbitCenter.y = s.height + 1.5;

    this.rig.update(dt, this.dummyTarget, elapsed);
    this.sky.update(this.engine.camera, elapsed);
    this.ocean.update(this.engine.camera, elapsed);
  };

  // -------------------------------------------------------------------------
  // Screenshot harness API
  // -------------------------------------------------------------------------

  readonly harness = {
    /** True once the first frame has rendered and shaders are compiled. */
    ready: (): boolean => this.started,

    pause: (): void => {
      this.paused = true;
      this.engine.stop();
    },

    resume: (): void => {
      this.paused = false;
      this.engine.start();
    },

    /**
     * Advance the simulation by a precise number of fixed steps.
     *
     * `render` is off by default: fast-forwarding thirty seconds of race with a
     * full render on every step would take minutes on a software rasteriser,
     * and the intermediate frames are never looked at. Systems that genuinely
     * need per-step GPU work (the wake foam field) are ticked through
     * `simulateOnly` so the state at the capture point is still correct.
     */
    step: (frames: number, dt = 1 / 60, render = false): void => {
      const wasPaused = this.paused;
      this.paused = false;
      for (let i = 0; i < frames; i++) {
        if (render) {
          this.engine.stepFixed(dt);
        } else {
          this.simulateOnly(dt);
        }
      }
      this.paused = wasPaused;
    },

    /** Render exactly n frames without advancing time beyond dt each. */
    renderFrames: (n = 1, dt = 1 / 60): void => {
      const wasPaused = this.paused;
      this.paused = false;
      for (let i = 0; i < n; i++) this.engine.stepFixed(dt);
      this.paused = wasPaused;
    },

    /** Jump the simulation to an absolute time by stepping (deterministic). */
    seek: (seconds: number, dt = 1 / 60): void => {
      const steps = Math.max(0, Math.round((seconds - this.engine.elapsed) / dt));
      this.harness.step(Math.min(steps, 60 * 600), dt);
    },

    setCamera: (mode: CameraMode): void => {
      this.rig.mode = mode;
    },

    setFreeCamera: (pos: [number, number, number], target: [number, number, number]): void => {
      this.rig.setFree(new Vector3(...pos), new Vector3(...target));
    },

    setOrbit: (angle: number, radius: number, height: number): void => {
      this.rig.mode = 'orbit';
      this.rig.orbitAngle = angle;
      this.rig.orbitRadius = radius;
      this.rig.orbitHeight = height;
      this.rig.orbitSpeed = 0;
    },

    setInput: (state: Record<string, unknown> | null): void => {
      this.input.scripted = state as never;
    },

    setQuality: (tier: QualityTier): void => {
      this.engine.setTier(tier);
    },

    stats: () => ({
      fps: this.engine.fps,
      frame: this.engine.frame,
      elapsed: this.engine.elapsed,
      pixelRatio: this.engine.pixelRatio,
      tier: this.engine.adaptive.tier,
      drawCalls: this.engine.pipeline.stats.calls,
      triangles: this.engine.pipeline.stats.triangles,
      programs: this.engine.renderer.info.programs?.length ?? 0,
      geometries: this.engine.renderer.info.memory.geometries,
      textures: this.engine.renderer.info.memory.textures,
    }),
  };
}
