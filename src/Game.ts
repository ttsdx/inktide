import { Color, Group, Object3D, Vector3 } from 'three';
import { Engine, type QualityTier } from './core/Engine.ts';
import { Input } from './core/Input.ts';
import { CameraRig, type CameraMode, type ChaseTarget } from './core/CameraRig.ts';
import { Effects } from './core/Effects.ts';
import { Sky } from './world/Sky.ts';
import { Ocean, type HullContact } from './world/Ocean.ts';
import { WakeField, type WakeEmitter } from './world/WakeField.ts';
import { sampleOcean } from './world/gerstner.ts';
import { LAYER_OPAQUE, LAYER_OVERLAY, LAYER_SKY } from './render/layers.ts';
import { ProbeScene } from './dev/ProbeScene.ts';
import { Course } from './race/Course.ts';
import { RacingLine } from './race/RacingLine.ts';
import { RaceDirector, type RaceEvent } from './race/RaceDirector.ts';
import { AIController, AI_PRESETS } from './race/AIController.ts';
import { GateField } from './entities/Gate.ts';
import { BuoyField } from './entities/Buoy.ts';
import { BoatPhysics } from './entities/BoatPhysics.ts';
import { BOAT_SPECS, HULL_BEAM, RIDER_MOUNT } from './entities/hullSpec.ts';
import { Rider } from './entities/Rider.ts';
import type { BoatCommand, BoatState, RiderPose } from './contracts.ts';

/**
 * Top-level game object. Owns the engine, the world and the race, and is the
 * single place the screenshot harness talks to.
 *
 * Systems are deliberately leaf-shaped: each exposes an `update` and knows
 * nothing about the others. `Game` is the only module allowed to wire them
 * together, which keeps the dependency graph a tree.
 */

/** One racer: physics, its visual boat, and its rider. */
interface Racer {
  physics: BoatPhysics;
  rider: Rider;
  /** Node the rider hangs from; follows the hull transform. */
  mount: Object3D;
  pose: RiderPose;
  command: BoatCommand;
  /** Null for the player. */
  ai: AIController | null;
  /** 0..1 celebration blend, ramps in once this racer has finished. */
  celebrate: number;
}

export class Game {
  readonly engine: Engine;
  readonly input: Input;
  readonly rig: CameraRig;
  readonly effects = new Effects();

  readonly sky: Sky;
  readonly ocean: Ocean;
  wake: WakeField | null = null;

  course: Course | null = null;
  racingLine: RacingLine | null = null;
  gates: GateField | null = null;
  buoys: BuoyField | null = null;
  director: RaceDirector | null = null;

  readonly racers: Racer[] = [];
  /** Scene root for everything race-related, so it can be rebuilt on restart. */
  private readonly raceRoot = new Group();

  private started = false;
  private paused = false;
  private probe: ProbeScene | null = null;

  /** Reusable buffers so the per-frame wiring does not allocate. */
  private readonly emitters: WakeEmitter[] = [];
  private readonly contacts: HullContact[] = [];
  private readonly states: BoatState[] = [];
  private readonly chase: ChaseTarget = {
    position: new Vector3(),
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

    this.engine = new Engine({ canvas, tier: tier ?? 'high', adaptive, maxPixelRatio: 2 });
    this.input = new Input(canvas);
    this.rig = new CameraRig(this.engine.camera);
    this.sky = new Sky();
    this.ocean = new Ocean();
  }

  get player(): Racer | null {
    return this.racers[0] ?? null;
  }

  async init(): Promise<void> {
    const scene = this.engine.scene;
    const url = new URL(window.location.href);

    this.sky.group.traverse((o) => o.layers.set(LAYER_SKY));
    scene.add(this.sky.group);
    scene.add(this.ocean.mesh);
    scene.add(this.raceRoot);

    // The ocean samples the copied scene depth for its waterline foam.
    this.engine.pipeline.onDepthReady = (tex, w, h) => this.ocean.setSceneDepth(tex, w, h);

    this.effects.flashSink = (c, s) => this.engine.pipeline.flash(c, s);
    this.effects.shakeSink = (a, f) => this.rig.shake(a, f);

    // --- world -------------------------------------------------------------
    this.wake = new WakeField(this.engine.renderer, { resolution: 1024, halfExtent: 260 });

    this.course = new Course();
    this.racingLine = new RacingLine(this.course);
    this.racingLine.mesh.traverse((o) => o.layers.set(LAYER_OVERLAY));
    this.raceRoot.add(this.racingLine.mesh);

    this.gates = new GateField(this.course);
    this.gates.root.traverse((o) => o.layers.set(LAYER_OPAQUE));
    this.raceRoot.add(this.gates.root);

    this.buoys = new BuoyField(this.course);
    this.buoys.root.traverse((o) => o.layers.set(LAYER_OPAQUE));
    this.raceRoot.add(this.buoys.root);

    // --- racers ------------------------------------------------------------
    this.buildRacers();

    this.director = new RaceDirector(this.course, this.racers.length);
    this.director.onEvent = this.onRaceEvent;
    this.director.start();

    if (url.searchParams.get('probe') === '1') {
      this.probe = new ProbeScene();
      scene.add(this.probe.root);
    }

    this.rig.mode = 'chase';
    if (this.player) this.snapCameraToPlayer();

    this.engine.onUpdate(this.update);

    // One warm-up frame so every shader is compiled before the first visible
    // frame — otherwise the first second of play is a compile stutter.
    this.engine.stepFixed(1 / 60);
  }

