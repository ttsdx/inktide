import { Vector3 } from 'three';
import type { BoatCommand, BoatState, CoursePoint, FrameContext, RacerProgress } from '../contracts.ts';
import type { Course } from './Course.ts';

/**
 * OPPONENT AI
 *
 * A pure controller: it reads `BoatState` and returns a `BoatCommand`, and it
 * never touches the simulation. Everything it knows about the world comes from
 * the course spline, the other boats' states and its own memory.
 *
 * STEERING — why lookahead scales with speed
 *
 * A fixed-distance aim point does not work at both ends of the speed range. At
 * 12 m/s through the hairpin a 60 m aim point is around the corner and behind a
 * pylon; at 40 m/s down the Windward Run a 20 m aim point is a metre and a half
 * of arc, so the controller chases noise and the boat weaves. Scaling the
 * lookahead as `base + speed * tau` makes it a constant *time* horizon, which
 * is the quantity that actually matters: it is how far ahead the boat can still
 * do something about what it sees.
 *
 * `tau` is around 0.5 s. That is deliberately just under the boat's yaw time
 * constant, so the aim point is always slightly inside what the hull can
 * achieve and the controller is never asking for a turn it cannot make.
 *
 * The derivative term exists purely to kill weave. A proportional-only
 * controller on a second-order plant (steering commands yaw *rate*, yaw rate
 * integrates to heading) oscillates; the D term is the damping. It is taken on
 * a low-passed error derivative because the raw one is dominated by wave-induced
 * heading jitter, and feeding that straight into the steering makes the boat
 * twitch on every crest.
 *
 * SPEED — why braking is computed from a distance, not a curvature threshold
 *
 * "If the curvature 40 m ahead is over X, brake" gets the hairpin wrong at
 * every speed except the one it was tuned at. Instead the controller scans the
 * curvature horizon, converts each sample to the speed the corner will hold
 * (`v = sqrt(aLat / kappa)`), and asks the only question that matters: is the
 * distance to that sample less than the distance needed to slow down to that
 * speed? That is the standard `d = (v^2 - vc^2) / (2a)` braking-point
 * calculation, and it self-corrects for personality, for rubber-banding and for
 * whatever top speed the hull happens to have.
 *
 * DETERMINISM
 *
 * Every random decision comes from a seeded `mulberry32` owned by the
 * controller, advanced only from `update`. Given the same states in the same
 * order, a race replays identically, which is what the screenshot harness needs
 * to be able to frame a shot on lap two.
 */

// ---------------------------------------------------------------------------
// PRNG
// ---------------------------------------------------------------------------

/**
 * mulberry32. Chosen over `Math.random` because it is seedable, and over an
 * LCG because the low bits of an LCG are badly non-random and the AI samples
 * small probabilities every frame — exactly the regime where an LCG's low-bit
 * structure would turn "a mistake every 20 seconds" into "a mistake every 20
 * seconds, always on the same corner".
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Personality
// ---------------------------------------------------------------------------

export interface AIPersonality {
  readonly name: string;

  // --- steering ---
  /** Metres of lookahead at a standstill. */
  lookaheadBase: number;
  /** Extra lookahead per m/s of speed. Effectively a time horizon in seconds. */
  lookaheadPerSpeed: number;
  /** Proportional steering gain, steer units per radian of heading error. */
  steerP: number;
  /** Derivative gain on the low-passed error rate. */
  steerD: number;
  /** Cutoff for the error-rate low pass, Hz. Lower = smoother, laggier. */
  steerFilterHz: number;

  // --- line ---
  /** Fraction of the corridor half-width the AI cuts towards the apex. */
  apexBias: number;
  /** Fraction it runs wide on the way in to a corner. */
  entryBias: number;
  /** Constant lateral preference, in corridor fractions. Separates the field. */
  lineOffset: number;
  /** Amplitude of the slow wander, in corridor fractions. */
  wanderAmount: number;
  /** Wander frequency, Hz. */
  wanderHz: number;

  // --- speed ---
  /** Lateral acceleration the AI believes it can hold, m/s^2. */
  lateralBudget: number;
  /** Longitudinal deceleration it plans braking around, m/s^2. */
  brakeDecel: number;
  /**
   * Scale on the required braking distance. Below 1 is late braking — it will
   * overshoot corners and have to correct, which is what makes it exciting.
   */
  brakePointScale: number;
  /** Fraction of top speed it will not drop below in a corner. */
  minCornerFraction: number;

  // --- drift and boost ---
  /** Curvature above which it holds the drift button, 1/m. */
  driftCurvature: number;
  /** Extra steering it dials in while drifting, to hold the slide. */
  driftSteerGain: number;
  /** Curvature below which it considers itself on a straight, for boosting. */
  boostCurvature: number;
  /** Boost charge it waits for before firing. */
  boostChargeThreshold: number;

  // --- interaction ---
  /** 0..1 willingness to hold a line alongside another boat. */
  aggression: number;
  /** Metres of clearance it wants when passing. */
  clearance: number;

  // --- fallibility ---
  /** Expected mistakes per second. */
  mistakeRate: number;
  /** Seconds a mistake lasts. */
  mistakeDuration: number;
  /** Seconds of degraded recovery after a mistake. */
  recoveryDuration: number;

  // --- rubber band ---
  /** 0..1 scale on the +-8% pace band. 0 disables it. */
  rubberBand: number;
}

