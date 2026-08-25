import { Color, Euler, Group, MathUtils, Mesh, Object3D, Quaternion, Vector3 } from 'three';
import type { BufferGeometry, Material } from 'three';
import type { BoatState, FrameContext, RiderPose } from '../contracts.ts';
import { PALETTE } from '../core/Palette.ts';
import { LAYER_OPAQUE } from '../render/layers.ts';
import { CelMaterial } from '../render/materials/CelMaterial.ts';
import type { CelMaterialOptions } from '../render/materials/CelMaterial.ts';
import { outlineHierarchy } from '../render/OutlineHull.ts';
import { GRIP, HIP_HEIGHT, RiderRig, SIDE_LEFT, SIDE_RIGHT } from './RiderRig.ts';
import {
  buildAbdomen,
  buildBoot,
  buildForearm,
  buildGlove,
  buildHelmet,
  buildHelmetFin,
  buildHelmetStripe,
  buildNeck,
  buildPelvis,
  buildShin,
  buildShoulderPad,
  buildThigh,
  buildTorso,
  buildUpperArm,
  buildVisor,
} from './riderGeometry.ts';

/**
 * RIDER — a procedurally animated character, posed entirely from `RiderPose`.
 *
 * There are no animation clips in this game and there is no place to put any,
 * so every frame of every rider is solved from eight scalars. The layers below
 * are additive offsets from the rig's rest crouch and are composed in a fixed
 * order, which keeps them independent: adding a new layer means adding numbers
 * to the accumulators, never rewriting an existing one.
 *
 *   1. heave      counter-motion against the hull's vertical acceleration
 *   2. lean       spine roll into the turn, with a head counter-roll
 *   3. weight     fore/aft shift under acceleration and braking
 *   4. arms       2-bone IK back to the handlebars
 *   5. crouch     under-damped compression on landings
 *   6. celebrate  a quaternion blend away from the whole racing pose
 *   7. intensity  a global tightening of everything at speed
 *
 * The one rule that makes it hold together: nothing is written to a bone
 * directly from an input. Every driver goes through a damped spring or an
 * exponential smoother first, because `BoatState` contains genuine
 * discontinuities — `landingImpact` is a single-frame delta spike, `steerLevel`
 * snaps the instant a key goes down — and a rider that tracks those exactly
 * looks like a glitch rather than a person.
 */

const clamp = MathUtils.clamp;
const TAU = Math.PI * 2;

export interface RiderOptions {
  /**
   * Which way the parent mount considers "forwards". The rider is authored
   * facing +Z (three.js `lookAt` convention); pass -1 if the boat's hull points
   * down -Z instead and the whole rider, including its handlebar targets, is
   * yawed to match.
   */
  facing?: 1 | -1;
  /** Uniform scale. 1 is a ~1.7 m rider. */
  scale?: number;
}

// ---------------------------------------------------------------------------
// Smoothing primitives
// ---------------------------------------------------------------------------

interface Spring {
  v: number;
  dv: number;
}

function makeSpring(v = 0): Spring {
  return { v, dv: 0 };
}

/**
 * A mass-spring-damper on a scalar. `zeta` below 1 overshoots, at 1 it settles
 * without crossing.
 *
 * Sub-stepped rather than solved analytically because we want the *under*damped
 * case, where the closed form needs a separate branch per damping regime and
 * degenerates awkwardly at zeta = 1. Sub-stepping costs a handful of multiplies
 * on a signal we update maybe ten times per rider per frame and stays stable at
 * any frame rate, which is the property that actually matters.
 */
function springStep(s: Spring, target: number, omega: number, zeta: number, dt: number): number {
  if (dt <= 0) return s.v;
  const steps = Math.min(8, Math.max(1, Math.ceil((dt * omega) / 0.25)));
  const h = dt / steps;
  for (let i = 0; i < steps; i++) {
    s.dv += (omega * omega * (target - s.v) - 2 * zeta * omega * s.dv) * h;
    s.v += s.dv * h;
  }
  return s.v;
}

/**
 * Frame-rate independent exponential approach. `rate` is in units of e-folds
 * per second, so the same call converges over the same amount of *time* at 30
 * and at 144 fps — a raw `lerp(a, b, 0.1)` does not and is why smoothing tuned
 * on one machine feels wrong on another.
 */
function expApproach(current: number, target: number, rate: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-rate * dt));
}

/** Shortest signed distance from angle `b` to angle `a`, in (-PI, PI]. */
function wrapPi(a: number): number {
  let x = (a + Math.PI) % TAU;
  if (x < 0) x += TAU;
  return x - Math.PI;
}

