import type { Group, Object3D, Vector3 } from 'three';
import type { Color } from 'three';

/**
 * SHARED CONTRACTS
 *
 * The one file every subsystem is allowed to depend on. Systems talk to each
 * other exclusively through these types, never by importing one another, so the
 * dependency graph stays a tree with `Game` at the root.
 *
 * Anything added here is a commitment: changing a signature means touching
 * every subsystem, so keep the surface small.
 */

// ---------------------------------------------------------------------------
// Frame context
// ---------------------------------------------------------------------------

/** Passed to every system's `update`. Read-only from the system's point of view. */
export interface FrameContext {
  /** Fixed or clamped delta in seconds. */
  dt: number;
  /** Total simulation time in seconds. Drives the wave field. */
  elapsed: number;
  /** Monotonic frame counter. */
  frame: number;
}

// ---------------------------------------------------------------------------
// Ocean sampling — implemented by world/gerstner.ts
// ---------------------------------------------------------------------------

export interface WaterSample {
  height: number;
  nx: number;
  ny: number;
  nz: number;
  jacobian: number;
}

// ---------------------------------------------------------------------------
// Boats
// ---------------------------------------------------------------------------

/** Static per-boat tuning. Distinct hulls can trade top speed against grip. */
export interface BoatSpec {
  name: string;
  /** Palette index 0..3. 0 is the player. */
  colorIndex: number;
  /** Metres per second at full throttle on flat water. */
  topSpeed: number;
  /** Metres per second squared at zero speed. */
  acceleration: number;
  /** Radians per second of yaw authority at reference speed. */
  turnRate: number;
  /** Hull mass in kg; affects how hard it slams. */
  mass: number;
  /** 0..1 how much lateral velocity is preserved in a slide. */
  slidiness: number;
}

/**
 * The read-only view of a boat that other systems (camera, HUD, AI, audio,
 * water) consume. Nothing outside BoatPhysics may mutate these.
 */
export interface BoatState {
  readonly id: number;
  readonly spec: BoatSpec;
  /** World position of the hull origin (at the waterline, mid-hull). */
  readonly position: Vector3;
  /** Unit forward vector in world space. */
  readonly forward: Vector3;
  /** Unit up vector in world space, tilted by pitch and roll. */
  readonly up: Vector3;
  /** Unit right vector in world space. */
  readonly right: Vector3;
  /** Full velocity in world space. */
  readonly velocity: Vector3;
  /** Speed along `forward`, in m/s. Can be negative when reversing. */
  readonly forwardSpeed: number;
  /** Magnitude of horizontal velocity, in m/s. */
  readonly speed: number;
  /** Signed sideways velocity in m/s. Positive is sliding right. */
  readonly lateralSpeed: number;
  /** 0..1 how committed the current powerslide is. */
  readonly driftAmount: number;
  /** 0..1 charge in the boost meter. */
  readonly boostCharge: number;
  /** Seconds of boost remaining, 0 when not boosting. */
  readonly boostTime: number;
  /** True when the hull has left the water. */
  readonly airborne: boolean;
  /** Seconds spent in the current airborne stretch. */
  readonly airTime: number;
  /** Set for one frame on water impact; magnitude is the vertical impact speed. */
  readonly landingImpact: number;
  /** Set for one frame on a collision; magnitude is the impulse. */
  readonly collisionImpact: number;
  /** 0..1 engine load, drives audio pitch and rider animation. */
  readonly throttleLevel: number;
  /** -1..1 the steering actually being applied. */
  readonly steerLevel: number;
  /** How deep the hull centre is below the water surface, in metres. */
  readonly submersion: number;
  /** Pitch/roll in radians, for the rider rig and the HUD horizon. */
  readonly pitch: number;
  readonly roll: number;
}

/** Everything a boat needs to be driven for one tick. */
export interface BoatCommand {
  /** 0..1 */
  throttle: number;
  /** 0..1 */
  brake: number;
  /** -1..1 */
  steer: number;
  /** Held powerslide. */
  drift: boolean;
}

// ---------------------------------------------------------------------------
// Riders
// ---------------------------------------------------------------------------

