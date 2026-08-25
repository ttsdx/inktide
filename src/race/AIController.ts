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
   * Lateral jerk the AI believes it can produce, m/s^3.
   *
   * This is what stops it treating a chicane as two independent corners. The
   * lateral acceleration needed to follow a path is `v^2 * kappa`, so *changing*
   * direction costs `v^3 * dkappa/ds` — and in an S-bend kappa does not merely
   * grow, it reverses, so the change is twice as large over the same distance.
   * Sizing speed on curvature alone let the clean preset arrive at the Chicane
   * Flick at 31 m/s, which the radius allows and the reversal does not: the hull
   * could not swap lock fast enough, slid 27 m wide, and missed the gate.
   */
  lateralJerkBudget: number;
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
  lateralJerkBudget: 12,
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
  lateralJerkBudget: 15,
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
  // Greed has to cost something. This is the highest error rate of the three
  // after the erratic preset, and because mistakes now scale with how close to
  // the limit the boat actually is, the aggressive line amplifies it further:
  // this preset spends most of a lap in the band where errors are likely.
  mistakeRate: 1 / 13,
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
  // "Clean" has to mean precise, not timid: solo hot laps showed this preset
  // 2.1 to 2.6 s/lap slower than the aggressive one on every hull, which is not
  // a driver who wins by making no mistakes, it is just a slow driver. But the
  // speed cannot come from the grip budget. Raising this to 17.4 produced *no*
  // improvement in best lap (81.97 against 82.33) and a tail of races where the
  // boat slid outside the corridor: 15 m/s^2 is about the honest figure on open
  // swell, where the hull is out of the water a third of the time and the 22
  // m/s^2 available on flat water simply is not there. The pace comes from
  // braking at the right point and from the chicane instead.
  lateralBudget: 15.0,
  brakeDecel: 17.5,
  lateralJerkBudget: 14,
  brakePointScale: 0.97,
  minCornerFraction: 0.46,
  // Slides The Pin and the Kickback on purpose — charge only accrues while
  // sideways, so a driver who never slides forfeits a boost every lap.
  //
  // Deliberately NOT low enough to catch the chicane, despite the chicane being
  // tight enough to look like a drift. Measured: a drift held into a direction
  // reversal costs about a fifth of the hull's lateral grip at exactly the
  // moment it has to swap lock, and the clean preset slid 27 m wide there and
  // missed the gate. The `reversalWithin` gate blocks it anyway; this keeps the
  // preset's intent honest rather than relying on that backstop.
  driftCurvature: 0.0105,
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
  lateralJerkBudget: 13.5,
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
 * Distance within which the lateral-jerk limit is treated as a hard speed
 * ceiling rather than something to brake for. Roughly a second of travel: close
 * enough that the direction change is happening now.
 */
const JERK_CEILING_DISTANCE = 34;
/** How far ahead an opposite-handed corner blocks committing to a slide. */
const DRIFT_REVERSAL_DISTANCE = 46;
/**
 * Share of its gripped cornering budget the AI expects to keep while sliding.
 *
 * The physics interpolates lateral grip from the hull's baseline down towards
 * 4.3 as the drift builds, so a boat mid-slide has meaningfully less lateral
 * force available. 0.78 on the budget is about 0.88 on the resulting corner
 * speed, which matches what the hull can actually hold while sideways.
 */
const DRIFT_GRIP_FACTOR = 0.78;
/**
 * Fraction by which the rubber band moves the drift threshold. At 0.45 a boat
 * at the back of the field commits to a slide on corners 45% shallower than its
 * personality would normally bother with, which over a lap is several extra
 * boosts; a leader gives up the same amount.
 */
const DRIFT_CHASE_RANGE = 0.45;
/**
 * Curvature magnitude either side of a sign change for it to count as a real
 * reversal rather than the spline wobbling through zero on a straight. 1/250 m.
 */
const REVERSAL_K = 0.004;

