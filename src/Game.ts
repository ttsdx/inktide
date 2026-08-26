import { Color, Frustum, Group, Matrix4, Object3D, Sphere, Vector3 } from 'three';
import { PALETTE } from './core/Palette.ts';
import { Engine, type QualityTier } from './core/Engine.ts';
import { Input } from './core/Input.ts';
import { CameraRig, type CameraMode, type ChaseTarget } from './core/CameraRig.ts';
import { Effects } from './core/Effects.ts';
import { Sky } from './world/Sky.ts';
import { Ocean, type HullContact } from './world/Ocean.ts';
import { WakeField, type WakeEmitter } from './world/WakeField.ts';
import { oceanHeight, sampleOcean } from './world/gerstner.ts';
import { LAYER_OPAQUE, LAYER_OVERLAY, LAYER_SKY } from './render/layers.ts';
import { ProbeScene } from './dev/ProbeScene.ts';
import { RIG_STATIONS, WaterlineRig, stationPosition } from './dev/WaterlineRig.ts';
import { Course } from './race/Course.ts';
import { RacingLine } from './race/RacingLine.ts';
import { RaceDirector, type RaceEvent } from './race/RaceDirector.ts';
import { AIController, AI_PRESETS } from './race/AIController.ts';
import { GateField } from './entities/Gate.ts';
import { BuoyField } from './entities/Buoy.ts';
import { Boat } from './entities/Boat.ts';
import { Spray } from './world/Spray.ts';
import { BoatPhysics } from './entities/BoatPhysics.ts';
import { BOAT_SPECS, HULL_BEAM, RIDER_MOUNT } from './entities/hullSpec.ts';
import { Rider } from './entities/Rider.ts';
import { Hud, type HudCorner, type HudCourse, type HudData, type HudRogue } from './ui/Hud.ts';
import { Screens, type ScreenResultRow, type ScreensData } from './ui/Screens.ts';
import { AudioEngine } from './audio/AudioEngine.ts';
import type { BoatCommand, BoatState, GameMode, RiderPose } from './contracts.ts';
import {
  ROGUE_CATALOG,
  ROGUE_ORIGIN_X,
  ROGUE_ORIGIN_Z,
  ROGUE_RUN_NAME,
  RogueDirector,
  timeFormulaLabel,
} from './rogue/RogueDirector.ts';
import { RogueField } from './rogue/RogueField.ts';

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
  boat: Boat;
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
  spray: Spray | null = null;

  course: Course | null = null;
  racingLine: RacingLine | null = null;
  gates: GateField | null = null;
  buoys: BuoyField | null = null;
  director: RaceDirector | null = null;
  rogue: RogueDirector | null = null;
  rogueField: RogueField | null = null;

  hud: Hud | null = null;
  screens: Screens | null = null;
  readonly audio = new AudioEngine();

  readonly racers: Racer[] = [];
  /** Scene root for everything race-related, so it can be rebuilt on restart. */
  private readonly raceRoot = new Group();

  /** Player-facing session. Title is the default human boot. */
  private session: 'title' | GameMode = 'title';
  private titleIndex = 0;
  private shopHighlight = 0;
  private skipTitle = false;

  private started = false;
  private paused = false;
  /** Diagnostic latch; see `harness.setLayerVisible`. */
  private wakeEnabled = true;
  private probe: ProbeScene | null = null;
  private waterline: WaterlineRig | null = null;
  private showPerf = false;

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
    this.showPerf = url.searchParams.get('perf') === '1';

    this.engine = new Engine({
      canvas,
      tier: tier ?? 'high',
      adaptive,
      maxPixelRatio: 2,
      preserveDrawingBuffer: url.searchParams.get('harness') === '1',
      nativeResStart: url.searchParams.has('quality') || url.searchParams.get('harness') === '1',
    });
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

    // Distant water recedes into pale cyan, not into the sky's warm sand.
    // Hazing the ocean towards `skyHorizon` is defensible in isolation — it is
    // what the sky does at the same altitude — but the ocean occupies far more
    // of the frame, so in practice it painted a wide desert strip above the
    // waterline in every single shot. The sky keeps its warm horizon band; the
    // water no longer borrows it.
    (this.ocean.material.uniforms.uHorizon.value as Color).copy(PALETTE.waterHaze);

    this.effects.flashSink = (c, s) => this.engine.pipeline.flash(c, s);
    this.effects.shakeSink = (a, f) => this.rig.shake(a, f);

    // --- world -------------------------------------------------------------
    this.wake = new WakeField(this.engine.renderer, { resolution: 1024, halfExtent: 260 });

    this.spray = new Spray();
    this.spray.root.layers.set(LAYER_OVERLAY);
    scene.add(this.spray.root);
    this.effects.spraySink = (req) => this.spray?.emit(req);
    // Droplets that land stamp foam into the wake field, so a hard landing
    // leaves a mark on the water rather than vanishing mid-air.
    this.spray.setImpactSink((x, z, radius, strength) => this.wake?.splash(x, z, radius, strength));

    this.course = new Course();
    // Narrower than the module's default 1.8 m half-width. At the default, and
    // with the additive halo spilling 2.6x wider still, the line covered most
    // of the lower half of the frame from the chase camera — a navigation aid
    // reading as a green carpet laid over the water rather than a marker on it.
    this.racingLine = new RacingLine(this.course, { halfWidth: 1.05 });
    this.racingLine.glowMaterial.uniforms.uWidthScale.value = 1.5;
    this.racingLine.mesh.traverse((o) => o.layers.set(LAYER_OVERLAY));
    this.raceRoot.add(this.racingLine.mesh);

    this.gates = new GateField(this.course);
    this.raceRoot.add(this.gates.root);

    this.buoys = new BuoyField(this.course);
    this.buoys.root.traverse((o) => o.layers.set(LAYER_OPAQUE));
    this.raceRoot.add(this.buoys.root);

    this.rogue = new RogueDirector();
    this.rogue.onEvent = this.onRogueEvent;
    this.rogueField = new RogueField();
    this.rogueField.root.traverse((o) => {
      if (o.layers.mask === 0) o.layers.set(LAYER_OPAQUE);
    });
    this.raceRoot.add(this.rogueField.root);

    // --- racers ------------------------------------------------------------
    this.buildRacers();

    this.director = new RaceDirector(this.course, this.racers.length);
    this.director.onEvent = this.onRaceEvent;

    // --- UI and audio --------------------------------------------------------
    this.hud = new Hud(this.hudRoot);
    this.screens = new Screens(this.hudRoot);
    this.screens.onStart = () => this.enterCircuit();
    this.screens.onStartCircuit = () => this.enterCircuit();
    this.screens.onStartRogue = () => this.enterRogue();
    this.screens.onResume = () => {
      this.userPaused = false;
      this.audio.setMasterGain(0.85);
    };
    this.screens.onRestart = () => this.restart();
    this.screens.onQuitToTitle = () => this.quitToTitle();
    this.screens.onBuyUpgrade = (id) => this.buyUpgrade(id);
    this.screens.onContinueRun = () => this.continueRogue();
    this.screens.onTitleIndex = (i) => {
      this.titleIndex = i;
    };
    this.screens.onShopHighlight = (i) => {
      this.shopHighlight = i;
    };

    this.hudCourse = this.buildHudCourse();

    // Browsers block audio until a gesture, so the context is only resumed on
    // the first real interaction. Everything is a safe no-op before then.
    const unlock = () => {
      void this.audio.resume();
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);

    this.skipTitle =
      url.searchParams.get('harness') === '1' || url.searchParams.get('skipTitle') === '1';
    const modeParam = url.searchParams.get('mode');
    const seedParam = url.searchParams.get('seed');
    const pinnedSeed = seedParam ? Number.parseInt(seedParam, 10) : undefined;

    if (this.skipTitle) {
      if (modeParam === 'rogue') this.enterRogue(pinnedSeed);
      else this.enterCircuit();
    } else {
      this.sitOnTitle();
    }

    if (url.searchParams.get('probe') === '1') {
      this.probe = new ProbeScene();
      scene.add(this.probe.root);
    }

    if (url.searchParams.get('waterline') === '1') {
      this.waterline = new WaterlineRig();
      scene.add(this.waterline.root);
    }

    this.rig.mode = this.session === 'title' ? 'flyby' : 'chase';
    if (this.player) this.snapCameraToPlayer();

    this.engine.onUpdate(this.update);
    this.engine.onQualityChange = (tier, scale) => this.applyQuality(tier, scale);
    this.applyQuality(this.engine.adaptive.tier, this.engine.adaptive.scale);

    // One warm-up frame so every shader is compiled before the first visible
    // frame — otherwise the first second of play is a compile stutter.
    this.engine.stepFixed(1 / 60);
  }

  /**
   * Push the current quality tier into every system that has its own cost.
   * The pipeline is already handled by Engine; this is ocean density, wake
   * resolution, spray count, and how far a rider is allowed to stay visible.
   */
  private applyQuality(tier: QualityTier, _scale = 1): void {
    this.ocean.setQuality(tier);
    this.ocean.setLodPx(this.engine.pixelRatio);
    this.wake?.setQuality(tier);
    this.spray?.setQuality(tier);
    this.racingLine?.setQuality(tier);
    this.sky.setQuality(tier);
    this.hud?.setQuality(tier);
    this.riderLodDist = tier === 'low' ? 28 : tier === 'medium' ? 52 : tier === 'high' ? 60 : 120;
    if (this.racingLine) this.racingLine.glow.visible = tier === 'ultra';
  }

  private buildRacers(): void {
    const course = this.course;
    if (!course) return;

    for (let i = 0; i < BOAT_SPECS.length; i++) {
      const slot = course.startGrid[i % course.startGrid.length];
      const physics = new BoatPhysics(i, BOAT_SPECS[i], slot.position.clone(), slot.heading);
      physics.respawn(slot.position.clone(), slot.heading, 0);

      const boat = new Boat(BOAT_SPECS[i]);
      boat.root.traverse((o) => o.layers.set(LAYER_OPAQUE));
      this.raceRoot.add(boat.root);

      // The rider hangs off the hull's own cockpit mount, so it inherits the
      // boat's pitch and roll for free and the hand IK targets stay welded to
      // the handlebars without any per-frame sync.
      const rider = new Rider(BOAT_SPECS[i].colorIndex);
      rider.root.traverse((o) => o.layers.set(LAYER_OPAQUE));
      boat.riderMount.add(rider.root);

      // Personalities are assigned in a fixed order so a race is reproducible
      // for the screenshot harness; the PRNG inside each controller is seeded
      // from the boat id for the same reason.
      const ai = i === 0 ? null : new AIController(i, course, AI_PRESETS[i % AI_PRESETS.length]);

      this.racers.push({
        physics,
        boat,
        rider,
        mount: boat.root,
        pose: Rider.restPose(),
        command: { throttle: 0, brake: 0, steer: 0, drift: false },
        ai,
        celebrate: 0,
      });
    }
  }

  /**
   * Race events are the one place gameplay, UI and audio meet. Routing them
   * through a single handler keeps the director ignorant of both.
   */
  private readonly onRaceEvent = (e: RaceEvent): void => {
    switch (e.type) {
      case 'countdown':
        if (e.value === 0) {
          this.effects.flash(new Color(0x39ff9c), 0.18);
          this.audio.play('countdownGo');
          this.audio.play('startHorn', 0.9);
        } else {
          this.audio.play('countdownBeep');
        }
        break;
      case 'gate':
        this.gates?.flashPassed(e.checkpoint);
        if (e.boatId === 0) this.audio.play('gatePass', 0.5);
        break;
      case 'lap':
        if (e.boatId === 0) {
          this.effects.flash(new Color(0x8ff4ff), 0.12);
          this.audio.play('lapComplete');
        }
        break;
      case 'wrongWay':
        if (e.boatId === 0 && e.active) this.audio.play('wrongWay', 0.7);
        break;
      case 'finish':
        if (e.boatId === 0) {
          this.effects.flash(new Color(0xffffff), 0.28);
          this.audio.play('finish');
          this.rig.mode = 'results';
        }
        break;
      default:
        break;
    }
  };

  /** Leave the title card and run the countdown. */
  beginRace(): void {
    this.enterCircuit();
  }

  /** Reset every racer to the grid and restart the countdown. Circuit only. */
  restart(): void {
    if (this.session === 'rogue') {
      if (this.rogue?.phase === 'runResults') {
        this.enterRogue();
        return;
      }
      this.restartRogueStage();
      return;
    }
    const course = this.course;
    if (!course) return;
    const t = this.simTime;
    this.restoreCircuitPack();
    for (let i = 0; i < this.racers.length; i++) {
      const r = this.racers[i];
      const slot = course.startGrid[i % course.startGrid.length];
      r.physics.spec = { ...BOAT_SPECS[i] };
      r.physics.respawn(slot.position.clone(), slot.heading, t);
      r.ai?.reset();
      r.celebrate = 0;
      r.pose = Rider.restPose();
    }
    this.director?.reset();
    this.director?.start();
    this.userPaused = false;
    this.audio.setMasterGain(0.85);
    this.rig.mode = 'chase';
    this.lastPlayerT = 0;
    this.snapCameraToPlayer();
    this.audio.play('uiConfirm');
  }

  private sitOnTitle(): void {
    this.session = 'title';
    this.userPaused = false;
    this.audio.setMasterGain(0.85);
    this.showCircuitWorld(true);
    this.rogueField?.hide();
    if (this.rogue) this.rogue.phase = 'idle';
    this.director?.reset();
    this.restoreCircuitPack();
    const course = this.course;
    const t = this.simTime;
    if (course) {
      for (let i = 0; i < this.racers.length; i++) {
        const r = this.racers[i];
        const slot = course.startGrid[i % course.startGrid.length];
        r.physics.spec = { ...BOAT_SPECS[i] };
        r.physics.respawn(slot.position.clone(), slot.heading, t);
        r.ai?.reset();
        r.celebrate = 0;
      }
    }
    this.rig.mode = 'flyby';
    this.rig.orbitSpeed = 0.18;
    if (this.player) {
      this.rig.orbitCenter.copy(this.player.physics.position);
      this.snapCameraToPlayer();
    }
  }

  private enterCircuit(): void {
    void this.audio.resume();
    this.session = 'circuit';
    this.userPaused = false;
    this.audio.setMasterGain(0.85);
    this.showCircuitWorld(true);
    this.rogueField?.hide();
    this.restoreCircuitPack();
    const course = this.course;
    const t = this.simTime;
    if (course) {
      for (let i = 0; i < this.racers.length; i++) {
        const r = this.racers[i];
        const slot = course.startGrid[i % course.startGrid.length];
        r.physics.spec = { ...BOAT_SPECS[i] };
        r.physics.respawn(slot.position.clone(), slot.heading, t);
        r.ai?.reset();
        r.celebrate = 0;
      }
    }
    this.director?.reset();
    this.director?.start();
    this.rig.mode = 'chase';
    this.lastPlayerT = 0;
    this.snapCameraToPlayer();
    this.audio.play('uiConfirm');
  }

  private enterRogue(seed?: number): void {
    void this.audio.resume();
    const director = this.rogue;
    const field = this.rogueField;
    const player = this.player;
    if (!director || !field || !player) return;
    this.session = 'rogue';
    this.userPaused = false;
    this.shopHighlight = 0;
    this.audio.setMasterGain(0.85);
    this.showCircuitWorld(false);
    this.hideAiPack();
    const runSeed = Number.isFinite(seed) && (seed as number) > 0 ? (seed as number) : this.freshSeed();
    director.startRun(runSeed >>> 0);
    player.physics.spec = director.spec;
    this.spawnRoguePlayer();
    field.buildStage(
      director.seed,
      director.stage,
      ROGUE_ORIGIN_X,
      ROGUE_ORIGIN_Z,
      director.target,
      director.corridorHalf,
    );
    this.rig.mode = 'chase';
    this.snapCameraToPlayer();
    this.audio.play('uiConfirm');
  }

  private restartRogueStage(): void {
    const director = this.rogue;
    const field = this.rogueField;
    if (!director || !field || this.session !== 'rogue') return;
    this.userPaused = false;
    this.audio.setMasterGain(0.85);
    director.restartStage();
    this.player!.physics.spec = director.spec;
    this.spawnRoguePlayer();
    field.buildStage(
      director.seed,
      director.stage,
      ROGUE_ORIGIN_X,
      ROGUE_ORIGIN_Z,
      director.target,
      director.corridorHalf,
    );
    this.rig.mode = 'chase';
    this.snapCameraToPlayer();
    this.audio.play('uiConfirm');
  }

  private continueRogue(): void {
    const director = this.rogue;
    const field = this.rogueField;
    if (!director || !field) return;
    director.continueRun();
    this.shopHighlight = 0;
    this.player!.physics.spec = director.spec;
    this.spawnRoguePlayer();
    field.buildStage(
      director.seed,
      director.stage,
      ROGUE_ORIGIN_X,
      ROGUE_ORIGIN_Z,
      director.target,
      director.corridorHalf,
    );
    this.userPaused = false;
    this.rig.mode = 'chase';
    this.snapCameraToPlayer();
    this.audio.play('uiConfirm');
  }

  private buyUpgrade(id: string): void {
    const director = this.rogue;
    if (!director) return;
    if (director.buy(id)) {
      this.audio.play('uiConfirm');
      if (this.player) this.player.physics.spec = director.spec;
    } else {
      this.audio.play('uiMove');
    }
  }

  private quitToTitle(): void {
    this.sitOnTitle();
    this.audio.play('uiConfirm');
  }

  private spawnRoguePlayer(): void {
    const p = this.player;
    if (!p) return;
    p.physics.respawn(new Vector3(ROGUE_ORIGIN_X, 0, ROGUE_ORIGIN_Z + 6), 0, this.simTime);
    p.celebrate = 0;
    p.pose = Rider.restPose();
  }

  private showCircuitWorld(on: boolean): void {
    if (this.racingLine) this.racingLine.mesh.visible = on;
    if (this.gates) this.gates.root.visible = on;
    if (this.buoys) this.buoys.root.visible = on;
  }

  private hideAiPack(): void {
    for (let i = 1; i < this.racers.length; i++) {
      this.racers[i].boat.root.visible = false;
      this.racers[i].rider.root.visible = false;
    }
  }

  private restoreCircuitPack(): void {
    for (const r of this.racers) {
      r.boat.root.visible = true;
      r.rider.root.visible = true;
    }
  }

  private freshSeed(): number {
    return (Math.imul(Date.now() ^ (this.engine.frame * 2654435761), 1597334677) >>> 0) || 1;
  }

  private readonly onRogueEvent = (e: { type: string; kind?: string }): void => {
    switch (e.type) {
      case 'stageClear':
        this.effects.flash(new Color(0x39ff9c), 0.2);
        this.audio.play('lapComplete');
        this.rig.mode = 'orbit';
        if (this.player) this.rig.orbitCenter.copy(this.player.physics.position);
        break;
      case 'runComplete':
        this.effects.flash(new Color(0xffffff), 0.28);
        this.audio.play('finish');
        this.rig.mode = 'results';
        if (this.player) this.rig.orbitCenter.copy(this.player.physics.position);
        break;
      case 'pickup':
        this.audio.play(e.kind === 'boost' ? 'boostCharged' : 'pickup', 0.7);
        this.effects.flash(e.kind === 'boost' ? new Color(0x39ff9c) : new Color(0xc4f52e), 0.08);
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

  /**
   * Simulation clock, separate from the engine's wall clock.
   *
   * Everything that describes the state of the world — the wave field, boat
   * physics, race timing — reads this instead of `engine.elapsed`, so a pause
   * genuinely stops the world. Sharing one clock would leave the ocean rolling
   * under frozen boats, which then sink or fly the moment play resumes.
   */
  private simTime = 0;

  private update = (dt: number, wallClock: number): void => {
    if (this.paused) return;
    const control = this.input.update(dt);

    if (this.screens?.visible) {
      const moved = this.screens.handleMenu(control.menuDelta, control.confirmPressed);
      if (moved && control.menuDelta !== 0) this.audio.play('uiMove');
    }

    const canPause =
      (this.session === 'circuit' && this.director?.phase === 'racing') ||
      (this.session === 'rogue' && this.rogue?.phase === 'racing');
    if (control.pausePressed && canPause) {
      this.userPaused = !this.userPaused;
      this.audio.play('uiMove');
      this.audio.setMasterGain(this.userPaused ? 0.15 : 0.85);
    }

    const uiCtx = { dt, elapsed: wallClock, frame: this.engine.frame };
    const shopFrozen = this.session === 'rogue' && this.rogue?.phase === 'upgrade';
    if (this.userPaused || shopFrozen) {
      this.updateUi(uiCtx);
      return;
    }

    this.simTime += dt;
    const elapsed = this.simTime;
    this.effects.tick(elapsed);

    const ctx = { dt, elapsed, frame: this.engine.frame };

    // --- drive ---------------------------------------------------------------
    const director = this.director;
    const phase = director?.phase ?? 'racing';
    const circuitLive = this.session === 'circuit';
    const rogueLive = this.session === 'rogue' && this.rogue?.phase === 'racing';
    const launched =
      circuitLive && (phase === 'racing' || phase === 'finished' || phase === 'results');
    const rogueGo = rogueLive;

    this.states.length = 0;
    for (const r of this.racers) this.states.push(r.physics);

    const driveCount = this.session === 'rogue' ? 1 : this.racers.length;
    for (let i = 0; i < driveCount; i++) {
      const r = this.racers[i];
      if (i === 0 && !this.autopilot) {
        const go = launched || rogueGo;
        r.command.throttle = go ? control.throttle : 0;
        r.command.brake = go ? control.brake : 0;
        r.command.steer = this.session === 'title' ? 0 : control.steer;
        r.command.drift = go && control.drift;
      } else if (i === 0 && this.autopilot && this.playerAI && director && circuitLive) {
        const prog = director.get(0);
        if (prog) {
          const cmd = this.playerAI.update(r.physics, this.states, prog, prog, ctx);
          r.command.throttle = launched ? cmd.throttle : 0;
          r.command.brake = launched ? cmd.brake : 0;
          r.command.steer = cmd.steer;
          r.command.drift = launched && cmd.drift;
        }
      } else if (r.ai && director && circuitLive) {
        const prog = director.get(i);
        const playerProg = director.get(0);
        if (prog && playerProg) {
          const cmd = r.ai.update(r.physics, this.states, prog, playerProg, ctx);
          r.command.throttle = launched ? cmd.throttle : 0;
          r.command.brake = launched ? cmd.brake : 0;
          r.command.steer = cmd.steer;
          r.command.drift = launched && cmd.drift;
        }
      } else {
        r.command.throttle = 0;
        r.command.brake = 0;
        r.command.steer = 0;
        r.command.drift = false;
      }
      r.physics.update(r.command, ctx, i === 0 ? this.effects : null);
    }

    if (circuitLive) {
      for (let a = 0; a < this.racers.length; a++) {
        for (let b = a + 1; b < this.racers.length; b++) {
          this.racers[a].physics.resolveBoatCollision(this.racers[b].physics);
        }
      }
      director?.update(this.states, ctx);
    } else if (this.session === 'title') {
      director?.update(this.states, ctx);
    } else if (rogueLive) {
      this.tickRogue(dt, ctx);
    }

    this.cullRacers();

    // --- visuals -------------------------------------------------------------
    this.emitters.length = 0;
    this.contacts.length = 0;

    for (let i = 0; i < this.racers.length; i++) {
      if (this.session === 'rogue' && i > 0) continue;
      const r = this.racers[i];
      const s = r.physics;

      r.boat.applyState(s, dt, r.boat.root.visible);

      // Celebration ramps in over a second once a racer is done, so the pose
      // change reads as a reaction rather than a state flip.
      const finished = director?.get(i)?.finished ?? false;
      const target = finished ? 1 : 0;
      r.celebrate += (target - r.celebrate) * Math.min(1, 1.6 * dt);

      // Off-screen and far-LOD riders skip the IK solve. The pose is derived
      // from boat state in one pass; the expensive work is the layered spring
      // + arm IK writing 21 bones. Physics, wake, and the minimap do not
      // read any of it.
      if (r.rider.root.visible) {
        r.pose = Rider.poseFromBoat(s, r.pose, dt, r.celebrate);
        r.rider.update(r.pose, ctx);
        r.boat.setBarYaw(r.rider.barYaw);
      }

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

      // The radius is the hull's own half-beam plus a little, because the
      // ocean's contact term now draws its collar at exactly one radius rather
      // than filling the ellipse; if this does not match the boat, the foam
      // detaches from it. The strength floor is well clear of the foam
      // threshold so a boat at rest still has a waterline — at the old 0.35 the
      // breakup noise took an idle hull's collar below the tear threshold and
      // it had none at all.
      this.contacts.push({
        position: s.position,
        radius: 1.9,
        strength: Math.min(1, 0.62 + s.speed / 34),
        forwardX: s.forward.x,
        forwardZ: s.forward.z,
      });
    }

    // --- camera --------------------------------------------------------------
    // The cinematic orbit has to be told what to orbit. Left at its default it
    // circles the world origin, which is a kilometre from wherever the race
    // actually finished, so the results screen played over empty water.
    if (this.rig.mode === 'results' || this.rig.mode === 'orbit' || this.rig.mode === 'flyby') {
      const winner = this.session === 'circuit' ? director?.standings()[0] : undefined;
      const focusBoat =
        winner && this.racers[winner.boatId] ? this.racers[winner.boatId] : this.player;
      if (focusBoat) {
        this.rig.orbitCenter.lerp(focusBoat.physics.position, Math.min(1, 3 * dt));
        this.rig.orbitCenter.y = focusBoat.physics.position.y + 1.2;
      }
    }

    this.syncChaseTarget();
    if (control.cameraPressed && this.session !== 'title') this.cycleCamera();
    this.rig.update(dt, this.chase, elapsed);
    this.keepCameraAboveWater(elapsed);

    // --- world ---------------------------------------------------------------
    const cam = this.engine.camera;
    const focus = this.player?.physics.position ?? cam.position;

    if (this.wake) {
      this.wake.follow(focus.x, focus.z);
      this.wake.submit(this.emitters);
      this.wake.update(ctx);
      this.ocean.setWakeField(
        this.wakeEnabled ? this.wake.texture : null,
        this.wake.centerX,
        this.wake.centerZ,
        this.wake.extent,
      );
    }

    this.ocean.setContacts(this.contacts);
    this.ocean.setLodPx(this.engine.pixelRatio);
    this.spray?.update(ctx);
    this.probe?.update(elapsed);
    this.waterline?.update(elapsed);
    this.sky.update(cam, elapsed);
    this.ocean.update(cam, elapsed);

    // Floating props are placed on the surface as the ocean shader draws it at
    // their distance from the camera, not on the undamped field, so they have
    // to be updated after the ocean has settled its fade band for this frame.
    const fade = this.ocean.detailFade;

    if (this.session !== 'rogue') {
      if (this.gates) {
        const next = director?.get(0)?.nextCheckpoint;
        if (next !== undefined) this.gates.setActiveIndex(next);
        this.gates.update(ctx, cam.position, fade.start, fade.end);
      }
      if (this.buoys) {
        this.buoys.setFocus(focus);
        this.buoys.setViewer(cam.position, fade.start, fade.end);
        this.buoys.update(ctx);
      }

      if (this.racingLine && this.course && this.player) {
        this.racingLine.update(elapsed, cam.position);
        const t = this.course.closestT(this.player.physics.position, this.lastPlayerT);
        this.lastPlayerT = t;
        this.updateCornerPreview(t);
      }
    } else if (this.rogueField) {
      this.rogueField.setViewer(cam.position, fade.start, fade.end);
      const camObj = this.engine.camera;
      this.rogueField.setOutlineViewport(
        this.engine.renderer.domElement.height,
        camObj.projectionMatrix.elements[5],
        camObj.far,
      );
      this.rogueField.update(ctx);
    }

    if (control.resetPressed) this.respawnPlayer(elapsed);

    this.updateAudio(dt);
    this.updateUi(uiCtx);
  };

  private tickRogue(dt: number, ctx: { dt: number; elapsed: number; frame: number }): void {
    const director = this.rogue;
    const field = this.rogueField;
    const player = this.player;
    if (!director || !field || !player) return;

    const px = player.physics.position.x;
    const pz = player.physics.position.z;
    const half = director.corridorHalf;
    const over = Math.abs(px - ROGUE_ORIGIN_X) - half;
    if (over > 0) {
      const sign = Math.sign(px - ROGUE_ORIGIN_X) || 1;
      player.physics.applyPlanarAccel(-sign * (8 + over * 4.2), 0, dt);
      const damp = Math.exp(-dt * (0.9 + over * 0.12));
      player.physics.velocity.x *= damp;
      player.physics.velocity.z *= Math.exp(-dt * (0.18 + over * 0.05));
    }

    const hits = field.queryHazards(px, pz, 3.4);
    for (const h of hits) {
      const impact = player.physics.resolveStaticCollision(h.x, h.z, h.radius);
      if (impact > 2.2) {
        this.audio.play('hazardHit', Math.min(1, impact / 10));
        this.effects.shake(0.22 + Math.min(0.35, impact * 0.04), 28);
        this.effects.spray({
          position: player.physics.position.clone(),
          velocity: player.physics.velocity.clone().multiplyScalar(0.15),
          count: 10,
          spread: 1.1,
          size: 0.12,
          life: 0.45,
        });
      }
    }

    const magnet = player.physics.spec.magnetRadius ?? 0;
    const pickups = field.collectPickups(px, pz, magnet);
    for (const kind of pickups) {
      if (kind === 'orb') director.collectOrb();
      else {
        director.collectBoost();
        player.physics.grantBoost(1.55);
      }
    }

    director.update(pz, ctx);
  }

  private readonly frustum = new Frustum();
  private readonly frustumMatrix = new Matrix4();
  private readonly racerSphere = new Sphere(new Vector3(), 5.2);

  /**
   * Cull whole racers, not their parts.
   *
   * `Boat` and `Rider` both set `frustumCulled = false` on every mesh they own,
   * and that is correct for them: a rig moves parts far outside the local
   * bounding sphere three.js would test, so per-part culling makes limbs
   * disappear. The consequence, though, was that all four boats and riders —
   * 252 meshes — were drawn every frame regardless of where the camera pointed,
   * and a probe measured only 78 of 415 scene meshes ever being culled.
   *
   * Testing one sphere per racer and toggling the group's visibility gets the
   * culling back without reintroducing the popping, at a cost of four sphere
   * tests. The sphere is generous (5.2 m against a 5.4 m hull) so a boat is
   * never hidden while any part of it is still on screen.
   *
   * Visibility is a rendering concern only: physics, wake emission, hull
   * contacts, race progress and the minimap all read the simulation directly,
   * so an off-screen boat still races.
   */
  private cullRacers(): void {
    const cam = this.engine.camera;
    cam.updateMatrixWorld();
    this.frustumMatrix.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.frustumMatrix);
    const lodSq = this.riderLodDist * this.riderLodDist;
    const inkSq = (this.riderLodDist * 0.45) * (this.riderLodDist * 0.45);
    const eye = cam.position;
    for (let i = 0; i < this.racers.length; i++) {
      const r = this.racers[i];
      if (this.session === 'rogue' && i > 0) {
        r.boat.root.visible = false;
        r.rider.root.visible = false;
        continue;
      }
      this.racerSphere.center.copy(r.physics.position);
      const inView = this.frustum.intersectsSphere(this.racerSphere);
      r.boat.root.visible = inView;
      const distSq = eye.distanceToSquared(r.physics.position);
      const riderOn = inView && (i === 0 || distSq < lodSq);
      r.rider.root.visible = riderOn;
      r.boat.setInkVisible(inView && (i === 0 || distSq < inkSq));
      r.boat.setDetailVisible(riderOn);
    }
  }

  private lastPlayerT = 0;
  private userPaused = false;
  /** Harness only: hand the player's boat to an AI so a shot can reach the flag. */
  private autopilot = false;
  private playerAI: AIController | null = null;
  /** Hide AI riders beyond this distance. Player stays fully detailed. */
  private riderLodDist = 80;
  private hudCourse: HudCourse | null = null;
  private readonly curvatureAhead = new Float32Array(24);
  private readonly hudData: HudData = { phase: 'intro', player: null, rogue: null };
  private readonly screensData: ScreensData = { phase: 'intro' };
  private readonly corner: HudCorner = { severity: 0, direction: 0 };

  /**
   * Sample the spline once at startup for the minimap. The HUD is deliberately
   * given plain points rather than the curve, so the UI layer never has to know
   * what a CatmullRomCurve3 is.
   */
  private buildHudCourse(): HudCourse | null {
    const course = this.course;
    if (!course) return null;
    const points: Array<{ x: number; z: number }> = [];
    const N = 180;
    for (let i = 0; i < N; i++) {
      const p = course.sample(i / N);
      points.push({ x: p.position.x, z: p.position.z });
    }
    const gates = course.checkpoints.map((c) => ({
      x: c.position.x,
      z: c.position.z,
      // The gate axis is perpendicular to the direction of travel.
      nx: -c.tangent.z,
      nz: c.tangent.x,
    }));
    return { points, gates, startLine: gates[course.startFinishIndex] };
  }

  private updateAudio(dt: number): void {
    const p = this.player;
    if (!p) return;
    const s = p.physics;
    const top = Math.max(s.spec.topSpeed, 1);
    const speed01 = Math.min(1, s.speed / top);
    // RPM is not speed. A jet drive spun up against no load still screams, so
    // revs follow throttle with speed only setting the floor — which is what
    // makes accelerating out of a corner sound like work rather than a siren.
    const rpm01 = Math.min(1, speed01 * 0.65 + s.throttleLevel * 0.45);
    const load01 = Math.min(1, s.throttleLevel * (1 - speed01 * 0.45) + (s.boostTime > 0 ? 0.3 : 0));
    this.audio.setEngine(rpm01, load01, speed01, s.airborne);

    if (s.landingImpact > 1.5) {
      this.audio.play(s.landingImpact > 6 ? 'impactHard' : 'impactSoft', Math.min(1, s.landingImpact / 9));
      this.audio.play('splash', Math.min(1, s.landingImpact / 11));
    }
    if (s.collisionImpact > 1.5) {
      this.audio.play('impactSoft', Math.min(1, s.collisionImpact / 8));
    }
    // Boost fires on the rising edge of boostTime.
    if (s.boostTime > 0 && this.prevBoostTime <= 0) this.audio.play('boostFire');
    if (s.boostCharge >= 1 && this.prevBoostCharge < 1) this.audio.play('boostCharged', 0.6);
    this.prevBoostTime = s.boostTime;
    this.prevBoostCharge = s.boostCharge;
  }

  private prevBoostTime = 0;
  private prevBoostCharge = 0;

  private updateUi(ctx: { dt: number; elapsed: number; frame: number }): void {
    const director = this.director;
    const p = this.player;
    if (!this.hud || !this.screens) return;

    const circuit = this.session === 'circuit';
    const rogue = this.session === 'rogue' ? this.rogue : null;
    const rogueRacing = rogue?.phase === 'racing';
    const phase =
      this.session === 'title'
        ? 'intro'
        : circuit
          ? (director?.phase ?? 'intro')
          : rogueRacing
            ? 'racing'
            : 'intro';
    const playerProgress = circuit ? director?.get(0) : null;

    this.states.length = 0;
    if (this.session === 'rogue') {
      if (p) this.states.push(p.physics);
    } else {
      for (const r of this.racers) this.states.push(r.physics);
    }

    const d = this.hudData;
    d.phase = phase;
    d.player = p ? p.physics : null;
    d.boats = this.states;
    d.progress = circuit ? director?.progress : undefined;
    d.playerProgress = playerProgress;
    d.totalLaps = director?.laps;
    d.countdown = circuit ? director?.countdownValue : undefined;
    d.wrongWay = circuit ? (playerProgress?.wrongWay ?? false) : false;
    d.course = circuit ? this.hudCourse : null;
    d.corner = circuit ? this.cornerAhead() : null;
    d.paused = this.userPaused;
    d.rogue = rogueRacing && rogue ? this.toHudRogue(rogue) : null;
    d.perf = this.showPerf
      ? {
          fps: this.engine.fps,
          draws: this.engine.pipeline.stats.calls,
          tris: this.engine.pipeline.stats.triangles,
          tier: this.engine.adaptive.tier,
          pixelRatio: this.engine.pixelRatio,
        }
      : null;
    this.hud.update(d, ctx);

    const s = this.screensData;
    s.phase = phase;
    s.paused = this.userPaused;
    s.totalLaps = director?.laps;
    s.mode = this.session === 'title' ? undefined : this.session;
    s.titleIndex = this.titleIndex;
    s.shop = undefined;
    s.run = undefined;
    if (circuit && (phase === 'results' || phase === 'finished')) {
      s.results = this.buildResults();
      s.playerPosition = playerProgress?.finishPosition || undefined;
    } else {
      s.results = undefined;
      s.playerPosition = undefined;
    }
    if (rogue?.phase === 'upgrade') {
      const last = rogue.records[rogue.records.length - 1];
      s.shop = {
        stageCleared: rogue.stage + 1,
        points: rogue.runPoints,
        formula: timeFormulaLabel(),
        lastPoints: last?.points ?? 0,
        lastTime: last?.time ?? 0,
        lastPar: last?.par ?? 0,
        catalog: ROGUE_CATALOG.map((u) => ({
          id: u.id,
          name: u.name,
          blurb: u.blurb,
          cost: u.cost,
          owned: rogue.owned.has(u.id),
          affordable: rogue.runPoints >= u.cost && !rogue.owned.has(u.id),
        })),
        highlight: this.shopHighlight,
      };
    }
    if (rogue?.phase === 'runResults') {
      s.run = {
        name: ROGUE_RUN_NAME,
        verdict: rogue.verdict(),
        totalTime: rogue.records.reduce((a, r) => a + r.time, 0),
        leftover: rogue.runPoints,
        orbs: rogue.records.reduce((a, r) => a + r.orbs, 0),
        stages: rogue.records.map((r) => ({
          stage: r.stage,
          time: r.time,
          par: r.par,
          timePoints: r.timePoints,
          orbs: r.orbs,
          points: r.points,
        })),
        highlight: this.shopHighlight,
      };
    }
    this.screens.update(s, ctx);
  }

  private toHudRogue(rogue: RogueDirector): HudRogue {
    const snap = rogue.hud();
    return {
      stage: snap.stage,
      stageCount: snap.stageCount,
      remaining: snap.remaining,
      stageTime: snap.stageTime,
      pointsThisStage: snap.pointsThisStage,
      runPoints: snap.runPoints,
      par: snap.par,
    };
  }

  /**
   * Reduce the sampled curvature ahead to the one number the HUD wants: how
   * hard the next corner is, and which way it goes.
   */
  private cornerAhead(): HudCorner | null {
    const course = this.course;
    if (!course) return null;
    let peak = 0;
    let peakIdx = 0;
    for (let i = 2; i < this.curvatureAhead.length; i++) {
      if (this.curvatureAhead[i] > peak) {
        peak = this.curvatureAhead[i];
        peakIdx = i;
      }
    }
    // 0.0035 1/m is the "ease off" threshold, 0.0125 is a genuine hard corner.
    this.corner.severity = Math.min(1, Math.max(0, (peak - 0.0025) / 0.0110));
    // Direction from the sign of the turn: compare tangents either side.
    const line = this.racingLine;
    if (line) {
      const t0 = Course.wrap(this.lastPlayerT);
      const t1 = course.advance(t0, Math.max(20, peakIdx * line.previewSpacing));
      const a = course.sample(t0).tangent;
      const b = course.sample(t1).tangent;
      this.corner.direction = Math.sign(a.x * b.z - a.z * b.x) || 1;
    }
    return this.corner.severity > 0.02 ? this.corner : null;
  }

  private buildResults(): ScreenResultRow[] {
    const director = this.director;
    if (!director) return [];
    return director.standings().map((p) => ({
      name: BOAT_SPECS[p.boatId].name,
      colorIndex: BOAT_SPECS[p.boatId].colorIndex,
      position: p.finishPosition || p.position,
      totalTime: p.totalTime,
      bestLap: director.bestLap(p.boatId),
      isPlayer: p.boatId === 0,
      finished: p.finished,
    }));
  }

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
    if (!p) return;
    if (this.session === 'rogue') {
      const x = ROGUE_ORIGIN_X;
      const z = p.physics.position.z;
      p.physics.respawn(new Vector3(x, 0, z), 0, elapsed);
      this.snapCameraToPlayer();
      return;
    }
    const course = this.course;
    if (!course) return;
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
      const steps = Math.max(0, Math.round((seconds - this.simTime) / dt));
      this.harness.step(Math.min(steps, 60 * 600), dt);
    },

    /**
     * Switch camera mode and settle it immediately.
     *
     * The chase cam is a critically-damped spring, so simply setting the mode
     * leaves it flying in from wherever the previous shot parked it — a capture
     * three frames later shows the boat forty metres away instead of the
     * eleven the tuning specifies. Snapping the springs makes a scripted shot
     * show the camera's steady state, which is what the player actually sees.
     */
    setCamera: (mode: CameraMode): void => {
      this.rig.mode = mode;
      if (mode === 'chase' && this.player) {
        this.syncChaseTarget();
        this.rig.snapTo(this.chase);
      }
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

    /**
     * Frame a piece of course furniture the same way `frameBoat` frames a
     * racer. Props float on the same wave field the boats do, and whether they
     * sit convincingly *in* the surface can only be judged from a close, low
     * angle at the waterline — from the chase cam every float looks fine.
     */
    frameProp: (
      kind: 'gate' | 'buoy',
      index: number,
      yaw: number,
      pitch: number,
      distance: number,
      lookHeight = 0,
    ): void => {
      const target = new Vector3();
      if (kind === 'gate') {
        const gate = this.gates?.gates[index];
        if (!gate) return;
        // The pylon base, not the gate centre: the centre is thirty metres of
        // empty air between the two things that actually touch the water.
        target.set(
          gate.centre.x + gate.across.x * gate.halfWidth,
          gate.group.position.y,
          gate.centre.z + gate.across.z * gate.halfWidth,
        );
      } else {
        if (!this.buoys || index >= this.buoys.count) return;
        this.buoys.instancePosition(index, target);
      }

      const cp = Math.cos(pitch);
      const eye = new Vector3(
        target.x + Math.sin(yaw) * distance * cp,
        target.y + Math.sin(pitch) * distance + lookHeight,
        target.z + Math.cos(yaw) * distance * cp,
      );
      this.rig.setFree(eye, new Vector3(target.x, target.y + lookHeight, target.z));
    },

    /**
     * Look at one waterline station from `back` metres in front of it, at the
     * height of the water there. Eye level with the surface is the only angle
     * that turns a height error into a readable offset on the staff; from above
     * a hovering object and a correctly floating one look identical.
     */
    frameWaterlineStation: (index: number, back = 4, lift = 0.6): void => {
      if (!this.waterline) return;
      const at = stationPosition(index, new Vector3());
      const h = oceanHeight(at.x, at.z, this.simTime);
      const scale = Math.max(1, RIG_STATIONS[index]?.dist ?? 1);
      // Stand off proportionally to the station's own size so every station is
      // framed the same on screen.
      const d = back * Math.sqrt(scale);
      const eye = new Vector3(at.x + d * 0.35, h + lift * Math.sqrt(scale), at.z + d);
      this.rig.setFree(eye, new Vector3(at.x, h + lift * 0.5 * Math.sqrt(scale), at.z));
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

    /** Hand the player's boat to an AI so a shot can be defined at the finish. */
    setAutopilot: (on: boolean): void => {
      this.autopilot = on;
      if (on && !this.playerAI && this.course) {
        this.playerAI = new AIController(0, this.course, AI_PRESETS[0]);
      }
    },

    /** Race state, so a shot can assert it reached the moment it asked for. */
    raceState: () => ({
      phase: this.session === 'title' ? 'intro' : this.director?.phase ?? 'intro',
      mode: this.session,
      specTopSpeed: this.player?.physics.spec.topSpeed ?? 0,
      countdown: this.director?.countdownValue ?? 0,
      standings: (this.director?.standings() ?? []).map((p) => ({
        boat: BOAT_SPECS[p.boatId].name,
        lap: p.lap,
        pos: p.position,
        finished: p.finished,
        finishPosition: p.finishPosition,
        totalTime: Number(p.totalTime.toFixed(2)),
      })),
      rogue: this.rogue
        ? {
            phase: this.rogue.phase,
            stage: this.rogue.stage + 1,
            distance: Number(this.rogue.distance.toFixed(1)),
            points: this.rogue.runPoints,
            specTopSpeed: this.rogue.spec.topSpeed,
          }
        : null,
    }),

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

    /**
     * Poke one ocean uniform. Used for differential captures: the cheapest way
     * to attribute an artefact to a specific term is to shoot the same frame
     * twice with that term disabled and subtract.
     *
     * Note that `Ocean.update` rewrites the wave uniforms from `oceanParams`
     * every frame, so only the ones it leaves alone can be held this way.
     */
    /**
     * Hide one visual layer. Diagnostic only.
     *
     * Water measures 0.84 to 0.96 mean saturation in the frames that contain
     * nothing but ocean and 0.27 to 0.42 in the frames that contain gameplay,
     * with the same shader and the same palette. Something drawn in the second
     * set is covering it. Turning candidates off one at a time is the only way
     * to find out which, and it has to be one process per variant because
     * anything else has already been shown to carry state between samples.
     */
    setLayerVisible: (layer: string, on: boolean): void => {
      const targets: Record<string, { visible: boolean } | null | undefined> = {
        spray: this.spray?.root,
        ribbon: this.racingLine?.mesh,
        ribbonGlow: this.racingLine?.glow,
        gates: this.gates?.root,
        buoys: this.buoys?.root,
        racers: this.raceRoot,
      };
      const t = targets[layer];
      if (t) t.visible = on;
      // The wake needs a latched flag, not a one-shot call: `update` re-binds
      // the wake texture every frame, so clearing it here was undone before the
      // next render and the resulting measurement said the wake did not matter.
      if (layer === 'wake') this.wakeEnabled = on;
    },

    setOceanUniform: (name: string, value: number): void => {
      const u = this.ocean.material.uniforms[name];
      if (u) u.value = value;
    },

    /** Teleport the player onto the spline, for shots of a specific corner. */
    placeOnCourse: (t: number): void => {
      const p = this.player;
      if (!p || !this.course) return;
      const point = this.course.sample(Course.wrap(t), this.simTime);
      const heading = Math.atan2(point.tangent.x, point.tangent.z);
      p.physics.respawn(point.position.clone(), heading, this.simTime);
      this.lastPlayerT = t;
    },

    stats: () => ({
      fps: this.engine.fps,
      frame: this.engine.frame,
      elapsed: this.simTime,
      pixelRatio: this.engine.pixelRatio,
      tier: this.engine.adaptive.tier,
      drawCalls: this.engine.pipeline.stats.calls,
      triangles: this.engine.pipeline.stats.triangles,
      oceanTriangles: this.ocean.triangleCount,
      wakeResolution: this.wake?.size ?? 0,
      riderLod: this.riderLodDist,
      programs: this.engine.renderer.info.programs?.length ?? 0,
      geometries: this.engine.renderer.info.memory.geometries,
      textures: this.engine.renderer.info.memory.textures,
      speed: this.player?.physics.speed ?? 0,
      airborne: this.player?.physics.airborne ?? false,
      courseT: this.lastPlayerT,
    }),
  };
}