// ---------------------------------------------------------------------------
// Two-bone analytic IK
// ---------------------------------------------------------------------------

const NEG_Y = new Vector3(0, -1, 0);
const _ikTarget = new Vector3();
const _ikU = new Vector3();
const _ikPole = new Vector3();
const _ikPerp = new Vector3();
const _ikD1 = new Vector3();
const _ikD2 = new Vector3();
const _ikElbow = new Vector3();
const _qa = new Quaternion();
const _qb = new Quaternion();
const _qc = new Quaternion();
const _qd = new Quaternion();
const _hip = new Vector3();

/**
 * Solve a two-bone chain to a target, analytically.
 *
 * `target` is measured from the chain's pivot in the first bone's parent space,
 * and both bones are authored pointing down -Y. The law of cosines gives the
 * elbow angle directly; the only real decision is which of the infinitely many
 * solutions around the shoulder-to-hand axis to take, and that is what `pole`
 * picks — the elbow is placed in the plane containing the target direction and
 * the pole, on the pole's side.
 *
 * This exists because the hands have to stay welded to the handlebars while the
 * spine leans, pitches, compresses and bobs underneath them. Posed forwards
 * with FK the hands would swing several centimetres off the bars on every
 * layer, which at rider scale is the difference between a driver and a mime.
 */
function solveTwoBone(
  target: Vector3,
  l1: number,
  l2: number,
  pole: Vector3,
  outUpper: Quaternion,
  outFore: Quaternion,
): void {
  if (target.lengthSq() < 1e-10) {
    outUpper.identity();
    outFore.identity();
    return;
  }
  // Clamping the reach short of full extension keeps the elbow angle away from
  // the singularity at 180 degrees, where tiny target jitter would flip the
  // joint through straight and snap the arm.
  const d = clamp(target.length(), Math.abs(l1 - l2) + 1e-3, (l1 + l2) * 0.998);
  _ikU.copy(target).normalize();

  _ikPerp.copy(pole).addScaledVector(_ikU, -pole.dot(_ikU));
  if (_ikPerp.lengthSq() < 1e-8) {
    // Pole parallel to the target: any perpendicular will do, but it has to be
    // *some* fixed choice or the elbow spins on numerical noise.
    _ikPerp.set(_ikU.y, -_ikU.x, 0);
    if (_ikPerp.lengthSq() < 1e-8) _ikPerp.set(0, 0, 1);
  }
  _ikPerp.normalize();

  const cosA = clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1);
  const a = Math.acos(cosA);
  _ikD1.copy(_ikU).multiplyScalar(Math.cos(a)).addScaledVector(_ikPerp, Math.sin(a)).normalize();
  _ikElbow.copy(_ikD1).multiplyScalar(l1);
  _ikD2.copy(_ikU).multiplyScalar(d).sub(_ikElbow);
  if (_ikD2.lengthSq() < 1e-10) _ikD2.copy(_ikD1);
  _ikD2.normalize();

  outUpper.setFromUnitVectors(NEG_Y, _ikD1);
  _qc.setFromUnitVectors(NEG_Y, _ikD2);
  _qd.copy(outUpper).invert();
  outFore.copy(_qd).multiply(_qc);
}

// ---------------------------------------------------------------------------
// Pose derivation memory
// ---------------------------------------------------------------------------

interface PoseMemory {
  forwardSpeed: number;
  velY: number;
}

/**
 * `poseFromBoat` is static by contract but needs the previous frame's velocity
 * to difference into an acceleration, and `RiderPose` carries no velocity to
 * stash it in. Keying one tiny record per boat id is the least invasive place
 * to keep it; `clearPoseMemory` exists so a race restart does not inherit a
 * stale delta and fire a phantom landing on the first frame.
 */
const poseMemory = new Map<number, PoseMemory>();

// ---------------------------------------------------------------------------
// Rider
// ---------------------------------------------------------------------------

/** One side's bones, resolved once so the update loop never does a lookup. */
interface SideChain {
  side: number;
  shoulder: Object3D;
  upper: Object3D;
  fore: Object3D;
  hand: Object3D;
  thigh: Object3D;
  shin: Object3D;
  foot: Object3D;
  /** Persistent smoothed IK result, kept apart from the celebration blend so a
   *  blend-out never feeds the celebration pose back into the racing solve. */
  qUpper: Quaternion;
  qFore: Quaternion;
}

export class Rider {
  /** Parent this to `Boat.riderMount`. */
  readonly root: Group;
  readonly rig: RiderRig;