  private buildRacers(): void {
    const course = this.course;
    if (!course) return;

    for (let i = 0; i < BOAT_SPECS.length; i++) {
      const slot = course.startGrid[i % course.startGrid.length];
      const physics = new BoatPhysics(i, BOAT_SPECS[i], slot.position.clone(), slot.heading);
      physics.respawn(slot.position.clone(), slot.heading, 0);

      // The rider hangs off a mount node that carries the hull transform. Once
      // the visual boat exists this node is reparented to Boat.riderMount; until
      // then it is driven directly, so the rider can be seen and critiqued
      // without waiting on hull geometry.
      const mount = new Object3D();
      mount.position.copy(RIDER_MOUNT);
      const hull = new Object3D();
      hull.add(mount);
      hull.layers.set(LAYER_OPAQUE);
      this.raceRoot.add(hull);

      const rider = new Rider(BOAT_SPECS[i].colorIndex);
      rider.root.traverse((o) => o.layers.set(LAYER_OPAQUE));
      mount.add(rider.root);

      // Personalities are assigned in a fixed order so a race is reproducible
      // for the screenshot harness; the PRNG inside each controller is seeded
      // from the boat id for the same reason.
      const ai = i === 0 ? null : new AIController(i, course, AI_PRESETS[i % AI_PRESETS.length]);

      this.racers.push({
        physics,
        rider,
        mount: hull,
        pose: Rider.restPose(),
        command: { throttle: 0, brake: 0, steer: 0, drift: false },
        ai,
        celebrate: 0,
      });
    }
  }

  private readonly onRaceEvent = (e: RaceEvent): void => {
    switch (e.type) {
      case 'countdown':
        if (e.value === 0) this.effects.flash(new Color(0x39ff9c), 0.18);
        break;
      case 'gate':
        this.gates?.flashPassed(e.checkpoint);
        break;
      case 'lap':
        if (e.boatId === 0) this.effects.flash(new Color(0x8ff4ff), 0.12);
        break;
      case 'finish':
        if (e.boatId === 0) {
          this.effects.flash(new Color(0xffffff), 0.28);
          this.rig.mode = 'results';
        }
        break;
      default:
        break;
    }
  };

  start(): void {
    if (this.started) return;
    this.started = true;
    this.engine.start();
  }

  private snapCameraToPlayer(): void {
    const p = this.player;
    if (!p) return;
    this.syncChaseTarget();
    this.rig.snapTo(this.chase);
  }

  private syncChaseTarget(): void {
    const p = this.player;
    if (!p) return;
    const s = p.physics;
    this.chase.position.copy(s.position);
    this.chase.forward.copy(s.forward);
    this.chase.up.copy(s.up);
    this.chase.speed = s.speed;
    this.chase.drift = s.driftAmount;
    this.chase.slip = s.lateralSpeed;
    this.chase.airborne = s.airborne;
  }

  // -------------------------------------------------------------------------