/** Shared baseline; the presets below override selectively. */
const BASE: AIPersonality = {
  name: 'base',
  lookaheadBase: 13,
  lookaheadPerSpeed: 0.52,
  steerP: 1.55,
  steerD: 0.34,
  steerFilterHz: 6,
  apexBias: 0.55,
  entryBias: 0.45,
  lineOffset: 0,
  wanderAmount: 0.06,
  wanderHz: 0.11,
  lateralBudget: 8.2,
  brakeDecel: 11,
  brakePointScale: 1.0,
  minCornerFraction: 0.32,
  driftCurvature: 0.0085,
  driftSteerGain: 0.3,
  boostCurvature: 0.003,
  boostChargeThreshold: 0.55,
  aggression: 0.5,
  clearance: 4.2,
  mistakeRate: 1 / 26,
  mistakeDuration: 1.1,
  recoveryDuration: 1.4,
  rubberBand: 1,
};

/**
 * Brakes at the last possible moment, clips apexes hard, holds a drift through
 * anything that will take one, and will sit alongside you rather than lift.
 * The `brakePointScale` under 1 means it genuinely overshoots sometimes — that
 * is the intended character, not a bug to tune out.
 */
export const AI_AGGRESSIVE: AIPersonality = {
  ...BASE,
  name: 'aggressive',
  lookaheadBase: 11,
  lookaheadPerSpeed: 0.44,
  steerP: 1.95,
  steerD: 0.3,
  apexBias: 0.86,
  entryBias: 0.22,
  lineOffset: -0.1,
  wanderAmount: 0.03,
  lateralBudget: 9.1,
  brakeDecel: 13,
  brakePointScale: 0.84,
  minCornerFraction: 0.36,
  driftCurvature: 0.0055,
  driftSteerGain: 0.42,
  // Fires it early and into a bend it has not finished yet, on a small charge.
  // Frequently the fastest way through the Leeward Drag and occasionally the
  // reason it arrives at the Coral Turn with no brakes left.
  boostCurvature: 0.0052,
  boostChargeThreshold: 0.4,
  aggression: 0.95,
  clearance: 2.6,
  mistakeRate: 1 / 21,
  mistakeDuration: 1.25,
};

/**
 * Wide entry, tight exit, smooth inputs, almost no mistakes. Slightly lower
 * cornering budget than the aggressive preset but a much higher *average*
 * because it never has to correct. This is the one that beats you on lap three.
 */