/**
 * Tangent of the angle at which a boat off the course is asked to come back to
 * it — 0.62 is about 32 degrees.
 *
 * REJOIN GEOMETRY, AND WHY THE HORIZON MUST GROW RATHER THAN COLLAPSE
 *
 * The first attempt at recovery shortened the lookahead when the boat was off
 * line, on the reasoning that a near aim point makes the heading error reflect
 * the lateral error instead of the course's forward direction. That is true and
 * it is also a trap. A boat 27 m off line aiming at a point 8 m ahead on the
 * centreline has a 73 degree heading error: it takes full lock, crosses the line
 * at that angle at 28 m/s, and arrives 30 m off on the *other* side, where the
 * same logic fires in reverse. Traced on the probe it was a clean limit cycle,
 * about four seconds a period, and it was the whole of the 30-50 m excursion
 * figure — the boat was not thrown off the course by anything, it was steering
 * itself back and forth across it.
 *
 * Choosing the aim distance as `lateralError / REJOIN_TANGENT` instead fixes the
 * *approach angle* rather than the distance, so the boat converges on the line
 * asymptotically however far off it starts, and the further out it is the
 * further ahead it looks. 32 degrees is shallow enough not to overshoot at
 * racing speed and steep enough to be back on line within a corner's length.
 */
const REJOIN_TANGENT = 0.62;
/** Shortest the recovery horizon may become, metres. Below this it chases noise. */
const RECOVER_LOOKAHEAD_MIN = 8;
/**
 * Longest, metres. A boat far enough off line to want more than this is better
 * served by pointing at something it can see than by aiming most of a lap ahead.
 */
const REJOIN_LOOKAHEAD_MAX = 110;
/**
 * Corridor half-widths of `excess` over which the aim point blends from the
 * racing-line horizon to the rejoin horizon. Blended rather than switched: the
 * two differ by a factor of two at the corridor edge, and stepping the aim point
 * as the boat crosses it puts a kink in the steering exactly where the boat is
 * least able to absorb one.
 */
const REJOIN_BLEND_EXCESS = 0.5;

/**
 * Steering authority the controller assumes while the hull is out of the water.
 *
 * The physics gives an airborne hull 16% of its yaw authority, so a steering
 * command issued in mid-air accomplishes almost nothing — but it is still in the
 * smoothing filter when the boat lands, at which point it gets full authority
 * and bites instantly. On the Windward Run, which crosses the swell and is
 * deliberately the airtime section, that produced a genuine failure: the
 * erratic racer would wind on full lock over a crest, land, snap sideways, and
 * end up far enough off line to miss the next gate entirely and lose the lap.
 *
 * Damping the command in the air fixes it at the source. It is also what a rider
 * does: you cannot steer water that is not there, so you set up for the landing
 * instead.
 */
const AIR_STEER_SCALE = 0.3;
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

/**
 * Curvature above which the course counts as "a corner" for the purpose of
 * deciding which mistakes are possible. 0.0025 1/m is a 400 m radius — beyond
 * the Grand Sweeper's 271 m, so every real corner qualifies and the straights
 * do not.
 */
const CORNER_K = 0.0025;
/**
 * Fraction of a corner's limit speed below which mistakes are essentially only
 * the baseline rate. At 0.82 an AI driving well within itself is nearly
 * error-free and one arriving 20% too fast is not.
 */
const LIMIT_PRESSURE_FLOOR = 0.82;
/**
 * Share of the mistake rate that applies regardless of how hard the AI is
 * trying. Keeps a perfectly judged lap from being perfectly safe.
 */
const MISTAKE_BASELINE = 0.18;
/**
 * How far off line a `wideEntry` mistake pushes the aim point, in corridor
 * fractions. Small enough that the boat stays on the course while looking like
 * it has run wide and lost time.
 */
const WIDE_ENTRY_FRACTION = 0.5;

/**
 * Rubber band authority, as a fraction of pace.
 *
 * The brief asked for "mild". Mild is not enough, and the reason is arithmetic
 * rather than taste: `Emberjack` and `Violet Reach` are 11% apart on top speed
 * and the circuit is 42% flat out, so the hulls alone are worth about 3 s a lap.
 * A band that only trims a few percent cannot cover that, and at 8% the race was
 * decided on lap one every time.
 *
 * Swept over ten seeded races each: 13% leaves a 9.6 s spread, a 4.9 s winning
 * margin and one lead change; 20% gives 4.6 s, 1.5 s and 3.3; 26% gives 9.6 lead
 * changes but a 5.5 s standard deviation on the spread and a worst case of 22 s,
 * because the leader eases so hard that it falls into the pack, starts chasing
 * again, and the field oscillates. 20% is the knee.
 */
const RUBBER_BAND_RANGE = 0.2;
/**
 * Gap, in band units, inside which the band does nothing at all.
 *
 * Without this the leader is easing even when it leads by a boat length, which
 * is both pointless and the thing that made larger ranges unstable: the racer
 * in front is always giving something up, so the lead trades hands on noise.
 */