  private update = (dt: number, elapsed: number): void => {
    if (this.paused) return;
    const control = this.input.update(dt);
    this.effects.tick(elapsed);

    const ctx = { dt, elapsed, frame: this.engine.frame };

    // --- drive ---------------------------------------------------------------
    const director = this.director;
    const phase = director?.phase ?? 'racing';
    // Throttle is locked out until the lights go green. Steering is not: being
    // able to line the boat up on the grid while the countdown runs is what
    // stops the start feeling like a cutscene you are watching.
    const launched = phase === 'racing' || phase === 'finished' || phase === 'results';

    this.states.length = 0;
    for (const r of this.racers) this.states.push(r.physics);

    for (let i = 0; i < this.racers.length; i++) {
      const r = this.racers[i];
      if (i === 0) {
        r.command.throttle = launched ? control.throttle : 0;
        r.command.brake = launched ? control.brake : 0;
        r.command.steer = control.steer;
        r.command.drift = launched && control.drift;
      } else if (r.ai && director) {
        const prog = director.get(i);
        const playerProg = director.get(0);
        if (prog && playerProg) {
          const cmd = r.ai.update(r.physics, this.states, prog, playerProg, ctx);
          r.command.throttle = launched ? cmd.throttle : 0;
          r.command.brake = launched ? cmd.brake : 0;
          r.command.steer = cmd.steer;
          r.command.drift = launched && cmd.drift;
        }
      }
      r.physics.update(r.command, ctx, i === 0 ? this.effects : null);
    }

    // Boat-to-boat contact, all pairs. Four racers means six tests.
    for (let a = 0; a < this.racers.length; a++) {
      for (let b = a + 1; b < this.racers.length; b++) {
        this.racers[a].physics.resolveBoatCollision(this.racers[b].physics);
      }
    }

    // --- race logic ----------------------------------------------------------
    director?.update(this.states, ctx);

    // --- visuals -------------------------------------------------------------
    this.emitters.length = 0;
    this.contacts.length = 0;

    for (let i = 0; i < this.racers.length; i++) {
      const r = this.racers[i];
      const s = r.physics;

      r.mount.position.copy(s.position);
      s.getQuaternion(r.mount.quaternion);

      // Celebration ramps in over a second once a racer is done, so the pose
      // change reads as a reaction rather than a state flip.
      const finished = director?.get(i)?.finished ?? false;
      const target = finished ? 1 : 0;
      r.celebrate += (target - r.celebrate) * Math.min(1, 1.6 * dt);

      r.pose = Rider.poseFromBoat(s, r.pose, dt, r.celebrate);
      r.rider.update(r.pose, ctx);

      if (!s.airborne) {
        this.emitters.push({
          position: s.position,
          forward: s.forward,
          speed: s.speed,
          turnRate: s.steerLevel * 1.4,
          width: HULL_BEAM,
          strength: Math.min(1, 0.25 + s.speed / 22),
        });
      }

      this.contacts.push({
        position: s.position,
        radius: 2.6,
        strength: Math.min(1, 0.35 + s.speed / 26),
        forwardX: s.forward.x,
        forwardZ: s.forward.z,
      });
    }

    // --- camera --------------------------------------------------------------
    this.syncChaseTarget();
    if (control.cameraPressed) this.cycleCamera();
    this.rig.update(dt, this.chase, elapsed);
    this.keepCameraAboveWater(elapsed);

    // --- world ---------------------------------------------------------------
    const cam = this.engine.camera;
    const focus = this.player?.physics.position ?? cam.position;

    if (this.wake) {
      this.wake.follow(focus.x, focus.z);
      this.wake.submit(this.emitters);
      this.wake.update(ctx);
      this.ocean.setWakeField(this.wake.texture, this.wake.centerX, this.wake.centerZ, this.wake.extent);
    }

    this.ocean.setContacts(this.contacts);
    this.probe?.update(elapsed);
    this.sky.update(cam, elapsed);
    this.ocean.update(cam, elapsed);

    if (this.gates) {
      const next = director?.get(0)?.nextCheckpoint;
      if (next !== undefined) this.gates.setActiveIndex(next);
      this.gates.update(ctx);
    }
    if (this.buoys) {
      this.buoys.setFocus(focus);
      this.buoys.update(ctx);
    }

    if (this.racingLine && this.course && this.player) {
      this.racingLine.update(elapsed, cam.position);
      const t = this.course.closestT(this.player.physics.position, this.lastPlayerT);
      this.lastPlayerT = t;
      this.updateCornerPreview(t);
    }

    if (control.resetPressed) this.respawnPlayer(elapsed);
  };

  private lastPlayerT = 0;
  private readonly curvatureAhead = new Float32Array(24);

  /** Sample curvature down the road so the ribbon can colour the corner ahead. */
  private updateCornerPreview(t: number): void {
    const line = this.racingLine;
    const course = this.course;
    if (!line || !course) return;
    let cursor = t;
    for (let i = 0; i < this.curvatureAhead.length; i++) {
      this.curvatureAhead[i] = course.sample(Course.wrap(cursor)).curvature;
      cursor = course.advance(cursor, line.previewSpacing);
    }
    line.setPlayerProgress(t, this.curvatureAhead);
  }