export const AI_CLEAN: AIPersonality = {
  ...BASE,
  name: 'clean',
  lookaheadBase: 16,
  lookaheadPerSpeed: 0.6,
  steerP: 1.35,
  steerD: 0.44,
  steerFilterHz: 4.5,
  apexBias: 0.62,
  entryBias: 0.78,
  lineOffset: 0.05,
  wanderAmount: 0.02,
  lateralBudget: 8.0,
  brakeDecel: 10.5,
  brakePointScale: 1.14,
  minCornerFraction: 0.34,
  driftCurvature: 0.011,
  driftSteerGain: 0.24,
  // Banks a near-full charge and spends it only on a genuine straight, so it
  // gets the whole boost duration at full throttle instead of half of it into a
  // corner. Slower to deploy, more total distance gained.
  boostCurvature: 0.0018,
  boostChargeThreshold: 0.72,
  aggression: 0.35,
  clearance: 5.4,
  mistakeRate: 1 / 70,
  mistakeDuration: 0.8,
  recoveryDuration: 1.0,
};

/**
 * Wanders off line, changes pace for no reason, occasionally strings together a
 * lap nobody can match and occasionally arrives at the chicane doing 38.
 * `paceWander` in the controller gives this one a slow sinusoidal pace drift on
 * top of the rubber band.
 */
export const AI_ERRATIC: AIPersonality = {
  ...BASE,
  name: 'erratic',
  lookaheadBase: 12,
  lookaheadPerSpeed: 0.5,
  steerP: 1.75,
  steerD: 0.24,
  steerFilterHz: 8,
  apexBias: 0.5,
  entryBias: 0.3,
  lineOffset: 0.16,
  wanderAmount: 0.3,
  wanderHz: 0.19,
  lateralBudget: 8.6,
  brakeDecel: 11.5,
  brakePointScale: 0.95,
  minCornerFraction: 0.3,
  driftCurvature: 0.007,
  driftSteerGain: 0.36,
  // The loosest definition of "straight" of the three, which is most of why it
  // sometimes arrives at the chicane far too fast.
  boostCurvature: 0.0065,
  boostChargeThreshold: 0.5,
  aggression: 0.62,
  clearance: 3.4,
  mistakeRate: 1 / 11,
  mistakeDuration: 1.6,
  recoveryDuration: 1.9,
};

/**
 * Grid order for the three opponents. Index 0 is unused (the player), so
 * `AI_PRESETS[boatId]` reads naturally at the call site.
 */
export const AI_PRESETS: readonly AIPersonality[] = [
  AI_CLEAN,
  AI_AGGRESSIVE,
  AI_CLEAN,
  AI_ERRATIC,
];

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

type MistakeKind = 'none' | 'lateBrake' | 'wideEntry' | 'botchedDrift' | 'bogged';

/** Metres of curvature horizon scanned for braking, at minimum. */
const HORIZON_MIN = 55;
/** Seconds of curvature horizon scanned for braking. */
const HORIZON_SECONDS = 2.6;
/** Samples in the braking scan. */
const HORIZON_SAMPLES = 14;

/** Rubber band authority. +-8% of pace, per the brief. */
const RUBBER_BAND_RANGE = 0.08;
/**
 * Gap at which the rubber band saturates, metres. 260 m is roughly a tenth of a
 * lap: inside that the band is doing almost nothing, beyond it the trailing AI
 * is running at its full +8% and the leader has eased to -8%.
 */
const RUBBER_BAND_SATURATION = 260;

const _aim = new Vector3();
const _toAim = new Vector3();
const _rel = new Vector3();

export class AIController {
  readonly boatId: number;
  readonly personality: AIPersonality;

  /**
   * Advisory boost request. `BoatCommand` has no boost channel, so the
   * controller publishes its intent here for whatever owns the boost to read.
   * It is set on the frame the AI would have pressed the button.
   */
  wantsBoost = false;

  /** Currently active mistake, exposed for debug overlays. */
  mistake: MistakeKind = 'none';

  private readonly course: Course;
  private readonly rng: () => number;
  private readonly command: BoatCommand = { throttle: 0, brake: 0, steer: 0, drift: false };

  private readonly aheadPoint: CoursePoint;
  private readonly nearPoint: CoursePoint;

  private hintT = 0;
  private prevHeadingError = 0;
  private filteredErrorRate = 0;
  private steerSmoothed = 0;
  private throttleSmoothed = 1;

  /** Lateral offset the AI is currently holding, in metres. Rate limited. */
  private lateralTarget = 0;
  /** Extra offset held while side by side with someone. */
  private holdOffset = 0;

