import { MathUtils, Matrix4, Quaternion, Vector3 } from 'three';
import type { BoatCommand, BoatSpec, BoatState, EffectsBus, FrameContext } from '../contracts.ts';
import { sampleOcean, type OceanSample } from '../world/gerstner.ts';
import { PALETTE } from '../core/Palette.ts';
import {
  HULL_COLLISION_RADIUS,
  HULL_PITCH_INERTIA,
  HULL_PROBE_POINTS,
  HULL_PROBE_WEIGHTS,
  HULL_ROLL_INERTIA,
  SPRAY_POINTS,
  THRUST_POINT,
} from './hullSpec.ts';

/**
 * BOAT PHYSICS — the feel.
 *
 * This is an arcade model wearing a simulation's clothes. Yaw is driven
 * directly by steering rather than emerging from hydrodynamic forces, because
 * a real boat's yaw response is soggy and unsatisfying to drive. But pitch,
 * roll and heave ARE simulated, from six buoyancy probes sampling the same
 * Gerstner surface the vertex shader displaces. That split is deliberate: the
 * player's *intent* goes straight into the heading, while the *world* acts on
 * the hull. The boat obeys you and fights the water at the same time.
 *
 * Everything below is tuned around a 34 m/s top speed and a swell whose crests
 * are 2-4 m apart in height.
 */

const GRAVITY = 9.81;

/** Substeps per frame. The buoyancy spring is stiff; one 60 Hz step rings. */
const SUBSTEPS = 3;

// Scratch vectors. Physics runs 4 boats x 3 substeps x 6 probes per frame, so
// nothing in the hot path is allowed to allocate.
const _v = new Vector3();
const _probeWorld = new Vector3();
const _force = new Vector3();
const _torque = new Vector3();
const _tmp = new Vector3();
const _q = new Quaternion();
const _sample: OceanSample = { height: 0, nx: 0, ny: 1, nz: 0, jacobian: 1 };
const _sampleAhead: OceanSample = { height: 0, nx: 0, ny: 1, nz: 0, jacobian: 1 };

/** Half-spacing of the three-tap hull filter, in metres. Roughly 0.35 x LOA. */
const HULL_FILTER_SPAN = 1.9;

/**
 * Water surface height as the hull experiences it: a three-tap spatial average
 * along the keel, which low-passes away waves shorter than the boat.
 * See the long comment at the call site for why this exists.
 */
function filteredSurface(world: Vector3, forward: Vector3, time: number): number {
  const fx = forward.x * HULL_FILTER_SPAN;
  const fz = forward.z * HULL_FILTER_SPAN;
  const centre = sampleOcean(world.x, world.z, time, _sample).height;
  const ahead = sampleOcean(world.x + fx, world.z + fz, time, _sampleAhead).height;
  const behind = sampleOcean(world.x - fx, world.z - fz, time, _sampleAhead).height;
  return (centre + ahead + behind) / 3;
}