  private readonly colorIndex: number;
  private readonly geometries: BufferGeometry[] = [];
  private readonly materials: CelMaterial[] = [];
  private readonly outlines: Mesh[] = [];
  private readonly sides: SideChain[];

  private time = 0;
  /**
   * Per-racer phase offset on every free-running oscillator. Four riders
   * breathing and swaying in perfect unison instantly reads as a copy-paste;
   * a fixed irrational-ish offset per colour index costs nothing and kills it.
   */
  private readonly phase: number;

  private readonly sLean = makeSpring();
  private readonly sWeight = makeSpring();
  private readonly sCrouch = makeSpring();
  private readonly sSag = makeSpring();
  private readonly sCelebrate = makeSpring();
  private readonly sIntensity = makeSpring();
  private readonly sThrottle = makeSpring();

  constructor(colorIndex: number, opts: RiderOptions = {}) {
    this.colorIndex = clamp(Math.floor(colorIndex), 0, PALETTE.racer.length - 1);
    this.phase = this.colorIndex * 2.399963; // golden-angle spacing in radians

    this.root = new Group();
    this.root.name = `rider${this.colorIndex}`;
    this.root.frustumCulled = false;
    if (opts.facing === -1) this.root.rotation.y = Math.PI;
    if (opts.scale !== undefined) this.root.scale.setScalar(opts.scale);

    this.rig = new RiderRig();
    this.root.add(this.rig.root);

    const accent = PALETTE.racer[this.colorIndex];

    // Two suit tones rather than one: the darker `suit` carries the large
    // masses and the lighter `suitLit` picks out helmet, gloves and boots. That
    // separation is what stops the character collapsing into one silhouette
    // blob at distance, and it is cheaper than any amount of extra geometry.
    //
    // Note that no material here sets `rampTint`. The cel shader already
    // multiplies the ramp by the base colour, so tinting the ramp to the paint
    // colour squares it and the shadows go muddy; the shared neutral ramp keeps
    // the rider's shadow temperature identical to the hull it sits on.
    const suit = this.material({
      color: PALETTE.suit,
      rimColor: PALETTE.visor,
      rimStrength: 0.34,
      rimPower: 3.2,
      specStrength: 0.3,
      specSize: 0.22,
      matcapStrength: 0.16,
      name: 'RiderSuit',
    });
    const gear = this.material({
      color: PALETTE.suitLit,
      rimColor: PALETTE.visor,
      rimStrength: 0.42,
      rimPower: 2.8,
      specStrength: 0.62,
      specSize: 0.36,
      matcapStrength: 0.3,
      name: 'RiderGear',
    });
    const paint = this.material({
      color: accent,
      rimColor: accent,
      rimStrength: 0.5,
      rimPower: 2.4,
      specStrength: 0.5,
      specSize: 0.3,
      matcapStrength: 0.22,
      name: 'RiderPaint',
    });
    const skin = this.material({
      color: PALETTE.skin,
      rimColor: PALETTE.skinShade,
      rimStrength: 0.25,
      rimPower: 3.5,
      specStrength: 0.12,
      specSize: 0.5,
      matcapStrength: 0.05,
      name: 'RiderSkin',
    });
    // The visor is the only emissive surface on the rider. It is doing a
    // specific job: a helmet reads as a featureless lump unless something marks
    // where the face is, and a bright cyan shape does that at any distance,
    // in shadow, and from behind a wall of spray.
    const visor = this.material({
      color: new Color().copy(PALETTE.visor).multiplyScalar(0.34),
      emissive: PALETTE.visor,
      emissiveStrength: 0.9,
      rimColor: PALETTE.visor,
      rimStrength: 1.1,
      rimPower: 2.0,
      specStrength: 1.0,
      specSize: 0.55,
      matcapStrength: 0.45,
      name: 'RiderVisor',
    });

    const r = this.rig;
    this.part(buildPelvis(), suit, r.hips, 'pelvis');
    this.part(buildAbdomen(), suit, r.spineLower, 'abdomen');
    this.part(buildTorso(), suit, r.chest, 'torso');
    this.part(buildNeck(), skin, r.neck, 'neck');
    this.part(buildHelmet(), gear, r.head, 'helmet');
    this.part(buildVisor(), visor, r.head, 'visor');
    this.part(buildHelmetStripe(), paint, r.head, 'helmetStripe');
    this.part(buildHelmetFin(), paint, r.head, 'helmetFin');

    for (const side of [SIDE_LEFT, SIDE_RIGHT]) {
      const tag = side === SIDE_LEFT ? 'L' : 'R';
      this.part(buildShoulderPad(side), paint, r.sided('shoulder', side), `shoulderPad${tag}`);
      this.part(buildUpperArm(), suit, r.sided('upperArm', side), `upperArm${tag}`);
      this.part(buildForearm(), suit, r.sided('forearm', side), `forearm${tag}`);
      this.part(buildGlove(), gear, r.sided('hand', side), `glove${tag}`);
      this.part(buildThigh(), suit, r.sided('thigh', side), `thigh${tag}`);
      this.part(buildShin(), suit, r.sided('shin', side), `shin${tag}`);
      this.part(buildBoot(), gear, r.sided('foot', side), `boot${tag}`);
    }

    this.sides = [SIDE_LEFT, SIDE_RIGHT].map((side) => ({
      side,
      shoulder: r.sided('shoulder', side),
      upper: r.sided('upperArm', side),
      fore: r.sided('forearm', side),
      hand: r.sided('hand', side),
      thigh: r.sided('thigh', side),
      shin: r.sided('shin', side),
      foot: r.sided('foot', side),
      // Seed from rest so the very first frame slerps out of the racing crouch
      // rather than out of the identity rotation.
      qUpper: r.restOf(r.sided('upperArm', side)).clone(),
      qFore: r.restOf(r.sided('forearm', side)).clone(),
    }));

    // Riders are a third the size of a hull on screen, so their ink needs to be
    // finer than the boat's or the character turns into a blot at mid distance.
    // The taper is pushed above the default for the same reason: a constant
    // 2 px line on something this small still swallows it in the pack.
    this.outlines = outlineHierarchy(this.root, { widthPx: 2.0, distanceTaper: 0.5 });

    this.root.traverse((o) => {
      o.layers.set(LAYER_OPAQUE);
      o.frustumCulled = false;
    });
  }