  private mistakeTimer = 0;
  private recoveryTimer = 0;
  /** Sign flip applied to the racing-line offset during a wide-entry mistake. */
  private mistakeSign = 1;
  private wanderPhase = 0;
  private pacePhase = 0;

  constructor(boatId: number, course: Course, personality: AIPersonality) {
    this.boatId = boatId;
    this.course = course;
    this.personality = personality;
    // Fold the boat id into the seed so two boats with the same personality do
    // not make the same mistakes at the same corner.
    this.rng = mulberry32(0x51ed270b ^ (boatId * 0x9e3779b1));
    this.aheadPoint = course.sample(0);
    this.nearPoint = course.sample(0);
    // Stagger the wander and pace oscillators so the field does not breathe in
    // unison; deterministic, from the seeded generator.
    this.wanderPhase = this.rng() * Math.PI * 2;
    this.pacePhase = this.rng() * Math.PI * 2;
  }

  /** Drop the projection hint and all filters. Call on a race reset. */
  reset(): void {
    this.hintT = 0;
    this.prevHeadingError = 0;
    this.filteredErrorRate = 0;
    this.steerSmoothed = 0;
    this.throttleSmoothed = 1;
    this.lateralTarget = 0;
    this.holdOffset = 0;
    this.mistakeTimer = 0;
    this.recoveryTimer = 0;
    this.mistake = 'none';
  }