const RUBBER_BAND_DEADBAND = 0.12;
/**
 * Time constant, seconds, of the low pass on the rubber band input. See the
 * comment at the use site: race position is a step signal and the cornering
 * budget must not be.
 */
const BAND_TAU = 2.0;
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
/**
 * Time constant, seconds, of the airborne-fraction estimate.
 *
 * AIRTIME IS A GRIP BUDGET PROBLEM, AND IT IS THE BIG ONE
 *
 * `lateralBudget` was calibrated from `physicsProbe`-style steady-state
 * cornering on open water, and it is right there: about 15 m/s^2. It is badly
 * wrong on the parts of the circuit that matter. A hull out of the water has
 * *no* lateral grip at all — the physics gates the entire hydrodynamic side
 * force on `inWater` — and the chicane runs at 0.27 to the swell, which the
 * course probe labels "ACROSS swell (airtime)". Boats are airborne for around
 * 30% of a race and rather more than that through there.
 *
 * So the AI was planning the 60 m radius Chicane Flick at sqrt(15 x 60) =
 * 30 m/s, taking it with a third of the corner spent ballistic, and running 30 m
 * wide every single lap. That, not the mistake system, was the whole of the
 * 44-50 m excursion figure: the boat was not recovering badly from an error, it
 * was arriving at a corner it could not physically make.
 *
 * Rather than hard-coding a per-section fudge, the controller measures how much
 * of the last few seconds it has actually spent in the air and derates its own
 * grip budget by that fraction. It is self-calibrating — smooth along-swell
 * sections like the Leeward Drag get the full budget, the Windward Run and the
 * chicane get what they deserve — and it needs no knowledge of the sea state,
 * which is a runtime property the AI has no business reading.
 *
 * Three seconds is long enough to average over individual crests and short
 * enough to have adapted by the time the boat reaches the next corner.
 */
const AIR_TAU = 3.0;
/** Ceiling on the derating, so a very rough sea cannot stop the AI racing. */
const AIR_GRIP_LOSS_MAX = 0.42;

/**
 * Seconds the drift button is held released in order to fire a boost, before
 * the slide is picked back up.
 *
 * The physics puts a 0.35 s cooldown on the boost after a release, so this has
 * to clear it; much longer and the hull re-sticks and the second slide has to be
 * re-initiated from scratch, which costs more than the boost is worth.
 */
const BOOST_RELEASE_HOLD = 0.42;
/**
 * Charge at which the meter counts as full. The physics clamps `boostCharge` to
 * 1, so anything at or above this is earning nothing by being held.
 */
const BOOST_SATURATED = 0.97;

/**
 * Top-speed fraction given up per corridor half-width of `excess` while off the
 * course.
 *
 * Without this the AI would run wide, find that the spline projection under a
 * boat 30 m off line reports little curvature ahead, and go back to full
 * throttle — measured accelerating from 20 to 27 m/s while 32 m off the racing
 * line, which turned a recoverable error into the worst excursion in the race.
 * Getting back on line is worth more than the two tenths.
 */