  private material(opts: CelMaterialOptions): CelMaterial {
    const m = new CelMaterial(opts);
    this.materials.push(m);
    return m;
  }

  private part(geo: BufferGeometry, mat: CelMaterial, parent: Object3D, name: string): Mesh {
    const mesh = new Mesh(geo, mat);
    mesh.name = `rider${this.colorIndex}_${name}`;
    this.geometries.push(geo);
    parent.add(mesh);
    return mesh;
  }

  // -------------------------------------------------------------------------
  // Pose derivation
  // -------------------------------------------------------------------------

  /**
   * Turn a boat's physics state into an animation drive signal.
   *
   * Everything here is a *smoothed* quantity. The rig's own springs add a
   * second stage on top, which is deliberate: this pass removes the physics
   * discontinuities (impact spikes, input steps) so the numbers are continuous,
   * and the rig stage adds the body's mechanical lag and overshoot. Doing both
   * in one place forces one filter to serve two jobs and it ends up doing
   * neither well.
   */
  static poseFromBoat(state: BoatState, prev: RiderPose, dt: number, celebrate: number): RiderPose {
    const h = clamp(dt, 1 / 480, 1 / 15);

    let mem = poseMemory.get(state.id);
    if (!mem) {
      mem = { forwardSpeed: state.forwardSpeed, velY: state.velocity.y };
      poseMemory.set(state.id, mem);
    }
    // Clamped before smoothing: a hull that gets teleported or resolves a deep
    // penetration in one step can report thousands of m/s^2, and letting that
    // into the filter would ring for a second afterwards.
    const accelFwd = clamp((state.forwardSpeed - mem.forwardSpeed) / h, -60, 60);
    const accelY = clamp((state.velocity.y - mem.velY) / h, -90, 90);
    mem.forwardSpeed = state.forwardSpeed;
    mem.velY = state.velocity.y;

    const topSpeed = Math.max(state.spec.topSpeed, 1);
    const speed01 = clamp(state.speed / topSpeed, 0, 1.25);

    const verticalAccel = expApproach(prev.verticalAccel, accelY, 16, h);

    // --- lean --------------------------------------------------------------
    // Hull roll is deliberately *not* an input. The rider is parented to the
    // boat, so the hull already rolls them; feeding roll back in would double
    // it and the rider would out-lean the machine.
    const slip = clamp(state.lateralSpeed / 8, -1, 1);
    const driftBias = state.driftAmount * Math.sign(state.steerLevel || slip);
    const leanTarget = clamp(state.steerLevel * 0.75 + slip * 0.32 + driftBias * 0.24, -1, 1);
    const lean = expApproach(prev.lean, leanTarget, 7, h);

    // --- weight shift ------------------------------------------------------
    // Positive is thrown forward, which is what *deceleration* does, hence the
    // sign flip. Airborne the rider is in free fall with the hull and there is
    // nothing to be thrown against, so the target collapses towards neutral.
    const airScale = state.airborne ? 0.25 : 1;
    const weightTarget = clamp((-accelFwd / 12) * airScale, -1, 1);
    const weightShift = expApproach(prev.weightShift, weightTarget, 6, h);

    // --- crouch ------------------------------------------------------------
    // `landingImpact` and `collisionImpact` are set for exactly ONE frame, so
    // they are applied as a floor rather than pushed through a filter. No
    // smoother can reach its target in a single step — running a one-frame
    // spike through even a very fast attack scales a full-force landing down to
    // about a third of its intended size, and the harder the impact the more of
    // it gets thrown away. Stepping the drive signal instead is safe precisely
    // because the body is moved by an underdamped spring downstream: a step
    // into a spring is exactly the impulse response we want out of a landing.
    const impulse = Math.max(clamp(state.landingImpact / 8, 0, 1), clamp(state.collisionImpact / 900, 0, 0.8));

    // Sustained load, which does want filtering: ploughing the nose into a wave
    // squats the legs the same way a landing does, and in the air the rider
    // pre-loads for the arrival instead of dangling.
    let sustained = clamp(state.submersion / 0.9, 0, 0.5);
    if (state.airborne) sustained = Math.max(sustained, 0.2 + clamp(state.airTime * 0.4, 0, 0.25));
    // Fast attack, slower release: the legs load instantly and the body takes
    // the better part of a second to stand back up. The release is kept quick
    // enough that the rig's knee spring, not this filter, shapes the recovery —
    // otherwise the bounce is smoothed away here and the landing lands soft.
    const crouch = Math.max(
      expApproach(prev.crouch, sustained, sustained > prev.crouch ? 26 : 5.5, h),
      impulse,
    );

    const throttle = expApproach(prev.throttle, clamp(state.throttleLevel, 0, 1), 8, h);

    const intensityTarget = clamp(speed01 * 0.85 + (state.boostTime > 0 ? 0.25 : 0) + state.driftAmount * 0.15, 0, 1);
    const intensity = expApproach(prev.intensity, intensityTarget, 2.5, h);

    // --- bob phase ---------------------------------------------------------
    // A free-running sine would drift against the swell within a few seconds
    // and the rider would visibly bob out of time with the boat they are
    // sitting on. Instead the oscillator is phase-locked to the hull's actual
    // heave: for y = A sin(phi) we have vy = A*w*cos(phi) and ay = -A*w^2*sin(phi),
    // so atan2(-ay/w^2, vy/w) recovers the instantaneous phase of the real
    // motion. Lock strength scales with how much heave there is, so on glassy
    // water the oscillator free-runs instead of chasing noise.
    const omega = TAU * (0.5 + 0.35 * clamp(speed01, 0, 1));
    let bobPhase = prev.bobPhase + omega * h;
    const sinTerm = -verticalAccel / (omega * omega);
    const cosTerm = state.velocity.y / omega;
    const heaveAmp = Math.hypot(sinTerm, cosTerm);
    if (heaveAmp > 0.02) {
      const measured = Math.atan2(sinTerm, cosTerm);
      const lock = Math.min(1, heaveAmp / 0.3) * Math.min(1, 3 * h);
      bobPhase += wrapPi(measured - bobPhase) * lock;
    }
    bobPhase = ((bobPhase % TAU) + TAU) % TAU;

    return {
      lean,
      weightShift,
      crouch,
      throttle,
      bobPhase,
      verticalAccel,
      celebrate: expApproach(prev.celebrate, clamp(celebrate, 0, 1), 2.2, h),
      intensity,
    };
  }