  private cycleCamera(): void {
    const order: CameraMode[] = ['chase', 'onboard', 'heli'];
    const i = order.indexOf(this.rig.mode);
    this.rig.mode = order[(i + 1) % order.length];
  }

  private respawnPlayer(elapsed: number): void {
    const p = this.player;
    const course = this.course;
    if (!p || !course) return;
    // Put the player back on the racing line facing the right way, which is the
    // only respawn that is never a punishment.
    const point = course.sample(Course.wrap(this.lastPlayerT), elapsed);
    const heading = Math.atan2(point.tangent.x, point.tangent.z);
    p.physics.respawn(point.position.clone(), heading, elapsed);
    this.snapCameraToPlayer();
  }

  /**
   * Push the camera up out of the water.
   *
   * A spring chase cam sitting 4 m above a boat will still be swallowed by a
   * 3.5 m swell crest at the wrong moment, and because the ocean is single
   * sided the frame it happens on shows straight through the surface. Rather
   * than paying for a two-sided ocean and an underwater look for two frames a
   * minute, the camera is simply not allowed below the surface.
   */
  private keepCameraAboveWater(elapsed: number): void {
    const cam = this.engine.camera;
    const s = sampleOcean(cam.position.x, cam.position.z, elapsed);
    const floorY = s.height + 1.15;
    if (cam.position.y < floorY) {
      cam.position.y = floorY;
      cam.updateMatrixWorld();
    }
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

  // -------------------------------------------------------------------------
  // Screenshot harness API
  // -------------------------------------------------------------------------

  readonly harness = {
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
     * and the intermediate frames are never looked at.
     */
    step: (frames: number, dt = 1 / 60, render = false): void => {
      const wasPaused = this.paused;
      this.paused = false;
      for (let i = 0; i < frames; i++) {
        if (render) this.engine.stepFixed(dt);
        else this.simulateOnly(dt);
      }
      this.paused = wasPaused;
    },

    /** Render exactly n frames, advancing time by dt each. */
    renderFrames: (n = 1, dt = 1 / 60): void => {
      const wasPaused = this.paused;
      this.paused = false;
      for (let i = 0; i < n; i++) this.engine.stepFixed(dt);
      this.paused = wasPaused;
    },

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

    /**
     * Frame the player's boat from a spherical offset in its own frame, so a
     * shot stays composed no matter where on the course the boat has got to.
     * yaw is relative to the boat's heading.
     */
    frameBoat: (
      index: number,
      yaw: number,
      pitch: number,
      distance: number,
      lookHeight = 1.0,
    ): void => {
      const r = this.racers[index];
      if (!r) return;
      const s = r.physics;
      const heading = Math.atan2(s.forward.x, s.forward.z) + yaw;
      const cp = Math.cos(pitch);
      const eye = new Vector3(
        s.position.x + Math.sin(heading) * distance * cp,
        s.position.y + Math.sin(pitch) * distance + lookHeight,
        s.position.z + Math.cos(heading) * distance * cp,
      );
      this.rig.setFree(eye, new Vector3(s.position.x, s.position.y + lookHeight, s.position.z));
    },

    setOrbit: (angle: number, radius: number, height: number): void => {
      this.rig.mode = 'orbit';
      this.rig.orbitAngle = angle;
      this.rig.orbitRadius = radius;
      this.rig.orbitHeight = height;
      this.rig.orbitSpeed = 0;
      if (this.player) this.rig.orbitCenter.copy(this.player.physics.position);
    },

    setInput: (state: Record<string, unknown> | null): void => {
      this.input.scripted = state as never;
    },

    setQuality: (tier: QualityTier): void => {
      this.engine.setTier(tier);
    },

    /** 0 = beauty, 1 = packed view normals, 2 = linear depth. */
    setDebugView: (mode: number): void => {
      this.engine.pipeline.setDebugView(mode);
    },

    setPassUniform: (pass: string, name: string, value: number): void => {
      this.engine.pipeline.setPassUniform(pass, name, value);
    },

    /** Teleport the player onto the spline, for shots of a specific corner. */
    placeOnCourse: (t: number): void => {
      const p = this.player;
      if (!p || !this.course) return;
      const point = this.course.sample(Course.wrap(t), this.engine.elapsed);
      const heading = Math.atan2(point.tangent.x, point.tangent.z);
      p.physics.respawn(point.position.clone(), heading, this.engine.elapsed);
      this.lastPlayerT = t;
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
      speed: this.player?.physics.speed ?? 0,
      airborne: this.player?.physics.airborne ?? false,
      courseT: this.lastPlayerT,
    }),
  };
}