const OFFLINE_SPEED_LOSS = 0.42;

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

  /** Low-passed rubber band input. See BAND_TAU. */
  private bandFiltered = 0;

  /** Fraction of the last few seconds spent out of the water. See AIR_TAU. */
  private airFraction = 0;

  /** Counts down while the drift button is deliberately released to fire a boost. */
  private releaseTimer = 0;

  /**
   * Grip/yaw scale for the hull this controller is driving. Latched on the first
   * update rather than in the constructor, because the controller is handed a
   * boat id and only meets the `BoatSpec` when the first state arrives.
   */
  private corneringFactor = 1;
  private specSeen = false;

  /**
   * Number of racers, used to normalise the field-position half of the rubber
   * band. Taken from the state array each frame rather than the constructor so
   * it stays correct whatever the grid size.
   */
  private fieldSize = 4;

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
    this.bandFiltered = 0;
    this.airFraction = 0;
    this.releaseTimer = 0;
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
    if (allStates.length > 1) this.fieldSize = allStates.length;

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
    const playerTerm = clamp(gap / RUBBER_BAND_SATURATION, -1, 1);

    // Field position, as a second reference. The gap to the *player* is the one
    // the brief specifies and the one that keeps the race feeling responsive to
    // how you are driving, but on its own it does nothing about the AI field
    // spreading out among itself: three opponents can string out over twenty
    // seconds while all sitting at the same distance from the player. Blending
    // in "where am I in the order" compresses the pack too, which is what makes
    // positions actually change hands.
    const middle = (this.fieldSize + 1) / 2;
    const positionTerm = clamp((progress.position - middle) / Math.max(middle - 1, 1), -1, 1);

    // Smoothed, because `position` is a discrete and very jumpy signal: two
    // boats trading places every few seconds made the band step between full
    // ease and none, and stepping the cornering budget around is exactly the
    // kind of thing that puts a boat off the course. A two second time constant
    // is far shorter than a lap and far longer than a place swap.
    const bandTarget = clamp(playerTerm * 0.55 + positionTerm * 0.45, -1, 1);
    this.bandFiltered += (bandTarget - this.bandFiltered) * (1 - Math.exp(-dt / BAND_TAU));
    // Deadband, applied after the filter so it gates the smoothed signal rather
    // than chattering on the raw one.
    const bandInput =
      Math.sign(this.bandFiltered) *
      Math.max(0, Math.abs(this.bandFiltered) - RUBBER_BAND_DEADBAND) /
      (1 - RUBBER_BAND_DEADBAND);
    const band = bandInput * RUBBER_BAND_RANGE * P.rubberBand;
    const wanderPace = P.wanderAmount > 0.2 ? Math.sin(this.pacePhase + this.pacePhase) * 0.05 : 0;

    // ASYMMETRY, AND WHY IT MATTERS
    //
    // The band only ever slows a racer down. It is tempting to let a trailing AI
    // scale its cornering budget *up*, and the first version did, but that
    // budget is a measured physical limit rather than a statement of ambition:
    // telling a boat it has 20% more lateral grip than the hull has does not
    // make it faster, it makes it understeer off the course. That showed up
    // exactly as you would expect — the field compressed nicely on average and
    // sprouted a tail of races where somebody slid into the scenery.
    //
    // A trailing racer is already flat out (`Violet Reach` averages 97% of its
    // top speed over a lap), so there is genuinely nothing to give it on the
    // straights and nothing safe to give it in the corners. Compression
    // therefore comes from the leader easing, which is both honest and
    // invisible, plus `chase` below, which buys real time through boost rather
    // than through imaginary grip.
    const pace = 1 + Math.min(0, band) + wanderPace;

    // How hard to chase boost, 0..1 either side of neutral. This is where the
    // band gets most of its real authority, because straight-line pace has none
    // to give: on a straight the throttle is already wide open and `targetSpeed`
    // is clamped to the hull's top speed, so a pace multiplier above 1 is a
    // no-op there. A boost, by contrast, is worth +14 m/s for nearly two
    // seconds, and the AI controls it completely — charge accrues while the
    // drift button is held and fires when it is released. So a trailing racer
    // commits to a slide on shallower corners than it otherwise would, banks
    // more charge and cashes more boosts; a leading one stops bothering.
    // One-sided. Letting a *leader* chase less looks symmetrical and is in fact
    // counterproductive: refusing to drift keeps the hull stuck, a stuck hull
    // has more lateral grip, and so a leader that stopped drifting simply
    // cornered faster and cancelled the easing above. Measured: it wiped out
    // essentially all of a 5.6% pace reduction. Leaders ease on pace and are
    // left to drift normally.
    const chase = clamp(Math.max(0, bandInput) * P.rubberBand, 0, 1);

    // Airtime, and therefore how much of the hull's measured grip is actually
    // going to be available through the next corner. See AIR_TAU.
    this.airFraction +=
      ((state.airborne ? 1 : 0) - this.airFraction) * (1 - Math.exp(-dt / AIR_TAU));
    const gripAvailable = 1 - Math.min(this.airFraction, AIR_GRIP_LOSS_MAX);

    // Cornering budget for this hull at this pace. Needed before the mistake
    // roll, because how close the AI is to this number is what decides whether
    // it makes one.
    const latBudget = P.lateralBudget * pace * this.corneringFactor * gripAvailable;

    // Drift intent, settled early because whether the hull will be stuck or
    // sliding changes how fast every corner in the horizon can be taken.
    //
    // A drift commits the hull to sliding one way. Into an S-bend that is
    // exactly wrong: the slide has to be unwound before the second element can
    // be turned into, and at chicane speeds there is not enough road to do it.
    //
    // Note this tests for an imminent *reversal*, not for a high rate of change
    // of curvature. Every corner entry has a high rate of change — that is what
    // an entry is — so gating on the rate suppressed the drift everywhere,
    // including at the hairpin where it is most wanted, and cost the field its
    // boost charge along with it.
    const reversalAhead = this.reversalWithin(t, DRIFT_REVERSAL_DISTANCE);
    // Trailing racers slide on shallower corners to farm charge; leaders raise
    // the bar and coast. See `chase`.
    const driftK = P.driftCurvature * (1 - chase * DRIFT_CHASE_RANGE);

    // -----------------------------------------------------------------------
    // 2. LINE — where on the corridor to aim
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

    const cruiseLookahead = clamp(
      P.lookaheadBase + speed * P.lookaheadPerSpeed,
      P.lookaheadBase,
      140,
    );
    // See REJOIN_TANGENT. Off the course, aim at whatever distance makes the
    // approach angle constant.
    let lookahead = cruiseLookahead;
    if (excess > 0) {
      const rejoin = clamp(
        Math.abs(lateralNow) / REJOIN_TANGENT,
        RECOVER_LOOKAHEAD_MIN,
        REJOIN_LOOKAHEAD_MAX,
      );
      const blend = clamp(excess / REJOIN_BLEND_EXCESS, 0, 1);
      lookahead = cruiseLookahead + (rejoin - cruiseLookahead) * blend;
    }
    const aheadT = this.course.advance(t, lookahead);
    this.course.sampleInto(aheadT, this.aheadPoint);

    const kAhead = this.course.signedCurvatureAt(aheadT);
    // Curvature a little further out again, to detect *approaching* a corner as
    // opposed to being in one. Entry width is a function of what is coming, not
    // of what is under the hull.
    const kEntry = this.course.peakCurvatureAhead(aheadT, Math.max(40, lookahead));

    // -----------------------------------------------------------------------
    // 3. MISTAKES — rolled here, where the corner situation is known
    // -----------------------------------------------------------------------
    // The speed this corner will actually hold, and how much more than that the
    // boat is carrying. Above 1 the AI is asking the hull for grip it does not
    // have, which is where a driver's errors genuinely come from.
    const entryK = Math.max(Math.abs(kEntry), Math.abs(kAhead));
    const cornerLimit = entryK > 1e-5 ? Math.sqrt(latBudget / entryK) : topSpeed * 2;
    const limitRatio = speed / Math.max(cornerLimit, 1);
    this.tickMistakes(dt, speed, topSpeed, {
      limitRatio,
      approachingCorner: entryK > CORNER_K,
      inCorner: Math.abs(kAhead) > CORNER_K,
      drifting: state.driftAmount > 0.25,
      offLine: excess,
      // Which way is "wide". Running wide means being carried to the outside of
      // the corner, so the sign is opposite the curvature. Rolling it at random
      // instead meant half of all wide entries pushed the boat towards the apex
      // and across the course, and two of them in quick succession with opposite
      // signs swept the hull 24 m sideways in two seconds.
      cornerSign: -Math.sign(kEntry || kAhead) || 1,
    });

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

    // Running wide means missing the apex, not leaving the course. The magnitude
    // here used to be 1.15 corridor-fractions, which on the 15.5 m Windward Run
    // commanded an 18 m lateral target: the boat built up so much sideways
    // momentum chasing it that when the mistake expired it coasted 31 m off
    // line, straight past a 22.5 m gate, and lost the whole lap. A mistake
    // should cost time, not void the lap.
    if (this.mistake === 'wideEntry') {
      offsetFraction += this.mistakeSign * WIDE_ENTRY_FRACTION;
    }

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
    // offset shows up as a steering spike, and a target that moves much faster
    // than the hull can follow lets the boat build lateral momentum it then
    // overshoots with. 9 m/s crosses a full corridor in under two seconds,
    // which is as fast as any line change needs to be.
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

    const slew = 9 * dt;
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
    //
    // Frozen while airborne: a boat on a ballistic arc accumulates heading error
    // that no steering input can affect, and feeding that into the derivative
    // term produces a large, entirely spurious correction that only lands when
    // the hull does.
    if (!state.airborne) {
      const alpha = 1 - Math.exp(-2 * Math.PI * P.steerFilterHz * dt);
      this.filteredErrorRate += (rawRate - this.filteredErrorRate) * alpha;
    }

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
    //
    // UNLESS THERE IS NO ROAD LEFT
    //
    // Absolute courtesy is the wrong rule and it cost a race: `Violet Reach`
    // arrived at the Coral Turn alongside someone on its inside, held 30% of the
    // turn-in it needed all the way through, ran 26 m wide, and drove straight
    // past the chicane gate. Refusing to turn in is only a real option while
    // there is still course to run wide onto; as that runs out the courtesy has
    // to be handed back, and the correct way to resolve the overlap becomes
    // separating in time rather than in space — which is what `blockedLift`
    // below does. Rolled off smoothly against the road remaining so the boat
    // does not simply lean on its neighbour the instant things get tight.
    let blockedLift = 0;
    if (avoid.blockSide !== 0) {
      const roomLeft = clamp(
        1 - Math.abs(lateralNow) / Math.max(this.nearPoint.width, 1),
        0,
        1,
      );
      if (Math.sign(steer) === avoid.blockSide) {
        const courtesy = clamp(0.34 - P.aggression * 0.22, 0.05, 0.34);
        steer *= courtesy + (1 - courtesy) * (1 - roomLeft);
      }
      // Back out of it. A driver who cannot take the line they need lifts;
      // holding the throttle flat and hoping is how you end up in the scenery.
      blockedLift = clamp(1 - roomLeft * 1.5, 0, 1);
    }

    // Do not wind on lock the hull cannot use. See AIR_STEER_SCALE.
    if (state.airborne) steer *= AIR_STEER_SCALE;

    steer = clamp(steer, -1, 1);
    // Final smoothing so the steering trace looks like a hand on a stick.
    const steerLag = Math.min(1, 26 * dt);
    this.steerSmoothed += (steer - this.steerSmoothed) * steerLag;

    // -----------------------------------------------------------------------
    // 6. SPEED
    // -----------------------------------------------------------------------
    const decel = P.brakeDecel;
    const horizon = Math.max(HORIZON_MIN, speed * HORIZON_SECONDS);
    const floor = topSpeed * P.minCornerFraction;

    let brake = 0;
    let targetSpeed = topSpeed * Math.min(1, pace);
    let worstCurvature = 0;
    // Largest curvature reversal rate found in the horizon, and how far away it
    // is. Used both for the jerk limit and to decide against drifting into an
    // S-bend.
    let worstTwist = 0;
    const step = horizon / HORIZON_SAMPLES;
    let prevSigned = this.course.signedCurvatureAt(t);

    for (let i = 1; i <= HORIZON_SAMPLES; i++) {
      const distance = step * i;
      const sampleT = this.course.advance(t, distance);
      const signed = this.course.signedCurvatureAt(sampleT);
      const k = Math.abs(signed);
      if (k > worstCurvature) worstCurvature = k;

      // dkappa/ds across this step. A sign change contributes the sum of the two
      // magnitudes, which is exactly the extra cost of an S-bend.
      const twist = Math.abs(signed - prevSigned) / step;
      prevSigned = signed;
      if (twist > worstTwist) worstTwist = twist;

      // Speed at which this rate of direction change is affordable. Braked for
      // like a corner when it is still far off, and held as a ceiling once it is
      // close enough to be the thing under the hull.
      if (twist > 1e-6) {
        const jerkSpeed = Math.max(floor, Math.cbrt((P.lateralJerkBudget * pace) / twist));
        if (jerkSpeed < speed) {
          const needed =
            ((speed * speed - jerkSpeed * jerkSpeed) / (2 * decel)) * P.brakePointScale;
          if (distance <= needed) {
            brake = Math.max(brake, clamp((needed - distance) / Math.max(needed, 1) + 0.2, 0, 1));
            targetSpeed = Math.min(targetSpeed, jerkSpeed);
          }
        }
        if (distance <= JERK_CEILING_DISTANCE) targetSpeed = Math.min(targetSpeed, jerkSpeed);
      }

      if (k < 1e-5) continue;

      // Would the AI be sliding through this particular sample? If so it has
      // less grip to hold the line with, not more, and must plan a lower speed.
      //
      // This coupling was missing and it was the most expensive error left in
      // the controller. Corner speed was computed from the hull's gripped budget
      // and the drift was then switched on independently, so at The Pin the
      // clean preset would arrive at exactly the 30 m/s its gripped budget
      // allowed, unstick the hull, lose a fifth of its lateral force and slide
      // 28 m wide — then carry that error into the chicane and miss the gate.
      // Drifting buys rotation and boost charge; it does not buy cornering grip.
      const slidingHere = !reversalAhead && k > driftK;
      const budgetHere = slidingHere ? latBudget * DRIFT_GRIP_FACTOR : latBudget;

      const cornerSpeed = Math.max(floor, Math.sqrt(budgetHere / k));
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

    // Off the course: getting back matters more than the lap time, and the
    // curvature scan is unreliable out here anyway because it is reading the
    // spline under a boat that is not on it. See OFFLINE_SPEED_LOSS.
    if (excess > 0) {
      targetSpeed = Math.min(
        targetSpeed,
        topSpeed * (1 - Math.min(excess, 1) * OFFLINE_SPEED_LOSS),
      );
    }

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
    const lift = Math.max(avoid.lift, blockedLift);
    if (lift > 0) {
      const respect = 1 - P.aggression * 0.45;
      throttle *= 1 - lift * respect;
      if (lift > 0.75) brake = Math.max(brake, (lift - 0.75) * 2.4 * respect);
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
      !reversalAhead &&
      speed > topSpeed * 0.34 &&
      (worstCurvature > driftK || Math.abs(kAhead) > driftK);
    // Recovering from a spin, the slide is the fastest way to rotate: unsticking
    // the hull adds 62% to its yaw authority in the physics. Only worth it while
    // there is enough speed for the drift to engage at all.
    if (spun && speed > topSpeed * 0.3) wantDrift = true;
    let drift = this.mistake === 'botchedDrift' ? true : wantDrift;

    // CASHING THE CHARGE IN
    //
    // `BoatCommand` has no boost channel. The physics fires the boost when the
    // drift button is *released* with charge banked, and the charge saturates at
    // 1.0 — so the only thing that decides how much boost a racer gets is when
    // it lets go of the slide, and holding a full meter through the rest of a
    // corner earns exactly nothing. The AI was doing precisely that: one slide
    // per corner, one boost per corner, and a meter that had been pegged for two
    // seconds by the time it was cashed.
    //
    // So: when the meter is full, let go for long enough for the physics to
    // register a release, then pick the slide back up. It is what a player does
    // — flick, catch, flick again — and it turns The Pin from one boost into
    // two.
    //
    // Only at saturation, though. Cashing early was measured and is worse: the
    // boost is a thrust multiplier, `boostTime` is `0.55 + charge * 1.35`, and
    // the 0.42 s with the button released earns no charge at all, so releasing at
    // half a meter buys 1.29 s of boost per 0.81 s of cycle where waiting for a
    // full one buys 1.90 s per 1.13 s. Sitting on a *pegged* meter, by contrast,
    // is pure waste, and that is what the AI had been doing.
    const cashThreshold = Math.max(P.boostChargeThreshold, BOOST_SATURATED);
    if (this.releaseTimer > 0) {
      this.releaseTimer -= dt;
      drift = false;
    } else if (drift && state.boostCharge >= cashThreshold && state.boostTime <= 0) {
      this.releaseTimer = BOOST_RELEASE_HOLD;
      drift = false;
    }

    // Advisory, for anything that owns a boost button of its own.
    this.wantsBoost =
      state.boostCharge >= P.boostChargeThreshold * (1 - chase * 0.35) &&
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

    // TEMP-DEBUG
    const dbg = (globalThis as Record<string, unknown>).__AI_DEBUG as
      | ((s: Record<string, number | string | boolean>) => void)
      | undefined;
    if (dbg) {
      dbg({
        id: this.boatId,
        t,
        lat: lateralNow,
        excess,
        spun,
        recovering: this.recovering,
        lookahead,
        offsetFraction,
        wantOffset,
        lateralTarget: this.lateralTarget,
        headingError,
        steer: c.steer,
        rawSteer: steer,
        throttle: c.throttle,
        brake: c.brake,
        drift: c.drift,
        air: state.airborne,
        speed,
        mistake: this.mistake,
        lift: avoid.lift,
        pace,
        band,
        bandInput,
        chase,
        position: progress.position,
        latBudget,
        targetSpeed,
        blockSide: avoid.blockSide,
        avoidOffset: avoid.offsetFraction,
        width: this.aheadPoint.width,
      });
    }
    return c;
  }

  // -------------------------------------------------------------------------
  // Mistakes
  // -------------------------------------------------------------------------

  /**
   * Roll for, run and retire mistakes.
   *
   * WHY THIS IS NOT A FLAT COIN FLIP
   *
   * The first version of this rolled a fixed per-second probability and then
   * picked a mistake kind at random. It produced errors at the right *rate* and
   * in entirely the wrong *places*: an AI was exactly as likely to botch a drift
   * halfway down a straight as at the entry to the hairpin, and a "wide entry"
   * could fire 300 m from the nearest corner, where there is no entry to be wide
   * into. Watching it, the mistakes read as the AI glitching rather than as a
   * driver overcooking it, which is the opposite of the point — beating an
   * opponent only feels earned if you can see why they lost it.
   *
   * So the hazard rate is now modulated by how hard the AI is actually trying:
   * `limitRatio` is the speed it is carrying divided by the speed the corner
   * ahead will hold, and above `LIMIT_PRESSURE_FLOOR` the chance of an error
   * climbs steeply. Being off line at turn-in adds to it, for the same reason it
   * does in a real car — the grip you have left is a function of what you are
   * already asking for.
   *
   * The *kind* is then chosen from what is physically plausible right now, so a
   * botched drift only happens while drifting and a missed brake point only
   * happens when there is a brake point to miss. On a straight the only thing
   * left that makes sense is bogging the engine, which is why it is the fallback.
   *
   * The probability is expressed per *second* and converted with
   * `1 - exp(-rate * dt)` rather than `rate * dt`, so the mistake frequency is
   * genuinely frame-rate independent — the naive form makes the AI 2.4x more
   * error-prone at 144 fps than at 60.
   */
  private tickMistakes(
    dt: number,
    speed: number,
    topSpeed: number,
    ctx: {
      limitRatio: number;
      approachingCorner: boolean;
      inCorner: boolean;
      drifting: boolean;
      offLine: number;
      cornerSign: number;
    },
  ): void {
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

    // Suppressed below a third of top speed so an AI cannot fluff a corner it is
    // already crawling through, which reads as a bug rather than a driver error.
    if (speed < topSpeed * 0.34) return;
    // And never while already off the course: piling a mistake on top of a
    // recovery is how a small error turns into a lost lap.
    if (ctx.offLine > 0.1) return;

    // Pressure: 0 while comfortably within the corner's limit, 1 when asking for
    // appreciably more grip than there is. Off-line at turn-in counts too.
    const overLimit = clamp(
      (ctx.limitRatio - LIMIT_PRESSURE_FLOOR) / (1 - LIMIT_PRESSURE_FLOOR),
      0,
      1,
    );
    const pressure = clamp(overLimit + ctx.offLine * 0.5, 0, 1);

    // A baseline keeps some unpredictability on a perfectly judged lap; the rest
    // is earned by pushing. `mistakeRate` is the rate at full pressure.
    const rate = P.mistakeRate * (MISTAKE_BASELINE + (1 - MISTAKE_BASELINE) * pressure * pressure);
    const chance = 1 - Math.exp(-rate * dt);
    if (this.rng() >= chance) return;

    // Pick from what is actually possible in this situation.
    const roll = this.rng();
    if (ctx.drifting && ctx.inCorner) {
      this.mistake = roll < 0.62 ? 'botchedDrift' : 'wideEntry';
    } else if (ctx.approachingCorner && !ctx.inCorner) {
      this.mistake = roll < 0.55 ? 'lateBrake' : 'wideEntry';
    } else if (ctx.inCorner) {
      this.mistake = roll < 0.5 ? 'wideEntry' : 'botchedDrift';
    } else {
      this.mistake = 'bogged';
    }

    this.mistakeSign = ctx.cornerSign;
    // Duration jittered +-30% so the same mistake does not always last the
    // same time and become learnable.
    this.mistakeTimer = P.mistakeDuration * (0.7 + this.rng() * 0.6);
  }

  /**
   * True if the course changes hand within `distance` metres — the signed
   * curvature flips sign with real magnitude on both sides. Four samples is
   * plenty: the shortest element on the circuit is the 22 m chicane link, and
   * the curvature table is already smoothed over roughly a hull length.
   */
  private reversalWithin(t: number, distance: number): boolean {
    let reference = 0;
    for (let i = 0; i <= 4; i++) {
      const k = this.course.signedCurvatureAt(this.course.advance(t, (distance * i) / 4));
      if (Math.abs(k) < REVERSAL_K) continue;
      if (reference === 0) reference = Math.sign(k);
      else if (Math.sign(k) !== reference) return true;
    }
    return false;
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
