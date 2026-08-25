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
 * ...and why it must shrink again when the boat is off line
 *
 * A speed-scaled lookahead is right while the boat is near the racing line and
 * badly wrong once it is not. Consider a boat knocked 40 m wide: its aim point
 * 35 m up the spline is nearly straight ahead of it, because at that distance
 * the course's own forward direction dominates the 40 m of lateral error. The
 * controller therefore reports a small heading error, steers gently, and the
 * boat rejoins over a couple of hundred metres — a long, lazy arc that looks
 * like the AI has given up. It was the single largest defect in the first
 * version of this file: two boats tangled at the start and swept fifty metres
 * outside the corridor, far enough to trip the wrong-way detector.
 *
 * The fix is to divide the lookahead by how far outside the corridor the boat
 * is. Off line, the nearest point on the line becomes the target and the boat
 * turns in hard; back on line, the speed-scaled horizon returns. `RECOVER_*`
 * below sets how sharply that happens.
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
  /**
   * Lateral acceleration the AI believes it can hold, m/s^2, on a hull of
   * average grip. Scaled per boat by `hullCorneringFactor`.
   *
   * Measured against the physics: full lock and no drift sustains about
   * 22 m/s^2, a held drift about 28. The values below sit near 70% of that,
   * which is the margin needed to keep a line on open swell — the hull is out of
   * the water nearly a third of a lap, and grip is zero while it is.
   */
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
  lateralBudget: 15.5,
  // Measured: full brakes shed speed at 19-21 m/s^2 on three of the four hulls.
  // Planning around 16 leaves the AI braking a shade early, which is the right
  // way to be wrong.
  brakeDecel: 16,
  brakePointScale: 1.0,
  minCornerFraction: 0.42,
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
  lateralBudget: 17.2,
  brakeDecel: 19,
  brakePointScale: 0.86,
  minCornerFraction: 0.46,
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
  // Not the lowest budget in the field, which is the whole point of the preset:
  // it corners as hard as the aggressive one but arrives at the corner at a
  // speed it has actually planned for, so it never has to correct.
  lateralBudget: 16.8,
  brakeDecel: 17,
  brakePointScale: 1.06,
  minCornerFraction: 0.46,
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
  lateralBudget: 16.4,
  brakeDecel: 17.5,
  brakePointScale: 0.95,
  minCornerFraction: 0.4,
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

/**
 * How hard the lookahead collapses when the boat is outside the corridor.
 *
 * The divisor is `1 + excess * RECOVER_LOOKAHEAD_GAIN`, where `excess` is how
 * many corridor half-widths beyond the edge the boat is. At 2 half-widths out
 * with a gain of 1.6 the horizon is cut to 24% of normal, which turns a
 * 36 m aim point into 9 m — short enough that the heading error reflects the
 * lateral error rather than the course's forward direction.
 */
const RECOVER_LOOKAHEAD_GAIN = 1.6;
/** Shortest the recovery horizon may become, metres. Below this it chases noise. */
const RECOVER_LOOKAHEAD_MIN = 8;
/**
 * Heading error, radians, beyond which the boat counts as genuinely turned
 * around rather than merely off line. Past this the controller stops trying to
 * make progress and concentrates on pointing the right way again: it lifts, and
 * drifts if it is moving fast enough, because yaw authority is highest when the
 * hull is unstuck and the speed term in `heaviness` is not fighting it.
 */
const RECOVER_HEADING = 1.15;
/**
 * Speed ceiling while recovering from a spin, as a fraction of top speed.
 * Rotating a hull is far easier slowly — `heaviness` in the physics removes a
 * third of the yaw authority by 50 m/s — so flooring the throttle while
 * pointing the wrong way makes the recovery arc bigger, not smaller.
 */
const RECOVER_SPEED_FRACTION = 0.55;

/**
 * Seconds after the flag during which each racer holds the lateral offset it
 * started from instead of converging on the racing line.
 *
 * The grid puts boats in staggered pairs either side of the centreline. Without
 * this every one of them targets the same line the instant the lights go out,
 * and the two boats sharing a column arrive at the same water at the same time;
 * the resulting collision cost the back row eight seconds and most of the
 * first-lap spread. Real grids resolve this the same way — you hold your lane
 * off the line and sort it out into the first corner.
 */
const LAUNCH_LANE_SECONDS = 5.5;

/**
 * Lateral distance within which a boat ahead counts as "directly in front" and
 * therefore cannot be driven around, only lifted for. Two hull radii (1.55 m
 * each) plus a little, so it triggers on a genuine overlap rather than on
 * anything vaguely in the same part of the course.
 */
const HULL_WIDTH_ALLOWANCE = 4.0;
/** Following gap the AI aims to leave, metres, measured bow to bow. */
const HULL_GAP_TARGET = 7.0;
/** Time-to-contact at which the lift reaches full. */
const FOLLOW_LIFT_SECONDS = 1.5;

/** Rubber band authority. +-8% of pace, per the brief. */
const RUBBER_BAND_RANGE = 0.08;
/**
 * Gap at which the rubber band saturates, metres. 260 m is roughly a tenth of a
 * lap: inside that the band is doing almost nothing, beyond it the trailing AI
 * is running at its full +8% and the leader has eased to -8%.
 */