  /** A neutral pose, for the first frame of a boat before any physics has run. */
  static restPose(): RiderPose {
    return {
      lean: 0,
      weightShift: 0,
      crouch: 0,
      throttle: 0,
      bobPhase: 0,
      verticalAccel: 0,
      celebrate: 0,
      intensity: 0,
    };
  }

  /** Drop the differencing state for one boat, or all of them. Call on restart. */
  static clearPoseMemory(id?: number): void {
    if (id === undefined) poseMemory.clear();
    else poseMemory.delete(id);
  }

  // -------------------------------------------------------------------------
  // Animation
  // -------------------------------------------------------------------------

  update(pose: RiderPose, ctx: FrameContext): void {
    // A long frame (tab restore, first frame after a shader compile) would
    // otherwise slam every spring at once and visibly detonate the rig.
    const dt = clamp(ctx.dt, 0, 1 / 15);
    this.time += dt;
    const t = this.time + this.phase;

    // --- drive signals -----------------------------------------------------
    const lean = clamp(springStep(this.sLean, clamp(pose.lean, -1, 1), 11, 1, dt), -1.2, 1.2);
    const weight = clamp(springStep(this.sWeight, clamp(pose.weightShift, -1, 1), 9, 0.85, dt), -1.2, 1.2);
    // The damping ratio here is the whole landing. A critically damped knee
    // settles into the compression like a hydraulic door closer; at zeta 0.32
    // it drops past the target, rebounds a little above neutral and rings out
    // over two cycles, which is what a body absorbing an impact actually does
    // and is the difference between "landed" and "arrived".
    const crouch = clamp(springStep(this.sCrouch, clamp(pose.crouch, 0, 1), 15.5, 0.32, dt), -0.3, 1.45);
    // Positive sag means the hull is accelerating upwards and the rider's mass
    // is lagging behind it, i.e. the body compresses into the boat. Negative is
    // the drop into a trough, where they extend and go light.
    const sag = clamp(springStep(this.sSag, clamp(pose.verticalAccel / 26, -1.2, 1.2), 13, 0.55, dt), -1.2, 1.2);
    const cel = clamp(springStep(this.sCelebrate, clamp(pose.celebrate, 0, 1), 6, 1, dt), 0, 1);
    const inten = clamp(springStep(this.sIntensity, clamp(pose.intensity, 0, 1), 4, 1, dt), 0, 1);
    const thr = clamp(springStep(this.sThrottle, clamp(pose.throttle, 0, 1), 9, 1, dt), 0, 1);

    // Idle life is suppressed at speed: a tense rider stops fidgeting. Keeping
    // the secondary sway alive at full throttle is one of the fastest ways to
    // make a character look like it is not actually trying.
    const life = 1 - 0.45 * inten;
    const bob = Math.sin(pose.bobPhase);

    // --- hips --------------------------------------------------------------
    let hipX = -lean * 0.045;
    let hipY = -sag * 0.055 + bob * 0.013 * (0.45 + 0.55 * thr) - crouch * 0.145 - inten * 0.025;
    let hipZ = weight * 0.03 + inten * 0.015;
    // Hips rotate into the corner as well as slide into it. Translation alone
    // reads as the whole character being nudged sideways; the yaw is what makes
    // it read as the rider driving from the pelvis.
    const hipRotY = -lean * 0.06;
    const hipRotZ = lean * 0.05;

    // --- spine -------------------------------------------------------------
    const slX = weight * 0.1 + crouch * 0.1 + inten * 0.06 + sag * 0.09;
    const slZ = lean * 0.1;
    const suX = weight * 0.12 + crouch * 0.1 + inten * 0.07 + sag * 0.07 + Math.sin(t * 1.7) * 0.01 * life;
    const suZ = lean * 0.13;
    const chX = weight * 0.06 + inten * 0.05 + sag * 0.04;
    const chY = Math.sin(t * 1.31) * 0.02 * life;
    const chZ = lean * 0.09 + Math.sin(t * 0.97) * 0.016 * life + Math.sin(pose.bobPhase * 0.5 + 0.7) * 0.012;

    // --- head --------------------------------------------------------------
    // The spine chain above rolls a total of ~0.32 rad into the turn and the
    // hips add another 0.05. The head gives back 0.32 of that, leaving a
    // deliberate ~15% residual tilt.
    //
    // This is the single detail that most makes the character look alive, and
    // it is worth being explicit about why: a real person stabilises their head
    // against the horizon because their balance and their eyes demand it, so a
    // head that rigidly follows the shoulders reads as an object being carried
    // rather than a person riding. Cancelling it *entirely* is wrong too — that
    // looks gyroscopic. The residual is the tell that the neck is doing work.
    const nkX = -sag * 0.05 + crouch * 0.08 + inten * 0.05;
    const nkZ = -lean * 0.04;
    const hdX =
      -weight * 0.14 + crouch * 0.14 + inten * 0.03 - sag * 0.1 + Math.sin(t * 1.09) * 0.012 * life;
    const hdY = -lean * 0.26 + Math.sin(t * 0.71) * 0.045 * life;
    const hdZ = -lean * 0.28 + Math.sin(t * 1.13) * 0.02 * life;

    // --- legs --------------------------------------------------------------
    // The hip drop and the extra knee fold are tuned against each other so the
    // boots stay in the footwells through a full compression instead of sinking
    // through the deck or lifting off it.
    const thX = -crouch * 0.34 - weight * 0.05 - sag * 0.16;
    const shX = crouch * 0.5 + weight * 0.12 + sag * 0.22;
    const ftX = -crouch * 0.16 - weight * 0.08;
    const kneeSplay = 0.06 * lean;

    const shrug = crouch * 0.14 + inten * 0.1 + Math.abs(weight) * 0.05;

    // --- celebration -------------------------------------------------------
    // Fast enough to read as excitement, slow enough not to strobe.
    const pump = Math.sin(this.time * 7);
    const celTwist = Math.sin(this.time * 2.1);

    if (cel > 1e-3) {
      hipY = MathUtils.lerp(hipY, 0.045 + pump * 0.03, cel);
      hipX = MathUtils.lerp(hipX, celTwist * 0.02, cel);
      hipZ = MathUtils.lerp(hipZ, -0.02, cel);
    }

    this.applyBone(this.rig.hips, 0, hipRotY, hipRotZ, 0, celTwist * 0.14, 0, cel, 0.5);
    this.applyBone(this.rig.spineLower, slX, 0, slZ, -0.18, 0, celTwist * 0.06, cel, 0.5);
    this.applyBone(this.rig.spineUpper, suX, 0, suZ, -0.2, celTwist * 0.1, celTwist * 0.08, cel, 0.5);
    this.applyBone(this.rig.chest, chX, chY, chZ, -0.16, celTwist * 0.22, Math.sin(t * 1.6) * 0.1, cel, 0.5);
    this.applyBone(this.rig.neck, nkX, 0, nkZ, -0.05, 0, 0, cel, 0.45);
    this.applyBone(
      this.rig.head,
      hdX,
      hdY,
      hdZ,
      -0.24,
      Math.sin(this.time * 1.7) * 0.55,
      Math.sin(this.time * 2.6) * 0.14,
      cel,
      0.7,
    );

    for (const chain of this.sides) {
      const side = chain.side;
      // Shrug is mirrored (both shoulders rise); the lean term is not, so the
      // shoulder *line* tilts with the turn instead of both ends lifting.
      this.applyBone(chain.shoulder, 0, 0, side * shrug + lean * 0.02, 0, 0, side * 0.26, cel, 0.45);
      this.applyBone(chain.thigh, thX, 0, side * kneeSplay, 0.28, 0, 0, cel, 0.9);
      this.applyBone(chain.shin, shX, 0, 0, -0.3, 0, 0, cel, 1.1);
      this.applyBone(chain.foot, ftX, 0, 0, 0.08, 0, 0, cel, 0.6);
    }

    _hip.copy(this.rig.restPositionOf(this.rig.hips));
    this.rig.hips.position.set(_hip.x + hipX, HIP_HEIGHT + hipY, _hip.z + hipZ);

    // Everything downstream of here needs live world matrices: the arm targets
    // live in rider-root space and have to be pushed through the spine we just
    // posed to reach the shoulders.
    this.root.updateMatrixWorld(true);
    this.solveArms(pose, dt, lean, weight, thr, inten, crouch, sag, cel, t);
  }