/**
 * The animation drive signal. Riders are procedurally posed from this every
 * frame — there are no animation clips anywhere in the project.
 */
export interface RiderPose {
  /** -1..1 lean into the turn. */
  lean: number;
  /** -1..1 weight shift; positive is thrown forward under braking. */
  weightShift: number;
  /** 0..1 crouch depth, driven by landings and hard water. */
  crouch: number;
  /** 0..1 how hard the throttle arm is working. */
  throttle: number;
  /** Phase in radians for the idle bob, synced to the boat's vertical motion. */
  bobPhase: number;
  /** Vertical acceleration of the hull, m/s^2. Drives the body's counter-motion. */
  verticalAccel: number;
  /** 0..1 celebration blend, ramps in at the finish. */
  celebrate: number;
  /** 0..1 how tense the pose is; rises with speed. */
  intensity: number;
}

// ---------------------------------------------------------------------------
// Course and race
// ---------------------------------------------------------------------------

export interface CoursePoint {
  /** World XZ position on the racing line (Y is resolved against the waves). */
  position: Vector3;
  /** Unit tangent along the direction of travel. */
  tangent: Vector3;
  /** Unit left-hand normal in the XZ plane. */
  normal: Vector3;
  /** Curvature magnitude, 1/metres. Used for AI braking and corner previews. */
  curvature: number;
  /** Half-width of the drivable corridor at this point, in metres. */
  width: number;
}

export type RacePhase = 'intro' | 'countdown' | 'racing' | 'finished' | 'results';

export interface RacerProgress {
  boatId: number;
  lap: number;
  /** 0..1 progress around the current lap. */
  lapProgress: number;
  /** Monotonic total progress = lap + lapProgress, used for placement sorting. */
  totalProgress: number;
  /** Current 1-based race position. */
  position: number;
  /** Index of the next gate the racer must pass. */
  nextCheckpoint: number;
  /** True while the racer is heading backwards along the spline. */
  wrongWay: boolean;
  /** Completed lap times in seconds. */
  lapTimes: number[];
  /** Total elapsed race time in seconds, frozen at the finish. */
  totalTime: number;
  finished: boolean;
  /** Final placement, 1-based, or 0 while still racing. */
  finishPosition: number;
}

// ---------------------------------------------------------------------------
// System interface
// ---------------------------------------------------------------------------

/** Anything Game ticks. Systems are constructed once and never re-created. */
export interface GameSystem {
  readonly name: string;
  /** Scene content owned by this system, added to the scene graph by Game. */
  readonly root?: Object3D | Group;
  update(ctx: FrameContext): void;
  dispose?(): void;
}

// ---------------------------------------------------------------------------
// Effects requests — systems ask for effects, they do not reach into them
// ---------------------------------------------------------------------------

export interface SprayRequest {
  position: Vector3;
  /** Initial velocity of the burst centre. */
  velocity: Vector3;
  /** Number of particles; the pool clamps this. */
  count: number;
  /** Metres. Controls the spread of the burst. */
  spread: number;
  /** Particle size in metres. */
  size: number;
  /** Seconds. */
  life: number;
  color?: Color;
}

export interface EffectsBus {
  spray(req: SprayRequest): void;
  /** Full-screen colour flash. */
  flash(color: Color, strength: number): void;
  /** Camera shake in metres. */
  shake(amount: number, freq?: number): void;
}

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------

export type SfxName =
  | 'startHorn'
  | 'countdownBeep'
  | 'countdownGo'
  | 'impactSoft'
  | 'impactHard'
  | 'splash'
  | 'boostFire'
  | 'boostCharged'
  | 'gatePass'
  | 'lapComplete'
  | 'wrongWay'
  | 'finish'
  | 'uiMove'
  | 'uiConfirm';

export interface AudioBus {
  /** Per-frame continuous state for the engine and water-rush layers. */
  setEngine(rpm01: number, load01: number, speed01: number, airborne: boolean): void;
  play(name: SfxName, gain?: number): void;
  setMasterGain(g: number): void;
  resume(): Promise<void>;
  readonly enabled: boolean;
}