const RUBBER_BAND_SATURATION = 260;

/**
 * How much cornering grip this hull has relative to an average one.
 *
 * The physics builds lateral grip as `lerp(9.5, 3.2, slidiness)`, so a slippery
 * hull genuinely cannot hold the line a grippy one can. Folding that into the
 * AI's speed model means one personality preset behaves correctly on any of the
 * four boats instead of being secretly tuned to whichever hull it shipped on —
 * and it is what lets the CLEAN preset exploit `Violet Reach`, the grippiest and
 * highest-yaw hull in the field, rather than being merely slow on it.
 *
 * Normalised at `slidiness = 0.5`, and blended with the hull's turn rate
 * because a corner needs both the grip to hold it and the yaw authority to
 * rotate into it.
 */
function hullCorneringFactor(spec: BoatState['spec']): number {
  const grip = 9.5 + (3.2 - 9.5) * clamp(spec.slidiness, 0, 1);
  const gripFactor = grip / 6.35;
  const yawFactor = clamp(spec.turnRate / 0.92, 0.7, 1.3);
  return gripFactor * 0.72 + yawFactor * 0.28;
}

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

  /**
   * True while the controller has abandoned the racing line to get back onto
   * the course. Exposed so a debug overlay can show it — an AI in this state
   * looks like it is driving badly, and it helps to be able to see that it
   * knows.
   */
  recovering = false;

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

  /**
   * Lateral offset this racer launched from, and how much of the launch-lane
   * hold is left. Captured on the first racing frame rather than from the grid
   * slot so it stays correct if the boat is placed by something other than
   * `Course.startGrid`.
   */
  private launchLane = 0;
  private launchLaneTimer = -1;

  /**
   * Grip/yaw scale for the hull this controller is driving. Latched on the first
   * update rather than in the constructor, because the controller is handed a
   * boat id and only meets the `BoatSpec` when the first state arrives.
   */
  private corneringFactor = 1;
  private specSeen = false;

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
    this.recovering = false;
    this.launchLane = 0;
    this.launchLaneTimer = -1;
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

    if (!this.specSeen) {
      this.specSeen = true;
      this.corneringFactor = hullCorneringFactor(state.spec);
    }

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
    // Sample under the hull first: how far off line the boat is decides how far
    // ahead it is allowed to look.
    this.course.sampleInto(t, this.nearPoint);
    const lateralNow =
      (state.position.x - this.nearPoint.position.x) * this.nearPoint.normal.x +
      (state.position.z - this.nearPoint.position.z) * this.nearPoint.normal.z;

    // Alignment of the hull with the course. Negative means pointing backwards,
    // which after a spin or a heavy shunt is exactly what has happened.
    const alignment =
      state.forward.x * this.nearPoint.tangent.x + state.forward.z * this.nearPoint.tangent.z;
    const courseHeadingError = Math.acos(clamp(alignment, -1, 1));

    // Corridor half-widths beyond the edge. Zero while inside the course.
    const excess = Math.max(0, Math.abs(lateralNow) / Math.max(this.nearPoint.width, 1) - 1);
    const spun = courseHeadingError > RECOVER_HEADING;
    this.recovering = excess > 0.15 || spun;

    const lookahead = Math.max(
      RECOVER_LOOKAHEAD_MIN,
      clamp(P.lookaheadBase + speed * P.lookaheadPerSpeed, P.lookaheadBase, 140) /
        (1 + excess * RECOVER_LOOKAHEAD_GAIN),
    );
    const aheadT = this.course.advance(t, lookahead);
    this.course.sampleInto(aheadT, this.aheadPoint);

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

    // Off line, none of the above is worth anything: an apex bias computed for a
    // corner the boat is not on the approach to just holds it out wider. Fade
    // the whole racing-line preference out and target the centreline instead.
    if (excess > 0) offsetFraction *= Math.max(0, 1 - excess * 1.5);

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
    let wantOffset = clamp(offsetFraction * halfWidth, -maxOffset, maxOffset);

    // Launch lane: for the opening seconds, blend the target back towards the
    // offset this boat started from so the field fans out off the line instead
    // of four boats converging on one piece of water.
    if (this.launchLaneTimer < 0 && speed > 1.5) {
      this.launchLaneTimer = LAUNCH_LANE_SECONDS;
      this.launchLane = lateralNow;
    }
    if (this.launchLaneTimer > 0) {
      this.launchLaneTimer -= dt;
      // Squared so the hold is firm for the first half and then releases
      // smoothly, rather than dragging the boat off line all the way to turn one.
      const hold = clamp(this.launchLaneTimer / LAUNCH_LANE_SECONDS, 0, 1) ** 2;
      wantOffset += (clamp(this.launchLane, -maxOffset, maxOffset) - wantOffset) * hold;
    }

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
    // Aggression decides how much of the input survives, but never all of it:
    // even the aggressive preset gives up two thirds of a steering input aimed
    // into a boat it is overlapped with. Leaving this at `1 - aggression * 0.85`
    // let the clean preset keep 70% of a turn-in towards a neighbour, which is
    // how the start-line contact happened.
    if (avoid.blockSide !== 0 && Math.sign(steer) === avoid.blockSide) {
      steer *= clamp(0.34 - P.aggression * 0.22, 0.05, 0.34);
    }

    steer = clamp(steer, -1, 1);
    // Final smoothing so the steering trace looks like a hand on a stick.
    const steerLag = Math.min(1, 26 * dt);
    this.steerSmoothed += (steer - this.steerSmoothed) * steerLag;

    // -----------------------------------------------------------------------
    // 6. SPEED
    // -----------------------------------------------------------------------
    const latBudget = P.lateralBudget * pace * this.corneringFactor;
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

    // Pointing the wrong way: get the nose round before worrying about pace.
    if (spun) {
      targetSpeed = Math.min(targetSpeed, topSpeed * RECOVER_SPEED_FRACTION);
      brake = Math.max(brake, 0.35);
    }

    // Throttle: open unless we are above the target. Braking and throttle are
    // allowed to overlap slightly at low brake values, which is how a real
    // driver trail-brakes into a corner.
    let throttle = speed < targetSpeed ? 1 : clamp(1 - (speed - targetSpeed) / 6, 0, 1);
    throttle *= 1 - brake * 0.8;

    // Lift for a boat we cannot pass. An aggressive driver leaves it later and
    // lifts less — it will still nudge the boat in front — but nobody gets to
    // drive straight through the back of someone.
    if (avoid.lift > 0) {
      const respect = 1 - P.aggression * 0.45;
      throttle *= 1 - avoid.lift * respect;
      if (avoid.lift > 0.75) brake = Math.max(brake, (avoid.lift - 0.75) * 2.4 * respect);
    }
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
    let wantDrift =
      speed > topSpeed * 0.34 &&
      (worstCurvature > P.driftCurvature || Math.abs(kAhead) > P.driftCurvature);
    // Recovering from a spin, the slide is the fastest way to rotate: unsticking
    // the hull adds 62% to its yaw authority in the physics. Only worth it while
    // there is enough speed for the drift to engage at all.
    if (spun && speed > topSpeed * 0.3) wantDrift = true;
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
  ): { offsetFraction: number; blockSide: number; lift: number } {
    const P = this.personality;
    let coneBias = 0;
    let blockSide = 0;
    let sideHold = 0;
    let lift = 0;

    for (const other of allStates) {
      if (other.id === state.id) continue;

      _rel.subVectors(other.position, state.position).setY(0);
      const along = _rel.x * state.forward.x + _rel.z * state.forward.z;
      const across = _rel.x * state.right.x + _rel.z * state.right.z;
      const lateral = Math.abs(across);

      // Closing speed along our own heading, needed by both branches below.
      const closingRate =
        (state.velocity.x - other.velocity.x) * state.forward.x +
        (state.velocity.z - other.velocity.z) * state.forward.z;

      // ---- LIFT: someone directly in front, and we are catching them --------
      //
      // Steering around is only an option if there is somewhere to go. In a
      // braking zone there usually is not: both boats are slowing on the same
      // line and the one behind simply arrives. Rear-ending under braking was
      // the largest single time loss left in the field — two boats would stop
      // dead at the entry to The Pin and lose three and a half seconds — and no
      // amount of lateral bias fixes it, because the car in front is exactly
      // where the racing line is. So lift instead, which is what a driver does.
      if (along > 0 && along < 16 && lateral < HULL_WIDTH_ALLOWANCE && closingRate > 0.8) {
        // Time to contact against the space actually available. Squared so the
        // response is gentle at the edge of the window and firm up close.
        const room = Math.max(along - HULL_GAP_TARGET, 0.5);
        const ttc = room / closingRate;
        lift = Math.max(lift, clamp(1 - ttc / FOLLOW_LIFT_SECONDS, 0, 1) ** 2);
      }

      // Overlapped: hulls are 5.4 m long, so bows within 9 m means the boats are
      // genuinely wheel to wheel rather than one merely catching the other.
      if (Math.abs(along) < 9 && lateral < P.clearance * 2.4) {
        blockSide = Math.sign(across) || 1;
        // Push out towards a real gap. The original 0.16 gain here was far too
        // gentle to matter: two boats converging on the same line from opposite
        // sides of the grid closed a 4 m gap and collided while both were
        // nominally "avoiding". The gain is now strong enough to actually hold a
        // lane, and still capped below by `clearance` so nobody dives for the
        // buoys just because someone drew alongside.
        const deficit = Math.max(0, P.clearance - lateral) / Math.max(P.clearance, 1);
        sideHold += -(Math.sign(across) || 1) * deficit * 0.75;
        continue;
      }

      if (along <= 2 || along > 34) continue;
      if (lateral > P.clearance * 1.7) continue;

      // Closing rate matters: a boat we are catching at 2 m/s can be dealt with
      // gently, one we are catching at 20 m/s cannot.
      const closing = closingRate;
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
      lift,
      blockSide,
    };
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