  /**
   * Layer 4: the arms.
   *
   * The handlebars belong to the boat, so their position in rider-root space is
   * essentially fixed — only the steering rotates the bar assembly, swinging
   * the inside grip back and the outside grip forward. Everything else the
   * arms do is a *consequence* rather than an animation: when the weight layer
   * throws the shoulders forward over the bars the elbows have to fold to keep
   * the hands where they are, and when acceleration settles the rider back the
   * arms straighten out. Those two behaviours are requirement 3 in the brief
   * and neither of them is written down anywhere below — they fall out of
   * solving to a fixed target.
   */
  private solveArms(
    pose: RiderPose,
    dt: number,
    lean: number,
    weight: number,
    thr: number,
    inten: number,
    crouch: number,
    sag: number,
    cel: number,
    t: number,
  ): void {
    // The IK output is already continuous, but a hull collision can move the
    // shoulders far in one frame; this caps how fast the arms may respond.
    const follow = 1 - Math.exp(-24 * dt);
    const tuck = clamp(inten * 0.35 + crouch * 0.2, 0, 0.7);

    for (const arm of this.sides) {
      const s = arm.side;
      const isThrottleHand = s === SIDE_RIGHT;

      // Bar assembly yaw: the grip on the inside of the turn comes back and
      // drops, the outside grip pushes forward and rises.
      _ikTarget.set(
        s * GRIP.x + lean * 0.006,
        GRIP.y + s * lean * 0.012,
        GRIP.z + s * lean * 0.055,
      );
      // Continuous working motion. The throttle hand gets the larger share
      // because it is the one blipping the trigger; the other is bracing.
      const workAmp = isThrottleHand ? 0.011 : 0.006;
      const workRate = isThrottleHand ? 7.3 : 6.1;
      _ikTarget.z += Math.sin(t * workRate) * workAmp * thr;
      _ikTarget.y += Math.sin(t * workRate * 1.37 + s) * workAmp * 0.4 * thr;
      // Chop feeds through the grip: hands are not welded to the bars, they
      // ride them, and a few millimetres of give here is what stops the arms
      // looking like scaffolding when the hull is slamming.
      _ikTarget.y += sag * 0.008;

      this.root.localToWorld(_ikTarget);
      const shoulder = arm.upper.parent as Object3D;
      shoulder.worldToLocal(_ikTarget);
      _ikTarget.sub(arm.upper.position);

      // Elbows sit out and back at rest, tuck in at speed, and flare up under
      // braking — the chicken-wing a rider throws when they are hanging off the
      // bars to stop themselves going over them. The X term is kept modest on
      // purpose: a pole pointing hard sideways puts the elbows outside the
      // hull, which looks wrong and is the first thing to break if the rig is
      // scaled onto a narrower boat.
      _ikPole.set(s * (0.6 - 0.28 * tuck), -0.55 + weight * 0.38, -0.74 - 0.2 * tuck);

      solveTwoBone(_ikTarget, this.rig.upperArmLength, this.rig.forearmLength, _ikPole, _qa, _qb);
      arm.qUpper.slerp(_qa, follow);
      arm.qFore.slerp(_qb, follow);

      arm.upper.quaternion.copy(arm.qUpper);
      arm.fore.quaternion.copy(arm.qFore);

      if (cel > 1e-3) {
        // Celebration arms are absolute, not offsets from rest. The pose is far
        // enough from the racing crouch that composing Euler offsets on top of
        // the rest rotation would not land anywhere predictable.
        const pump = Math.sin(this.time * 7 + (isThrottleHand ? 0 : 0.9));
        _qc.setFromEuler(_celEuler.set(-2.35 + pump * 0.3, 0, s * (0.4 + pump * 0.1), 'XYZ'));
        arm.upper.quaternion.slerp(_qc, cel);
        _qc.setFromEuler(_celEuler.set(-0.75 - pump * 0.55, 0, 0, 'XYZ'));
        arm.fore.quaternion.slerp(_qc, cel);
      }

      // Wrist. The glove geometry is already a closed fist curled around a bar,
      // so all this has to do is roll it: forward on the throttle, braced back
      // under deceleration, and absorbing a little of the chop.
      const wristX =
        (isThrottleHand ? thr * 0.2 + Math.sin(t * 7.3) * 0.05 * thr : thr * 0.06) +
        weight * 0.12 -
        sag * 0.06;
      this.applyBone(arm.hand, wristX, 0, s * lean * 0.06, 0.35, 0, 0, cel, 0.5);
    }
  }