  update(
    state: BoatState,
    allStates: readonly BoatState[],
    progress: RacerProgress,
    playerProgress: RacerProgress,
    ctx: FrameContext,
  ): BoatCommand {
    const P = this.personality;
    const dt = Math.max(ctx.dt, 1e-4);
    const speed = state.speed;
    const topSpeed = Math.max(state.spec.topSpeed, 1);

    // Reuse the director's projection when it is fresh, otherwise re-project
    // locally. Either way this is the O(1) hinted path.
    const t = this.course.closestT(state.position, this.hintT || progress.lapProgress);
    this.hintT = t;

    // -----------------------------------------------------------------------
    // 1. PACE — rubber band plus, for the erratic preset, a slow drift
    // -----------------------------------------------------------------------
    this.pacePhase += dt * 0.09;
    const gap = (playerProgress.totalProgress - progress.totalProgress) * this.course.length;
    // Positive gap means the player is ahead, so the AI pushes; negative means
    // the AI is leading, so it eases. Both directions, as required — a runaway
    // leader has to come back to you.
    const band = clamp(gap / RUBBER_BAND_SATURATION, -1, 1) * RUBBER_BAND_RANGE * P.rubberBand;
    const wanderPace = P.wanderAmount > 0.2 ? Math.sin(this.pacePhase + this.pacePhase) * 0.05 : 0;
    const pace = 1 + band + wanderPace;

    // -----------------------------------------------------------------------
    // 2. MISTAKES
    // -----------------------------------------------------------------------
    this.tickMistakes(dt, speed, topSpeed);

    // -----------------------------------------------------------------------
    // 3. LINE — where on the corridor to aim
    // -----------------------------------------------------------------------
    const lookahead = clamp(
      P.lookaheadBase + speed * P.lookaheadPerSpeed,
      P.lookaheadBase,
      140,
    );
    const aheadT = this.course.advance(t, lookahead);
    this.course.sampleInto(aheadT, this.aheadPoint);
    this.course.sampleInto(t, this.nearPoint);

    const kAhead = this.course.signedCurvatureAt(aheadT);
    // Curvature a little further out again, to detect *approaching* a corner as
    // opposed to being in one. Entry width is a function of what is coming, not
    // of what is under the hull.
    const kEntry = this.course.peakCurvatureAhead(aheadT, Math.max(40, lookahead));

    let offsetFraction = P.lineOffset;

    // Apex: the inside of the corner is the side the track curves towards, i.e.
    // the sign of the signed curvature (positive curves towards the left
    // normal), so clipping the apex means offsetting *with* that sign.
    const cornering = Math.min(1, Math.abs(kAhead) / 0.006);
    offsetFraction += Math.sign(kAhead) * P.apexBias * cornering;

    // Entry: while the corner is still ahead of the aim point, sit on the
    // outside. This is what produces a visible wide-in/tight-out arc rather than
    // four boats tracking the same centreline.
    const approaching = clamp(
      (Math.abs(kEntry) - Math.abs(kAhead)) / 0.005,
      0,
      1,
    );
    offsetFraction -= Math.sign(kEntry) * P.entryBias * approaching;

    // Slow wander. On the erratic preset this is large enough to genuinely cost
    // it time; on the clean preset it is barely there.
    this.wanderPhase += dt * P.wanderHz * Math.PI * 2;
    offsetFraction += Math.sin(this.wanderPhase) * P.wanderAmount;

    if (this.mistake === 'wideEntry') offsetFraction += this.mistakeSign * 1.15;

    // -----------------------------------------------------------------------
    // 4. COLLISION AVOIDANCE
    // -----------------------------------------------------------------------
    const avoid = this.avoidance(state, allStates, dt);
    offsetFraction += avoid.offsetFraction;

    // Convert to metres and rate limit. An instantaneous jump in the target
    // offset shows up as a steering spike; 22 m/s of lateral target movement is
    // faster than any hull can follow but slow enough to filter the jump.
    const halfWidth = this.aheadPoint.width;
    // Leave a hull's width of margin so an apex-clipping AI does not park itself
    // on the buoy line every corner.
    const maxOffset = Math.max(0, halfWidth - 2.4);
    const wantOffset = clamp(offsetFraction * halfWidth, -maxOffset, maxOffset);
    const slew = 22 * dt;
    this.lateralTarget += clamp(wantOffset - this.lateralTarget, -slew, slew);

    _aim
      .copy(this.aheadPoint.position)
      .addScaledVector(this.aheadPoint.normal, this.lateralTarget);

    // -----------------------------------------------------------------------
    // 5. STEERING
    // -----------------------------------------------------------------------
    _toAim.subVectors(_aim, state.position).setY(0);
    // Signed heading error via cross/dot rather than a difference of atan2s, so
    // it is continuous through +-pi and needs no wrapping.
    const cross = state.forward.z * _toAim.x - state.forward.x * _toAim.z;
    const dot = state.forward.x * _toAim.x + state.forward.z * _toAim.z;
    const headingError = Math.atan2(cross, dot);

    const rawRate = (headingError - this.prevHeadingError) / dt;
    this.prevHeadingError = headingError;
    // One-pole low pass on the error rate. Without it the D term amplifies the
    // heading jitter the waves put into the hull and the boat twitches on every
    // crest.
    const alpha = 1 - Math.exp(-2 * Math.PI * P.steerFilterHz * dt);
    this.filteredErrorRate += (rawRate - this.filteredErrorRate) * alpha;

    const recovering = this.recoveryTimer > 0;
    // Recovery uses a stiffer proportional term and more damping: the boat is
    // out of shape and needs to be gathered up, not driven smoothly.
    const p = P.steerP * (recovering ? 1.35 : 1);
    const d = P.steerD * (recovering ? 1.5 : 1);

    let steer = p * headingError + d * this.filteredErrorRate;

    // While drifting, the hull is pointing further into the corner than it is
    // travelling, so the aim-point error under-reports how much lock is needed
    // to hold the slide. Add a term proportional to the slip being carried.
    if (state.driftAmount > 0.05) {
      steer += -Math.sign(state.lateralSpeed) * state.driftAmount * P.driftSteerGain;
    }
    if (this.mistake === 'botchedDrift') {
      // Overcorrection: a hard, wrong-signed input that has to be unwound.
      steer -= Math.sign(headingError) * 0.55;
    }
    // When side by side, refuse to steer *into* the neighbour no matter what the
    // line wants. This is the single most important rule for making pack racing
    // feel fair rather than like being bulldozed.
    if (avoid.blockSide !== 0 && Math.sign(steer) === avoid.blockSide) {
      steer *= 1 - P.aggression * 0.85;
    }

    steer = clamp(steer, -1, 1);
    // Final smoothing so the steering trace looks like a hand on a stick.
    const steerLag = Math.min(1, 26 * dt);
    this.steerSmoothed += (steer - this.steerSmoothed) * steerLag;

    // -----------------------------------------------------------------------
    // 6. SPEED
    // -----------------------------------------------------------------------
    const latBudget = P.lateralBudget * pace;
    const decel = P.brakeDecel;
    const horizon = Math.max(HORIZON_MIN, speed * HORIZON_SECONDS);
    const floor = topSpeed * P.minCornerFraction;

    let brake = 0;
    let targetSpeed = topSpeed * Math.min(1, pace);
    let worstCurvature = 0;

    for (let i = 1; i <= HORIZON_SAMPLES; i++) {
      const distance = (horizon * i) / HORIZON_SAMPLES;
      const sampleT = this.course.advance(t, distance);
      const k = Math.abs(this.course.signedCurvatureAt(sampleT));
      if (k > worstCurvature) worstCurvature = k;
      if (k < 1e-5) continue;

      const cornerSpeed = Math.max(floor, Math.sqrt(latBudget / k));
      if (cornerSpeed >= speed) continue;

      // Classic braking point: how much room does it take to lose this much
      // speed at this deceleration?
      const needed =
        ((speed * speed - cornerSpeed * cornerSpeed) / (2 * decel)) * P.brakePointScale;
      if (distance <= needed) {
        // Scale the pedal by how late we are: a marginal call is a lift, a
        // badly-late one is full brakes.
        const urgency = clamp((needed - distance) / Math.max(needed, 1) + 0.25, 0, 1);
        brake = Math.max(brake, urgency);
        targetSpeed = Math.min(targetSpeed, cornerSpeed);
      }
    }

    if (this.mistake === 'lateBrake') brake = 0;
    if (this.mistake === 'bogged') targetSpeed = Math.min(targetSpeed, topSpeed * 0.45);
    if (recovering) targetSpeed = Math.min(targetSpeed, topSpeed * 0.82);

    // Throttle: open unless we are above the target. Braking and throttle are
    // allowed to overlap slightly at low brake values, which is how a real
    // driver trail-brakes into a corner.
    let throttle = speed < targetSpeed ? 1 : clamp(1 - (speed - targetSpeed) / 6, 0, 1);
    throttle *= 1 - brake * 0.8;
    // Feed the pace band into the throttle too, but only where there is headroom
    // — at full throttle a multiplier above 1 would do nothing, which is why the
    // band's real authority lives in `latBudget` and `targetSpeed`.
    if (pace < 1) throttle *= pace;

    const throttleLag = Math.min(1, 12 * dt);
    this.throttleSmoothed += (throttle - this.throttleSmoothed) * throttleLag;

    // -----------------------------------------------------------------------
    // 7. DRIFT AND BOOST
    // -----------------------------------------------------------------------
    // Hold the slide through anything tighter than the personality's threshold,
    // but only once actually moving: initiating a drift from a standstill just
    // scrubs speed.
    const wantDrift =
      speed > topSpeed * 0.34 &&
      (worstCurvature > P.driftCurvature || Math.abs(kAhead) > P.driftCurvature);
    const drift = this.mistake === 'botchedDrift' ? true : wantDrift;

    // Cash the boost in on the exit, not in the corner: wait until the track
    // ahead is straight enough that the extra speed can be used.
    this.wantsBoost =
      state.boostCharge >= P.boostChargeThreshold &&
      state.boostTime <= 0 &&
      worstCurvature < P.boostCurvature &&
      brake < 0.05 &&
      !state.airborne;

    // -----------------------------------------------------------------------
    // 8. EMIT
    // -----------------------------------------------------------------------
    const c = this.command;
    c.throttle = clamp(this.throttleSmoothed, 0, 1);
    c.brake = clamp(brake, 0, 1);
    c.steer = clamp(this.steerSmoothed, -1, 1);
    c.drift = drift;
    return c;
  }