/**
 * Deterministic per-boat noise.
 *
 * The physics needs a little randomness — a landing that jolts the hull by
 * exactly the same amount every time reads as mechanical, and spray that always
 * leaves the same side of the bow is a pattern the eye finds immediately. But
 * `Math.random()` makes a race unreproducible, and this project's entire
 * verification story rests on reproducibility: the screenshot harness claims a
 * shot at t = 12.0s is the same frame on every run, and the headless probes
 * claim to be measurements rather than samples. Neither is true if the hull
 * rolls an unseeded die on every landing.
 *
 * mulberry32: small, fast, and good enough for jitter.
 */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class BoatPhysics implements BoatState {
  readonly id: number;
  readonly spec: BoatSpec;
  /** Seeded from the boat id so each hull jitters differently but repeatably. */
  private readonly rng: () => number;

  readonly position = new Vector3();
  readonly forward = new Vector3(0, 0, 1);
  readonly up = new Vector3(0, 1, 0);
  readonly right = new Vector3(1, 0, 0);
  readonly velocity = new Vector3();

  forwardSpeed = 0;
  speed = 0;
  lateralSpeed = 0;
  driftAmount = 0;
  boostCharge = 0;
  boostTime = 0;
  airborne = false;
  airTime = 0;
  landingImpact = 0;
  collisionImpact = 0;
  throttleLevel = 0;
  steerLevel = 0;
  submersion = 0;
  pitch = 0;
  roll = 0;

  /** Yaw in radians, 0 = facing +Z. Driven directly by steering. */
  private yaw = 0;
  private yawRate = 0;
  private pitchRate = 0;
  private rollRate = 0;

  /** Vertical velocity is part of `velocity`, kept separate here for clarity. */
  private prevVerticalVelocity = 0;
  /** Vertical acceleration, exported for the rider rig via `verticalAccel`. */
  verticalAccel = 0;

  /** 0..1 how much of the hull is in contact with water this tick. */
  private wetFraction = 0;
  /** Smoothed drift signal so the visuals and camera do not chatter. */
  private driftRaw = 0;
  private driftHeld = false;
  private boostCooldown = 0;
  /** Rolling spray budget so a boat cannot empty the particle pool in one frame. */
  private sprayTimer = 0;

  private readonly startPosition = new Vector3();
  private readonly startYaw: number;

  constructor(id: number, spec: BoatSpec, startPosition: Vector3, startHeading: number) {
    this.id = id;
    this.rng = makeRng(0x9e3779b9 ^ (id * 2654435761));
    this.spec = spec;
    this.position.copy(startPosition);
    this.startPosition.copy(startPosition);
    this.yaw = startHeading;
    this.startYaw = startHeading;
    this.updateBasis();
  }

  // -------------------------------------------------------------------------

  private updateBasis(): void {
    // The basis is built from yaw first, then pitch and roll are applied as
    // rotations about the yawed axes. Doing it in this order means steering
    // always turns the boat about world up, which is what an arcade player
    // expects, while the hull still visually banks and pitches with the water.
    const cy = Math.cos(this.yaw);
    const sy = Math.sin(this.yaw);

    // Flat basis.
    const fx = sy;
    const fz = cy;
    const rx = cy;
    const rz = -sy;

    const cp = Math.cos(this.pitch);
    const sp = Math.sin(this.pitch);
    const cr = Math.cos(this.roll);
    const sr = Math.sin(this.roll);

    // Forward tilts up/down by pitch; positive pitch is nose up.
    this.forward.set(fx * cp, sp, fz * cp).normalize();
    // Right tilts by roll about the forward axis; positive roll drops the
    // starboard side, which is the direction a jet ski leans in a right turn.
    this.right.set(rx * cr, -sr, rz * cr).normalize();

    // Re-orthogonalise. The two expressions above are built from independent
    // small-angle constructions and will not stay perpendicular once pitch and
    // roll are both large, so the basis is squared up from the cross products.
    // Handedness matters: with the bow at local +Z we need right x up = forward
    // for the basis to be right-handed, hence up = forward x right.
    this.up.crossVectors(this.forward, this.right).normalize();
    this.right.crossVectors(this.up, this.forward).normalize();
  }

  /** Transform a hull-local point into world space using the current basis. */
  private localToWorld(local: Vector3, out: Vector3): Vector3 {
    return out
      .copy(this.position)
      .addScaledVector(this.right, local.x)
      .addScaledVector(this.up, local.y)
      .addScaledVector(this.forward, local.z);
  }

  // -------------------------------------------------------------------------

  update(cmd: BoatCommand, ctx: FrameContext, effects: EffectsBus | null): void {
    // Per-frame, non-substepped bookkeeping.
    this.landingImpact = 0;
    this.collisionImpact = 0;
    const dt = ctx.dt;
    const h = dt / SUBSTEPS;

    const throttle = MathUtils.clamp(cmd.throttle, 0, 1);
    const brake = MathUtils.clamp(cmd.brake, 0, 1);
    const steer = MathUtils.clamp(cmd.steer, -1, 1);
    this.throttleLevel += (throttle - this.throttleLevel) * Math.min(1, 8 * dt);
    this.steerLevel += (steer - this.steerLevel) * Math.min(1, 12 * dt);

    const wasAirborne = this.airborne;
    const prevVy = this.velocity.y;

    for (let s = 0; s < SUBSTEPS; s++) {
      this.substep(h, throttle, brake, steer, cmd.drift, ctx.elapsed + s * h);
    }

    // --- landing detection ---------------------------------------------------
    if (wasAirborne && !this.airborne) {
      const impact = Math.max(0, -prevVy);
      this.landingImpact = impact;
      this.onLanding(impact, effects);
    }
    if (!this.airborne) this.airTime = 0;
    else this.airTime += dt;

    // --- boost lifecycle -----------------------------------------------------
    this.updateBoost(dt, cmd.drift, throttle, effects);

    // --- derived read-only state --------------------------------------------
    this.forwardSpeed = this.velocity.dot(this.forward);
    this.lateralSpeed = this.velocity.dot(this.right);
    this.speed = Math.hypot(this.velocity.x, this.velocity.z);
    this.verticalAccel = (this.velocity.y - this.prevVerticalVelocity) / Math.max(dt, 1e-4);
    this.prevVerticalVelocity = this.velocity.y;

    this.emitSpray(dt, effects);
  }

  // -------------------------------------------------------------------------

  private substep(
    h: number,
    throttle: number,
    brake: number,
    steer: number,
    driftHeld: boolean,
    time: number,
  ): void {
    _force.set(0, -GRAVITY * this.spec.mass, 0);
    _torque.set(0, 0, 0);

    // ---- 1. BUOYANCY -------------------------------------------------------
    //
    // Each probe is a damped spring against the water surface. Using six of
    // them rather than one heave force is the entire reason the boat pitches
    // into a trough and rolls on a wave face instead of sliding across the
    // surface like a puck.
    let submergedWeight = 0;
    let deepestSubmersion = 0;
    let pitchTorque = 0;
    let rollTorque = 0;

    for (let i = 0; i < HULL_PROBE_POINTS.length; i++) {
      const local = HULL_PROBE_POINTS[i];
      this.localToWorld(local, _probeWorld);

      // THE HULL DOES NOT FEEL RIPPLES.
      //
      // Sampling the raw surface at a point makes a 5.4 m boat respond to the
      // 8 m chop as violently as to the 112 m swell, and telemetry showed the
      // result plainly: driving *along* the swell — the section that is meant
      // to be the smooth contrast to the jump straight — was airborne 35% of
      // the time, slightly more than driving across it. The airtime was coming
      // entirely from high-frequency chop, so no amount of reducing the swell
      // would have fixed it.
      //
      // A real hull bridges waves much shorter than itself. Averaging three
      // samples spaced +/-1.9 m along the keel reproduces that: it passes the
      // 112 m and 78 m swells essentially untouched (>99%), takes the 26.7 m
      // wave to 94%, the 14.3 m to 80%, and the 8.15 m chop to 46%. The visual
      // surface keeps every ripple; only the forces are filtered.
      const surfaceY = filteredSurface(_probeWorld, this.forward, time);
      const depth = surfaceY - _probeWorld.y;
      if (depth <= 0) continue;

      const weight = HULL_PROBE_WEIGHTS[i];
      submergedWeight += weight;
      deepestSubmersion = Math.max(deepestSubmersion, depth);

      // Vertical speed of the water itself at this probe, by finite difference.
      // Damping against the boat's *absolute* velocity is wrong on a moving
      // sea: a crest rising under the hull is then met with a damping force
      // fighting the lift, which stiffens the ride and pumps energy in at the
      // wrong phase. Damping against velocity *relative to the water* is what
      // makes the boat ride the swell instead of arguing with it.
      const waterVy = (filteredSurface(_probeWorld, this.forward, time + 0.02) - surfaceY) * 50;

      // Velocity of this probe = hull velocity + rotational contribution. The
      // rotational term is what damps pitch/roll oscillation rather than just
      // heave, and without it the hull rings like a bell on every wave.
      // Signs must match the torque conventions below (nose-up pitch is
      // positive, starboard-down roll is positive). Getting either backwards
      // turns the damping term into negative damping and the hull diverges
      // within a second.
      const probeVy =
        this.velocity.y + this.pitchRate * local.z - this.rollRate * local.x - waterVy;

      // Effective depth saturates at roughly one hull draft, because past that
      // no further volume is being displaced. An earlier build clamped at
      // 0.85 m against a stiffness of 14.5, so a probe buried by a crest
      // generated twelve times the boat's weight in lift and fired it 13 m into
      // the air. Real buoyancy is bounded by displaced volume; so is this.
      const effDepth = Math.min(depth, 0.55);

      // Stiffness is expressed per unit of the boat's own weight, so heavy and
      // light hulls float at the same waterline. k = 1/restDepth.
      //
      // 3.2 rather than the 8.3 this started at, because the boat has to float
      // DEEP. A stiff spring settles the keel only 12 cm under, and once
      // planing lift carries most of the weight that drops to under 2 cm — at
      // which point any ripple frees the hull and the boat reads as airborne
      // 40% of a race no matter how small the waves are. Telemetry made this
      // unmistakable: reducing the swell all the way down to Hs 2.9 m barely
      // moved the number, because the swell was never the cause. Floating deep
      // gives the hull margin to be lifted through without leaving the water.
      // 4.6 rather than 3.2: the hull was resting with its origin 7 cm BELOW
      // the surface, so barely a third of it showed and captured frames read as
      // a boat that had sunk with its rider standing on top. 4.6 lifts the
      // resting waterline about 22 cm, which puts the deck clear and the
      // sponsons at the surface where they belong. Kept well below the 8.3 this
      // started at, because that was the value that had the hull skipping off
      // every ripple.
      const buoyForce = effDepth * 4.6 * GRAVITY * this.spec.mass * weight;
      // With k = 3.2 the heave mode sits at 5.6 rad/s, so 4.5 is ~40% of
      // critical: lively enough to ride the swell, damped enough to settle
      // between waves instead of trampolining.
      // Damping tracks stiffness: omega = sqrt(k*g) = 6.7, so 5.4 keeps the
      // same ~40% of critical the 3.2/4.5 pair had.
      const dampForce = -probeVy * 5.4 * this.spec.mass * weight;
      const totalUp = Math.max(0, buoyForce + dampForce);

      _force.y += totalUp;

      // Torque about the hull's own axes. Positive local z (bow) pushing up
      // means nose-up pitch; positive local x (starboard) pushing up means roll
      // to port.
      pitchTorque += totalUp * local.z;
      rollTorque -= totalUp * local.x;
    }

    this.wetFraction = submergedWeight;
    this.submersion = deepestSubmersion;
    this.airborne = submergedWeight < 0.02;

    // ---- 2. PLANING --------------------------------------------------------
    //
    // Above a threshold speed the hull climbs onto its own bow wave and rides
    // higher. Modelled as extra lift that grows with speed and falls away with
    // how far above the surface the boat already is. The difference between
    // wallowing at low speed and skating at pace is a large part of "weighty".
    if (submergedWeight > 0) {
      const planingSpeed = MathUtils.clamp((this.forwardSpeed - 6) / 18, 0, 1);
      // Capped well below the boat's own weight. Planing lift makes a hull ride
      // *higher in the water*; it is not a wing. At 5.6x weight the boat simply
      // flew. Even at 0.85x it carried so much of the weight that the hull sat
      // almost on the surface and skipped off every ripple, so it is held at
      // half: enough that the boat visibly rises and loosens as it comes up on
      // the plane, not enough to lift the keel out.
      const lift = planingSpeed * planingSpeed * 0.5 * GRAVITY * this.spec.mass * submergedWeight;
      _force.y += lift;
      // Planing lifts the bow: the pressure centre moves aft as she climbs.
      pitchTorque += lift * 0.42;
    }

    // ---- 3. THRUST ---------------------------------------------------------
    //
    // No thrust in the air. A jet drive out of the water is just an engine
    // making noise, and cutting it is what makes a jump feel committed rather
    // than like a floaty hover.
    //
    // Wetness is derived from how much of the HULL is in the water, not from
    // the depth of the intake point itself. The intake sits at the design
    // waterline by definition, so testing its own depth is a knife-edge: a
    // normally-floating boat measured 2.5% wet and lost 97% of its thrust. The
    // multiplier means the drive still bites while the hull is half out of the
    // water on a crest, and only cuts out once it is genuinely airborne.
    const thrustWet = MathUtils.clamp(this.wetFraction * 2.2, 0, 1);

    // Boost is a straight thrust multiplier. Because drag is quadratic, a 1.6x
    // thrust raises terminal velocity by sqrt(1.6) = 1.26x, which is a real
    // shove without turning the boost into a separate top speed.
    const boostMul = this.boostTime > 0 ? 1.6 : 1;

    const thrust = throttle * this.spec.acceleration * this.spec.mass * thrustWet * boostMul;
    _force.addScaledVector(this.forward, thrust);

    // Reverse and braking. Braking bites much harder than reverse thrust.
    if (brake > 0) {
      const brakeForce = this.forwardSpeed > 0.5 ? brake * 11.5 : brake * 3.2;
      _force.addScaledVector(this.forward, -brakeForce * this.spec.mass * thrustWet);
      // Braking buries the bow.
      pitchTorque -= brake * thrustWet * 2600;
    }

    // ---- 4. DRAG -----------------------------------------------------------
    //
    // Longitudinal and lateral drag are wildly different, and the ratio between
    // them IS the handling model. High lateral drag = the boat tracks; low
    // lateral drag = it slides. The drift button simply collapses that ratio.
    const fwdVel = this.velocity.dot(this.forward);
    const latVel = this.velocity.dot(this.right);

    const inWater = this.airborne ? 0.06 : Math.max(0.25, this.wetFraction);

    // Quadratic longitudinal drag, with the coefficient derived rather than
    // guessed: setting c = acceleration / topSpeed^2 makes thrust and drag
    // balance at exactly `topSpeed`, and the resulting v(t) = vTop * tanh(a*t /
    // vTop) reaches 95% of top speed in 1.83 * vTop / a seconds. So the two
    // numbers in BoatSpec directly control the two things a driver feels —
    // how fast it ends up and how long it takes to get there — with no third
    // fudge factor in between.
    const dragC = this.spec.acceleration / (this.spec.topSpeed * this.spec.topSpeed);
    const fwdDrag = -Math.sign(fwdVel) * fwdVel * fwdVel * dragC * inWater;
    _force.addScaledVector(this.forward, fwdDrag * this.spec.mass);

    // Lateral grip. `slidiness` is the boat's baseline; drift scales it down
    // hard. The linear-plus-quadratic mix gives grip that lets go progressively
    // rather than snapping from stuck to loose.
    const gripBase = MathUtils.lerp(9.5, 3.2, this.spec.slidiness);
    // The drift floor is deliberately not near-zero. At 1.05 the hull reached
    // 51 degrees of slip and scrubbed nearly half its speed in a single corner,
    // which reads as a spin rather than a powerslide. 2.6 lands the slide in
    // the 20-30 degree range where the boat is visibly sideways but still
    // driving forwards.
    const grip = MathUtils.lerp(gripBase, 4.3, this.driftAmount) * inWater;
    const latDrag = -latVel * grip - Math.sign(latVel) * latVel * latVel * 0.16 * inWater;
    _force.addScaledVector(this.right, latDrag * this.spec.mass);

    // Vertical drag when submerged, so the hull does not bob forever.
    if (!this.airborne) _force.y += -this.velocity.y * 1.6 * this.spec.mass * this.wetFraction;

    // ---- 5. STEERING -------------------------------------------------------
    //
    // Yaw authority as a function of speed is the signature curve of the whole
    // game. It must be near zero at rest (a rudder needs flow over it), peak in
    // the mid range where the racing happens, and ease off at the top so the
    // boat feels heavy flat out. A flat curve makes the boat feel like a
    // hovercraft; a monotonic one makes it twitchy at speed.
    const sp = Math.abs(this.forwardSpeed);
    const flow = MathUtils.clamp(sp / 9.0, 0, 1); // rudder authority ramps in
    const heaviness = 1 - MathUtils.clamp((sp - 20) / 30, 0, 1) * 0.34;
    let yawAuthority = this.spec.turnRate * flow * heaviness;

    // Drifting unlocks extra rotation, which is what makes the slide feel like
    // the boat pivoting rather than merely understeering wider.
    yawAuthority *= 1 + this.driftAmount * 0.62;

    // Airborne: almost no authority, but not zero. A little air-steer lets the
    // player line up a landing and feels good; full authority feels like a
    // spaceship.
    if (this.airborne) yawAuthority *= 0.16;

    // Reverse steering inverts, like a real boat.
    const dir = this.forwardSpeed < -0.4 ? -1 : 1;
    const targetYawRate = steer * yawAuthority * dir;
    // Rate-limit the yaw so the hull has rotational mass instead of snapping.
    const yawResponse = this.airborne ? 2.2 : 5.6;
    this.yawRate += (targetYawRate - this.yawRate) * Math.min(1, yawResponse * h);
    this.yaw += this.yawRate * h;

    // A boat that yaws also gets pushed sideways by its own hull: the stern
    // kicks out. This is what converts steering input into the lateral velocity
    // that the drift system then plays with.
    const sternKick = this.yawRate * sp * (0.42 - this.driftAmount * 0.10) * inWater;
    _force.addScaledVector(this.right, sternKick * this.spec.mass * 0.55);

    // ---- 6. ANGULAR INTEGRATION -------------------------------------------
    if (this.airborne) {
      // In the air, keep whatever rotation the launch imparted — this is what
      // lets a crest throw the nose up and the player ride it out — but bleed
      // it slowly and add a weak auto-level so a bad launch is recoverable
      // rather than a guaranteed crash.
      this.pitchRate *= Math.exp(-0.55 * h);
      this.rollRate *= Math.exp(-0.9 * h);
      this.pitchRate += -this.pitch * 1.35 * h;
      this.rollRate += -this.roll * 2.4 * h;
    } else {
      const pitchAccel = pitchTorque / (this.spec.mass * HULL_PITCH_INERTIA);
      const rollAccel = rollTorque / (this.spec.mass * HULL_ROLL_INERTIA);
      // Gravity's restoring moment is already implicit in the probe forces, so
      // these accelerations only need damping to stop them ringing.
      this.pitchRate += pitchAccel * h;
      this.rollRate += rollAccel * h;
      this.pitchRate *= Math.exp(-2.9 * h);
      this.rollRate *= Math.exp(-3.4 * h);

      // Leaning into a turn: an arcade flourish on top of the simulated roll.
      // The hull banks *into* the corner like a jet ski, not out of it — a
      // physically-correct planing boat leans outboard, which looks wrong here.
      const bankTarget = this.steerLevel * MathUtils.clamp(sp / 20, 0, 1) * 0.30;
      this.rollRate += (bankTarget - this.roll) * 7.5 * h;
    }

    this.pitch = MathUtils.clamp(this.pitch + this.pitchRate * h, -0.85, 0.85);
    this.roll = MathUtils.clamp(this.roll + this.rollRate * h, -0.75, 0.75);

    // ---- 7. LINEAR INTEGRATION (semi-implicit Euler) -----------------------
    _v.copy(_force).multiplyScalar(h / this.spec.mass);
    this.velocity.add(_v);
    this.position.addScaledVector(this.velocity, h);

    // Hard floor: never let the hull sink through the world.
    sampleOcean(this.position.x, this.position.z, time, _sample);
    const floor = _sample.height - 1.4;
    if (this.position.y < floor) {
      this.position.y = floor;
      if (this.velocity.y < 0) this.velocity.y *= -0.15;
    }

    this.updateBasis();
  }

  // -------------------------------------------------------------------------

  /**
   * Drift and boost.
   *
   * The loop is: hold drift through a corner, the hull unsticks, charge builds
   * in proportion to how sideways you actually are (not merely to how long you
   * held the button — that would reward holding it on a straight), release with
   * enough charge and you get a real shove. The payoff has to be a shove; a
   * gentle nudge makes the whole mechanic pointless.
   */
  private updateBoost(
    dt: number,
    driftInput: boolean,
    throttle: number,
    effects: EffectsBus | null,
  ): void {
    const sp = Math.abs(this.forwardSpeed);
    const canDrift = driftInput && throttle > 0.25 && sp > 9 && !this.airborne;

    // The *input* is tracked separately from whether a drift is currently
    // possible. Clipping a crest mid-corner makes `canDrift` false for a few
    // frames, and an earlier build treated that as the player letting go — so
    // every jump taken during a slide silently threw away the boost charge and
    // fired a stunted boost at a moment nobody asked for. Only an actual
    // release of the button counts as a release.
    const inputHeld = driftInput && throttle > 0.25;

    // Raw drift target: you must be both asking for it and actually turning.
    const steering = Math.abs(this.steerLevel);
    this.driftRaw = canDrift ? MathUtils.clamp(steering * 1.35, 0, 1) : 0;
    // Asymmetric smoothing: the hull lets go quickly and grips back slowly, so
    // initiating a slide feels like a snap and exiting feels like it settles.
    const k = this.driftRaw > this.driftAmount ? 7.5 : 3.0;
    this.driftAmount += (this.driftRaw - this.driftAmount) * Math.min(1, k * dt);
    if (this.driftAmount < 0.004) this.driftAmount = 0;

    if (this.boostCooldown > 0) this.boostCooldown -= dt;

    if (canDrift) {
      // Charge rate follows the slip angle: a lazy four-wheel-drift earns less
      // than a committed sideways slide at the same steering input.
      const slipAngle = Math.abs(Math.atan2(this.lateralSpeed, Math.max(sp, 1)));
      const rate = MathUtils.clamp(slipAngle / 0.42, 0, 1) * 1.15 + this.driftAmount * 0.25;
      const before = this.boostCharge;
      this.boostCharge = Math.min(1, this.boostCharge + rate * dt);
      if (before < 1 && this.boostCharge >= 1) effects?.flash(PALETTE.racingLine, 0.10);
      this.driftHeld = true;
    } else if (inputHeld && this.driftHeld) {
      // Held, but momentarily unable to drift (airborne, or too slow). Hold the
      // charge where it is rather than banking or dumping it.
    } else if (this.driftHeld) {
      // Released.
      this.driftHeld = false;
      if (this.boostCharge > 0.28 && this.boostCooldown <= 0) {
        this.boostTime = 0.55 + this.boostCharge * 1.35;
        this.boostCooldown = 0.35;
        effects?.shake(0.28 + this.boostCharge * 0.3, 30);
        effects?.flash(PALETTE.racer[this.spec.colorIndex], 0.16);
      }
      this.boostCharge = 0;
    } else {
      // Charge bleeds away if you do not cash it in, so it cannot be banked
      // across half a lap.
      this.boostCharge = Math.max(0, this.boostCharge - dt * 0.22);
    }

    if (this.boostTime > 0) this.boostTime = Math.max(0, this.boostTime - dt);
  }

  // -------------------------------------------------------------------------

  private onLanding(impactSpeed: number, effects: EffectsBus | null): void {
    if (impactSpeed < 1.2) return;

    // A landing that is badly misaligned with the direction of travel scrubs
    // speed. Landing flat and straight after a big jump should be rewarded.
    const vLen = this.velocity.length();
    const align = vLen > 0.01 ? this.forward.dot(_tmp.copy(this.velocity).divideScalar(vLen)) : 1;
    const misalign = 1 - MathUtils.clamp(align, 0, 1);
    const penalty = MathUtils.clamp(misalign * 1.6 + Math.abs(this.roll) * 0.7, 0, 0.55);
    this.velocity.multiplyScalar(1 - penalty * 0.42);

    // Drive the hull down into the water so the recovery reads as a real slam.
    this.pitchRate += (this.rng() - 0.5) * impactSpeed * 0.06;

    const strength = MathUtils.clamp(impactSpeed / 12, 0, 1);
    effects?.shake(0.18 + strength * 0.95, 26);
    if (strength > 0.55) effects?.flash(PALETTE.foam, 0.13 * strength);

    if (effects) {
      for (const p of SPRAY_POINTS) {
        this.localToWorld(p, _tmp);
        // Upward velocity is deliberately modest. An earlier build threw
        // droplets at up to 11 m/s, which under gravity is a six metre arc,
        // and with a 1.5 s life they hung there: a captured frame showed forty
        // ink-outlined blobs scattered across the sky well above the horizon,
        // reading as cartoon smoke puffs rather than water. Spray off a hull
        // belongs in the metre or two above the surface, and it should be gone
        // before the boat has travelled its own length.
        effects.spray({
          position: _tmp.clone(),
          velocity: new Vector3(
            this.velocity.x * 0.30 + (this.rng() - 0.5) * 3,
            1.7 + strength * 4.0,
            this.velocity.z * 0.30 + (this.rng() - 0.5) * 3,
          ),
          count: Math.round(10 + strength * 30),
          spread: 0.8 + strength * 1.5,
          size: 0.12 + strength * 0.13,
          // A landing plume is thrown harder than running spray, so it needs
          // proportionally longer to fall back. Same rule: the arc has to close
          // inside the lifetime or the plume hangs.
          life: 0.55 + strength * 0.55,
        });
      }
    }
  }

  /**
   * Continuous spray from the bow at speed and from the outside of a slide.
   * Rate-limited on a timer rather than emitted every frame, so the particle
   * budget is spent on visible bursts instead of a fine permanent mist.
   */
  private emitSpray(dt: number, effects: EffectsBus | null): void {
    if (!effects || this.airborne) return;
    this.sprayTimer -= dt;
    if (this.sprayTimer > 0) return;

    const speedT = MathUtils.clamp(this.speed / this.spec.topSpeed, 0, 1);
    const slide = MathUtils.clamp(Math.abs(this.lateralSpeed) / 9, 0, 1);
    const intensity = speedT * 0.6 + slide * 0.9;
    if (intensity < 0.18) {
      this.sprayTimer = 0.12;
      return;
    }

    this.sprayTimer = MathUtils.lerp(0.14, 0.045, MathUtils.clamp(intensity, 0, 1));

    // Bow spray goes outboard and up; slide spray comes off the loaded side.
    const side = this.lateralSpeed > 0 ? -1 : 1;
    const p = slide > 0.35 ? SPRAY_POINTS[side > 0 ? 1 : 0] : SPRAY_POINTS[this.rng() < 0.5 ? 0 : 1];
    this.localToWorld(p, _tmp);

    effects.spray({
      position: _tmp.clone(),
      velocity: new Vector3(
        this.velocity.x * 0.22 + this.right.x * side * (1.5 + slide * 5.0),
        1.0 + intensity * 1.9,
        this.velocity.z * 0.22 + this.right.z * side * (1.5 + slide * 5.0),
      ),
      count: Math.round(3 + intensity * 8),
      spread: 0.45 + slide * 1.1,
      size: 0.09 + intensity * 0.08,
      // Long enough for the droplet to come back down and hit the water, which
      // is what ends it. At the old 0.30-0.56 s most of a burst expired at the
      // top of its climb, so the spray never fell and every action frame had a
      // band of white blobs suspended over open water.
      life: 0.42 + intensity * 0.34,
    });
  }

  // -------------------------------------------------------------------------

  /**
   * Boat-to-boat contact as circle separation with an impulse exchange.
   *
   * Deliberately forgiving: contact pushes racers apart and scrubs a little
   * speed, but never spins anyone out. Four arcade boats fighting for a corner
   * need contact to be readable and survivable, not accurate.
   */
  resolveBoatCollision(other: BoatPhysics): void {
    _tmp.subVectors(other.position, this.position);
    _tmp.y = 0;
    const dist = _tmp.length();
    const minDist = HULL_COLLISION_RADIUS * 2;
    if (dist >= minDist || dist < 1e-4) return;

    _tmp.divideScalar(dist);
    const overlap = minDist - dist;

    // Positional correction, split by mass so the heavier boat moves less.
    const totalMass = this.spec.mass + other.spec.mass;
    const myShare = other.spec.mass / totalMass;
    this.position.addScaledVector(_tmp, -overlap * myShare);
    other.position.addScaledVector(_tmp, overlap * (1 - myShare));

    // Impulse along the contact normal, only for the closing component.
    _v.subVectors(other.velocity, this.velocity);
    const closing = _v.dot(_tmp);
    if (closing > 0) return;

    const restitution = 0.28;
    const j = (-(1 + restitution) * closing) / (1 / this.spec.mass + 1 / other.spec.mass);
    this.velocity.addScaledVector(_tmp, -j / this.spec.mass);
    other.velocity.addScaledVector(_tmp, j / other.spec.mass);

    // A glancing blow should also knock the boats off line, or contact reads as
    // two billiard balls rather than two hulls scraping.
    const lateral = _tmp.dot(this.right);
    this.yawRate += lateral * 0.55;
    other.yawRate -= lateral * 0.55;

    const impact = Math.abs(closing);
    this.collisionImpact = Math.max(this.collisionImpact, impact);
    other.collisionImpact = Math.max(other.collisionImpact, impact);
  }

  // -------------------------------------------------------------------------

  /** Place the boat back on the water, upright, pointing along `heading`. */
  respawn(position?: Vector3, heading?: number, time = 0): void {
    this.position.copy(position ?? this.startPosition);
    sampleOcean(this.position.x, this.position.z, time, _sample);
    this.position.y = _sample.height + 0.35;
    this.yaw = heading ?? this.startYaw;
    this.velocity.set(0, 0, 0);
    this.yawRate = 0;
    this.pitchRate = 0;
    this.rollRate = 0;
    this.pitch = 0;
    this.roll = 0;
    this.boostCharge = 0;
    this.boostTime = 0;
    this.driftAmount = 0;
    this.driftRaw = 0;
    this.airborne = false;
    this.airTime = 0;
    this.updateBasis();
  }

  /** Drop the boat onto the water surface without changing heading. */
  settleOnWater(time: number): void {
    sampleOcean(this.position.x, this.position.z, time, _sample);
    this.position.y = _sample.height + 0.12;
    this.velocity.set(0, 0, 0);
    this.updateBasis();
  }

  /** Current heading in radians, for the minimap and the AI. */
  get heading(): number {
    return this.yaw;
  }

  /**
   * Orientation as a quaternion, for the visual boat.
   *
   * Built straight from the orthonormal basis rather than from Euler angles:
   * the basis is already the answer, and converting through yaw/pitch/roll
   * would reintroduce exactly the ordering ambiguity that building the basis by
   * hand avoids. The bow is local +Z, so `forward` is the basis' Z column.
   */
  getQuaternion(out: Quaternion = _q): Quaternion {
    _m4.makeBasis(this.right, this.up, this.forward);
    return out.setFromRotationMatrix(_m4);
  }
}

const _m4 = new Matrix4();