  /**
   * Write `rest * euler(racing)` onto a bone, optionally blended towards
   * `rest * euler(celebration)`.
   *
   * The blend is a slerp rather than a per-channel lerp so a half-blended pose
   * takes the shortest arc between the two orientations instead of travelling
   * through whatever intermediate Euler triple happens to lie between them —
   * which, with the arms 130 degrees apart, is emphatically not the same path.
   *
   * `limit` clamps each racing channel. Several layers stack into the same
   * accumulator, so a pathological input (a landing during a hard turn at full
   * boost) can otherwise sum past the joint's plausible range and fold the rig
   * through itself.
   */
  private applyBone(
    bone: Object3D,
    rx: number,
    ry: number,
    rz: number,
    cx: number,
    cy: number,
    cz: number,
    cel: number,
    limit: number,
  ): void {
    this.rig.composeOffset(bone, clamp(rx, -limit, limit), clamp(ry, -limit, limit), clamp(rz, -limit, limit), _qa);
    if (cel > 1e-3) {
      this.rig.composeOffset(bone, cx, cy, cz, _qb);
      _qa.slerp(_qb, cel);
    }
    bone.quaternion.copy(_qa);
  }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    this.geometries.length = 0;
    for (const m of this.materials) m.dispose();
    this.materials.length = 0;
    // Ink shells share their geometry with the mesh they wrap, so only their
    // materials are still outstanding. `disposeOutlines()` would also collect
    // them at shutdown, but a rider can be torn down mid-session.
    for (const shell of this.outlines) (shell.material as Material).dispose();
    this.outlines.length = 0;
    this.root.removeFromParent();
    this.root.clear();
  }
}

/** Shared scratch for the absolute celebration angles. */
const _celEuler = new Euler();