  // -------------------------------------------------------------------------
  // Mistakes
  // -------------------------------------------------------------------------

  /**
   * Roll for, run and retire mistakes.
   *
   * The probability is expressed per *second* and converted with
   * `1 - exp(-rate * dt)` rather than `rate * dt`, so the mistake frequency is
   * genuinely frame-rate independent — the naive form makes the AI 2.4x more
   * error-prone at 144 fps than at 60.
   *
   * Mistakes are suppressed below a third of top speed so an AI cannot fluff a
   * corner it is already crawling through, which reads as a bug rather than as
   * a driver error.
   */
  private tickMistakes(dt: number, speed: number, topSpeed: number): void {
    const P = this.personality;

    if (this.mistakeTimer > 0) {
      this.mistakeTimer -= dt;
      if (this.mistakeTimer <= 0) {
        this.mistake = 'none';
        this.recoveryTimer = P.recoveryDuration;
      }
      return;
    }

    if (this.recoveryTimer > 0) {
      this.recoveryTimer -= dt;
      return;
    }

    if (speed < topSpeed * 0.34) return;

    const chance = 1 - Math.exp(-P.mistakeRate * dt);
    if (this.rng() >= chance) return;

    const roll = this.rng();
    this.mistake =
      roll < 0.34 ? 'lateBrake' : roll < 0.66 ? 'wideEntry' : roll < 0.88 ? 'botchedDrift' : 'bogged';
    this.mistakeSign = this.rng() < 0.5 ? -1 : 1;
    // Duration jittered +-30% so the same mistake does not always last the
    // same time and become learnable.
    this.mistakeTimer = P.mistakeDuration * (0.7 + this.rng() * 0.6);
  }

  // -------------------------------------------------------------------------
  // Avoidance
  // -------------------------------------------------------------------------

  /**
   * Look for boats in a forward cone and in a side band.
   *
   * Two distinct behaviours, because they need opposite responses:
   *
   *   - Something *ahead* in the cone: pick the side with more room and add a
   *     lateral offset, scaled by how soon we arrive. Steering around an
   *     obstacle by biasing the racing-line offset (rather than by adding raw
   *     steer) means the avoidance automatically respects the corridor edges and
   *     unwinds itself once past.
   *   - Something *alongside*: do not steer at all. Hold a fixed offset away
   *     from them and forbid steering input towards them (`blockSide`). Boats
   *     that try to reclaim the racing line while overlapped just push each
   *     other off, which feels like the game cheating.
   */
  private avoidance(
    state: BoatState,
    allStates: readonly BoatState[],
    dt: number,
  ): { offsetFraction: number; blockSide: number } {
    const P = this.personality;
    let coneBias = 0;
    let blockSide = 0;
    let sideHold = 0;

    for (const other of allStates) {
      if (other.id === state.id) continue;

      _rel.subVectors(other.position, state.position).setY(0);
      const along = _rel.x * state.forward.x + _rel.z * state.forward.z;
      const across = _rel.x * state.right.x + _rel.z * state.right.z;
      const lateral = Math.abs(across);

      // Overlapped: bows within 6 m of each other, side by side.
      if (Math.abs(along) < 6.5 && lateral < P.clearance * 2.4) {
        blockSide = Math.sign(across) || 1;
        // Push out to a comfortable gap, no more. A large offset here would make
        // the AI dive for the grass every time it drew alongside.
        sideHold = -Math.sign(across) * (P.clearance - lateral) * 0.16;
        continue;
      }

      if (along <= 2 || along > 34) continue;
      if (lateral > P.clearance * 1.7) continue;

      // Closing rate matters: a boat we are catching at 2 m/s can be dealt with
      // gently, one we are catching at 20 m/s cannot.
      const closing =
        (state.velocity.x - other.velocity.x) * state.forward.x +
        (state.velocity.z - other.velocity.z) * state.forward.z;
      if (closing <= 0.5) continue;

      const timeToContact = along / closing;
      const urgency = clamp(1.6 / Math.max(timeToContact, 0.15), 0, 1);
      // Go round the side they are not on. `|| 1` handles a dead-centre overlap,
      // where either side is equally good and picking one is what matters.
      const side = -(Math.sign(across) || 1);
      coneBias += side * urgency * 0.42;
    }

    // Ease the side-by-side hold in and out so it does not snap when overlap
    // begins and ends.
    const holdLag = Math.min(1, 8 * dt);
    this.holdOffset += (sideHold - this.holdOffset) * holdLag;

    return {
      offsetFraction: clamp(coneBias + this.holdOffset, -1.1, 1.1),
      blockSide,
    };
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
