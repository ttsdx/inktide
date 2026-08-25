import { Vector3 } from 'three';
import type { BoatState, FrameContext, RacePhase, RacerProgress } from '../contracts.ts';
import { Course, type CourseProgress } from './Course.ts';

/**
 * THE RACE
 *
 * Phase machine, lap validation, placement and wrong-way detection. It reads
 * `BoatState` and writes nothing but its own `progress` array, so it can be
 * ticked before or after physics without changing the result.
 *
 * WHY LAPS ARE VALIDATED WITH SEQUENTIAL PLANE CROSSINGS
 *
 * The tempting cheap version — "you completed a lap when your arc-length
 * parameter wrapped past zero" — is trivially defeated: cut across the inside
 * of the hairpin and the parameter still wraps. So each racer carries a
 * `nextCheckpoint` cursor and can only advance it by crossing *that* gate's
 * plane, in the forward direction, inside the gate's opening. Twelve gates at
 * 140-275 m spacing means there is no shortcut anywhere on the circuit that
 * skips a gate, and a boat that misses one has to physically go back for it.
 *
 * WHY THE WRONG-WAY DETECTOR NEEDS HYSTERESIS
 *
 * The raw test — `dot(velocity, courseTangent) < 0` — is true for a fraction of
 * a second every single time a boat spins on a landing, gets shunted in a pack,
 * or flicks the tail out through the chicane. Firing the klaxon and the red HUD
 * banner on those would make the game feel broken. So the condition has to hold
 * for `WRONG_WAY_ON` before it latches, and its negation has to hold for
 * `WRONG_WAY_OFF` before it clears; the two thresholds differ so a boat
 * oscillating around zero closing speed cannot make the state chatter.
 *
 * WHY PROGRESS IS UNWRAPPED RATHER THAN `lap + t`
 *
 * `lap + lapProgress` jumps by a whole lap at the start/finish seam, one frame
 * before or after the gate validates, and placement sorting built on it makes
 * boats swap places spuriously at the line. Instead progress is accumulated
 * from per-frame *deltas* of `t` (taken the short way round), which is smooth
 * across the seam — and then clamped to the validated lap count so that
 * accumulating deltas cannot be used to fabricate progress either.
 */

export const DEFAULT_LAPS = 3;

/** Seconds the raw wrong-way condition must hold before it latches. */
const WRONG_WAY_ON = 0.6;
/** Seconds it must be false before it clears. Longer, deliberately. */
const WRONG_WAY_OFF = 0.85;
/** Closing speed below which a boat counts as heading backwards, m/s. */
const WRONG_WAY_SPEED = -1.5;
/** Below this ground speed the test is meaningless, so it is suspended. */
const WRONG_WAY_MIN_SPEED = 3.0;
/**
 * Ground speed a racer that is still *facing* the right way has to be making in
 * reverse before it counts as going the wrong way, m/s.
 *
 * BEING SHUNTED IS NOT GOING THE WRONG WAY
 *
 * Every wrong-way event left in a sixteen-race sample was the same thing, and it
 * was not what this detector is for: two boats collide, both are knocked to
 * walking pace and pushed backwards at six or seven metres a second, and the
 * banner fires on a racer that is sitting on the racing line pointing correctly
 * down the course. Measured across those races the reverse speeds ran from 3.5
 * to 9.2 m/s and the lateral offsets from -8.7 to +6.7 m — dead centre.
 *
 * A racer that has genuinely turned round is facing backwards, so the hull's
 * heading is what separates the two cases, and the speed floor only needs to be
 * raised for the one where it is not. A boat facing the right way has to be
 * carrying real reverse speed to earn the banner; a boat facing backwards earns
 * it at any speed at all, which is the case the detector actually exists for.
 */
const WRONG_WAY_SHUNT_SPEED = 12.0;
/**
 * Alignment of the hull with the course below which it counts as facing
 * backwards. -0.35 is about 110 degrees, comfortably past anything a drift or a
 * bad landing produces.
 */
const WRONG_WAY_FACING = -0.35;

/**
 * How far past a pending gate a racer can get before we tell them they missed
 * it. Generous: the plane test already fires anywhere inside the opening, so
 * this only triggers on a genuine detour around the outside of a pylon.
 */
const MISSED_GATE_DISTANCE = 130;

/**
 * A crossing is only believed if the along-gate distance moved by no more than
 * the boat could plausibly have travelled this frame: its own speed times dt,
 * with this much headroom for a frame spike or a landing shunt, plus
 * `GATE_STEP_FLOOR` so a nearly-stationary boat nudged over the line still
 * counts.
 *
 * Without this the sign-change test is a pure infinite-plane test, and anything
 * that moves a boat a long way in one frame — a respawn, a physics tunnel
 * through the hairpin, a debug teleport — reads as a clean pass because the
 * distance simply flipped from negative to positive. The plane has no memory of
 * whether the boat went *through* the opening or merely ended up on the far
 * side of it.
 */
const GATE_STEP_SAFETY = 4;
const GATE_STEP_FLOOR = 2;

export type RaceEvent =
  | { type: 'phase'; phase: RacePhase; time: number }
  /** 3, 2, 1 then 0 for GO. */
  | { type: 'countdown'; value: number; time: number }
  | {
      type: 'gate';
      boatId: number;
      checkpoint: number;
      lap: number;
      /** Seconds from this lap's start to this gate. The split itself. */
      split: number;
      /**
       * Split minus the racer's best-ever split at this gate, so the HUD can
       * show the usual signed delta. Negative is an improvement. Zero on the
       * first visit, when there is nothing to compare against.
       */
      splitDelta: number;
      time: number;
    }
  | {
      type: 'lap';
      boatId: number;
      /** Laps completed after this crossing. */
      lap: number;
      lapTime: number;
      /** True if this is the racer's own fastest lap so far. */
      personalBest: boolean;
      /** True if it is the fastest lap anyone has set. */
      raceBest: boolean;
      time: number;
    }
  | { type: 'missedGate'; boatId: number; checkpoint: number; time: number }
  | { type: 'wrongWay'; boatId: number; active: boolean; time: number }
  | { type: 'position'; boatId: number; from: number; to: number; time: number }
  | { type: 'finish'; boatId: number; place: number; totalTime: number; time: number }
  | { type: 'raceEnd'; time: number };

export interface RaceDirectorOptions {
  laps?: number;
  /** Seconds from `start()` to GO. Split evenly into 3-2-1-GO. */
  countdownDuration?: number;
  /** Seconds after the last finisher before the phase moves to `results`. */
  resultsDelay?: number;
  /**
   * Seconds after the *player* finishes before the AI are force-finished and
   * the results come up. Without this a race can hang on a stuck opponent.
   */
  postPlayerTimeout?: number;
  /** Boat id treated as the human player, for the timeout above. */
  playerId?: number;
}

/** Per-racer bookkeeping that is not part of the public `RacerProgress`. */
interface RacerInternal {
  /** Cached spline parameter, used as the projection hint next frame. */
  hintT: number;
  /** Continuous, unwrapped lap progress. */
  continuous: number;
  /** Signed along-gate distance to the pending checkpoint, previous frame. */
  prevGateDistance: number;
  /** True once `prevGateDistance` holds a real value. */
  gatePrimed: boolean;
  missedReported: boolean;
  /**
   * True if the racer has been grossly outside the corridor since it last
   * banked a gate. See the anti-cut note in `checkCheckpoint`.
   */
  cutSinceGate: boolean;
  /** Metres of circuit swept while grossly off line. See CUT_DISTANCE. */
  cutDistance: number;
  wrongWayTimer: number;
  rightWayTimer: number;
  lapStartTime: number;
  bestLap: number;
  /** Placement last frame, so changes can be reported once. */
  lastPosition: number;
  /**
   * Split at each gate on the lap in progress, indexed by checkpoint, `-1`
   * where the gate has not been reached yet.
   *
   * Kept separate from `bestSplits` because the interesting comparison for a
   * HUD is against the racer's own best time *at that point on the track*, not
   * against their best lap as a whole — a driver can be up on the first half of
   * a lap and still lose it in the chicane, and the split deltas are what make
   * that legible.
   */
  splits: number[];
  /** Best split ever recorded at each gate, `-1` if never reached. */
  bestSplits: number[];
}

const _progress: CourseProgress = { t: 0, distanceAlong: 0, lateralOffset: 0 };
const _tangent = new Vector3();

/** Beeps before GO. 3-2-1, then 0 which is GO itself. */
const COUNTDOWN_BEEPS = 3;

/**
 * Multiple of the corridor half-width beyond which a racer on the *inside* of a
 * corner counts as having cut it.
 *
 * Sized from measurement: boat-to-boat contact throws a racer a little over two
 * corridor widths out, while cutting the hairpin chord puts it four and a half.
 * Three separates them.
 */
const CUT_CORRIDOR_MULTIPLE = 3;
/**
 * And the same beyond which it counts as having left the course whichever side
 * it went. Deliberately much further out: see the note on sidedness below.
 */
const LEFT_COURSE_MULTIPLE = 5.5;
/**
 * Curvature, 1/m, above which the course is curving enough for "inside" and
 * "outside" to mean anything. 1/500 m; the Grand Sweeper's 271 m radius clears
 * it comfortably and a straight does not.
 */
const CUT_MIN_CURVATURE = 0.002;
/**
 * Metres of circuit that may go past while a racer is grossly off line on the
 * inside before it counts as a cut. Between the 64 m of the worst honest
 * excursion and the 174 m of cutting The Pin.
 */
const CUT_DISTANCE = 105;
/** How fast the tally unwinds once the racer is back where it belongs. */
const CUT_DECAY = 0.5;

export class RaceDirector {
  phase: RacePhase = 'intro';
  readonly progress: RacerProgress[] = [];
  /** 3, 2, 1, then 0 which means GO. Meaningless outside `countdown`. */
  countdownValue = 3;
  onEvent: ((e: RaceEvent) => void) | null = null;

  readonly laps: number;
  readonly countdownDuration: number;
  readonly resultsDelay: number;
  readonly postPlayerTimeout: number;
  readonly playerId: number;

  /** Seconds since GO. Frozen per racer at their finish, but keeps running here. */
  raceTime = 0;
  /** Fastest lap set by anyone, seconds, or 0. */
  bestLapTime = 0;
  bestLapBoatId = -1;

  private readonly course: Course;
  private readonly internal: RacerInternal[] = [];
  private phaseTime = 0;
  private finishers = 0;
  private playerFinishTime = -1;
  private endEmitted = false;

  constructor(course: Course, racerCount: number, opts: RaceDirectorOptions = {}) {
    this.course = course;
    this.laps = opts.laps ?? DEFAULT_LAPS;
    this.countdownDuration = opts.countdownDuration ?? 3.6;
    this.resultsDelay = opts.resultsDelay ?? 3.2;
    this.postPlayerTimeout = opts.postPlayerTimeout ?? 22;
    this.playerId = opts.playerId ?? 0;

    for (let i = 0; i < racerCount; i++) {
      this.progress.push({
        boatId: i,
        lap: 0,
        lapProgress: 0,
        totalProgress: 0,
        position: i + 1,
        nextCheckpoint: 1,
        wrongWay: false,
        lapTimes: [],
        totalTime: 0,
        finished: false,
        finishPosition: 0,
      });
      this.internal.push(blankInternal(course.checkpoints.length));
    }
    this.reset();
  }

  // -------------------------------------------------------------------------
  // Control
  // -------------------------------------------------------------------------

  /** Begin the countdown. No-op once the race is under way. */
  start(): void {
    if (this.phase !== 'intro') return;
    this.setPhase('countdown');
    this.countdownValue = COUNTDOWN_BEEPS;
    this.emit({ type: 'countdown', value: this.countdownValue, time: 0 });
  }

  reset(): void {
    this.phase = 'intro';
    this.phaseTime = 0;
    this.raceTime = 0;
    this.countdownValue = COUNTDOWN_BEEPS;
    this.bestLapTime = 0;
    this.bestLapBoatId = -1;
    this.finishers = 0;
    this.playerFinishTime = -1;
    this.endEmitted = false;

    for (let i = 0; i < this.progress.length; i++) {
      const p = this.progress[i];
      p.lap = 0;
      p.lapProgress = 0;
      p.totalProgress = 0;
      p.position = i + 1;
      // Gate 0 *is* the start/finish line and the grid sits behind it, so the
      // first gate a racer owes is gate 1. Crossing gate 0 on lap one is the
      // start, not a lap completion.
      p.nextCheckpoint = 1;
      p.wrongWay = false;
      p.lapTimes.length = 0;
      p.totalTime = 0;
      p.finished = false;
      p.finishPosition = 0;

      const s = this.internal[i];
      const slot = this.course.startGrid[Math.min(i, this.course.startGrid.length - 1)];
      const gridT = this.course.closestT(slot.position);
      s.hintT = gridT;
      // The grid is behind the line, so start progress marginally negative and
      // let it cross zero when the boats actually take the flag.
      s.continuous = gridT - 1;
      s.prevGateDistance = 0;
      s.gatePrimed = false;
      s.missedReported = false;
      s.cutSinceGate = false;
      s.cutDistance = 0;
      s.wrongWayTimer = 0;
      s.rightWayTimer = 0;
      s.lapStartTime = 0;
      s.bestLap = 0;
      s.lastPosition = i + 1;
      s.splits.fill(-1);
      s.bestSplits.fill(-1);
    }
  }

  /** Skip the countdown, e.g. for the screenshot harness. */
  forceRacing(): void {
    if (this.phase === 'intro' || this.phase === 'countdown') {
      this.countdownValue = 0;
      this.setPhase('racing');
    }
  }

  // -------------------------------------------------------------------------
  // Tick
  // -------------------------------------------------------------------------

  update(states: BoatState[], ctx: FrameContext): void {
    this.phaseTime += ctx.dt;

    switch (this.phase) {
      case 'intro':
        // Projection is still tracked during the intro so the flyby camera and
        // the minimap have somewhere to point.
        this.trackProgress(states, ctx, false);
        break;

      case 'countdown': {
        this.trackProgress(states, ctx, false);
        const remaining = this.countdownDuration - this.phaseTime;
        // The countdown is divided into COUNTDOWN_BEEPS equal slices regardless
        // of its total duration, so 3-2-1-GO stays evenly paced whether the
        // caller asks for 3 seconds or 6. Reported only when the integer changes
        // so the audio bus does not retrigger the beep every frame.
        const value = clamp(
          Math.ceil((remaining * COUNTDOWN_BEEPS) / Math.max(this.countdownDuration, 1e-3)),
          0,
          COUNTDOWN_BEEPS,
        );
        if (value !== this.countdownValue) {
          this.countdownValue = value;
          this.emit({ type: 'countdown', value, time: 0 });
        }
        if (remaining <= 0) {
          this.countdownValue = 0;
          this.setPhase('racing');
        }
        break;
      }

      case 'racing': {
        this.raceTime += ctx.dt;
        this.trackProgress(states, ctx, true);
        this.sortPositions();
        this.checkRaceEnd();
        break;
      }

      case 'finished':
        this.raceTime += ctx.dt;
        this.trackProgress(states, ctx, true);
        this.sortPositions();
        if (this.phaseTime >= this.resultsDelay) this.setPhase('results');
        break;

      case 'results':
        this.trackProgress(states, ctx, false);
        break;
    }
  }

  // -------------------------------------------------------------------------
  // Progress and validation
  // -------------------------------------------------------------------------

  private trackProgress(states: BoatState[], ctx: FrameContext, live: boolean): void {
    for (const state of states) {
      const id = state.id;
      if (id < 0 || id >= this.progress.length) continue;
      const p = this.progress[id];
      const s = this.internal[id];

      this.course.progressInto(state.position, _progress, s.hintT);
      const t = _progress.t;

      // Unwrapped progress. Taking the delta the short way round is what makes
      // this continuous at the start/finish seam.
      const delta = Course.wrapDelta(t, s.hintT);
      s.hintT = t;
      s.continuous += delta;

      p.lapProgress = t;

      // Latch a gross departure from the course. Read at the next gate; see the
      // anti-cut note in `checkCheckpoint`.
      //
      // WHICH SIDE MATTERS
      //
      // Distance off the corridor alone cannot tell cutting from running wide,
      // and the two deserve opposite treatment: cutting shortens the lap and
      // must void the gate, while running wide already costs the racer the time
      // it took to get back and must not cost it the lap on top. Testing only
      // the magnitude punished both, and because the chicane corridor is 9 m
      // half-width, an ordinary understeery moment through there was three
      // corridor widths out and lost a whole lap — a 172 s lap against an 85 s
      // one, which is the single worst thing that can happen to a race.
      //
      // A cut is a departure towards the *inside* of a corner, which is exactly
      // where the signed curvature points: positive curvature bends towards the
      // left normal, and the lateral offset is measured along that same normal,
      // so the boat is on the inside when the two share a sign. Beyond
      // LEFT_COURSE_MULTIPLE the boat is so far out that it is not racing the
      // circuit at all and the side stops mattering.
      //
      // AND SO DOES HOW MUCH COURSE GOES BY
      //
      // Sidedness alone still misreads the chicane, because in an S-bend the
      // outside of one element is the inside of the next: a racer that ran wide
      // at Chicane In was, one spline sample later, "inside" Chicane Flick, and
      // lost the lap for it.
      //
      // What separates the two cleanly is not how long the racer is out there
      // but how much circuit goes past while it is. Measured: cutting the chord
      // of The Pin sweeps 174 m of spline, and running 34 m wide of the chicane
      // — the worst excursion the AI produces — sweeps 64 m. Note that *time*
      // gets this backwards, at 1.1 s for the cut against 2.5 s for the mistake,
      // which is exactly right and is the whole point: a cut is fast because it
      // is a straight line, and running wide is slow because it is a mistake.
      // Distance skipped is what cutting actually is, so distance is what to
      // measure. It decays rather than resetting so a cut cannot be chopped into
      // legal-length pieces.
      const off = Math.abs(_progress.lateralOffset);
      const widths = off / Math.max(this.course.widthAt(t), 1);
      let cutting = widths > LEFT_COURSE_MULTIPLE;
      if (!cutting && widths > CUT_CORRIDOR_MULTIPLE) {
        const k = this.course.signedCurvatureAt(t);
        cutting =
          Math.abs(k) > CUT_MIN_CURVATURE && Math.sign(_progress.lateralOffset) === Math.sign(k);
      }
      const swept = Math.abs(delta) * this.course.length;
      s.cutDistance = Math.max(0, s.cutDistance + (cutting ? swept : -swept * CUT_DECAY));
      if (s.cutDistance > CUT_DISTANCE) s.cutSinceGate = true;

      // Clamp to the validated lap count. A boat cannot be reported as more
      // than one lap ahead of the gates it has actually passed, which closes the
      // door on both spline glitches and deliberate cutting.
      const lo = p.lap - 0.06;
      const hi = p.lap + 1.0;
      p.totalProgress = s.continuous < lo ? lo : s.continuous > hi ? hi : s.continuous;

      if (!live || p.finished) {
        p.wrongWay = false;
        continue;
      }

      p.totalTime = this.raceTime;
      this.checkCheckpoint(state, p, s, ctx.dt);
      this.checkWrongWay(state, p, s, t, ctx.dt);
    }
  }

  /**
   * Test the pending gate.
   *
   * The gate is a plane through its centre with the course tangent as its
   * normal, clipped to the gate's opening. We look for a sign change in the
   * along-plane distance between frames rather than testing proximity, because
   * at 40 m/s a boat covers 0.67 m per frame and a proximity test would need a
   * radius big enough to also fire when driving *past* the gate off-line.
   */
  private checkCheckpoint(
    state: BoatState,
    p: RacerProgress,
    s: RacerInternal,
    dt: number,
  ): void {
    const cp = this.course.checkpoints[p.nextCheckpoint];
    const dx = state.position.x - cp.position.x;
    const dz = state.position.z - cp.position.z;

    const along = dx * cp.tangent.x + dz * cp.tangent.z;
    const across = dx * cp.tangent.z - dz * cp.tangent.x;

    if (!s.gatePrimed) {
      s.prevGateDistance = along;
      s.gatePrimed = true;
      return;
    }

    const prev = s.prevGateDistance;
    s.prevGateDistance = along;

    // Forward crossing only. Reversing back through a gate must not count, or a
    // boat parked on the line could oscillate its way around the circuit.
    const step = state.speed * dt * GATE_STEP_SAFETY + GATE_STEP_FLOOR;
    if (prev < 0 && along >= 0 && along - prev <= step && Math.abs(across) <= cp.validationWidth) {
      // The gate opening is now deliberately forgiving, so that a racer knocked
      // sideways by contact loses time rather than the whole lap. That
      // forgiveness must not become a licence to cut, and a momentary check at
      // the gate cannot tell the difference: a boat that drives straight across
      // the bay at the hairpin rejoins the course before the next gate and
      // arrives at it perfectly legally. There is no checkpoint inside The Pin
      // to catch it either — gates are placed away from high curvature on
      // purpose, because the plane test is ambiguous at an apex.
      //
      // So the test is over the whole segment rather than the instant: a racer
      // that left the course altogether since the last gate does not get this
      // one. Cutting any real corner here puts a boat three to five corridor
      // widths out; contact puts it barely two.
      if (s.cutSinceGate) {
        s.cutSinceGate = false;
        s.cutDistance = 0;
        return;
      }
      this.passGate(p, s);
      return;
    }

    if (!s.missedReported && along > MISSED_GATE_DISTANCE && prev <= along) {
      s.missedReported = true;
      this.emit({
        type: 'missedGate',
        boatId: p.boatId,
        checkpoint: p.nextCheckpoint,
        time: this.raceTime,
      });
    }
  }

  private passGate(p: RacerProgress, s: RacerInternal): void {
    const passed = p.nextCheckpoint;
    const count = this.course.checkpoints.length;
    p.nextCheckpoint = (passed + 1) % count;
    s.gatePrimed = false;
    s.missedReported = false;
    s.cutSinceGate = false;
    s.cutDistance = 0;

    // The split is measured from the start of the lap in progress, so it is
    // directly comparable with the same gate on any other lap.
    const split = this.raceTime - s.lapStartTime;
    const best = s.bestSplits[passed];
    s.splits[passed] = split;
    const splitDelta = best < 0 ? 0 : split - best;
    if (best < 0 || split < best) s.bestSplits[passed] = split;

    this.emit({
      type: 'gate',
      boatId: p.boatId,
      checkpoint: passed,
      lap: p.lap,
      split,
      splitDelta,
      time: this.raceTime,
    });

    // Gate 0 is the start/finish line: crossing it means the previous lap is
    // complete, which is only true once every other gate has been ticked off,
    // which the cursor guarantees.
    if (passed !== this.course.startFinishIndex) return;

    const lapTime = this.raceTime - s.lapStartTime;
    s.lapStartTime = this.raceTime;
    // Gate 0's own split belongs to the lap that just ended; the new lap starts
    // with a clean sheet.
    s.splits.fill(-1);
    p.lap += 1;
    p.lapTimes.push(lapTime);
    // Re-anchor the unwrapped counter to the lap that was just validated so it
    // cannot drift away from the gate cursor over a long race.
    s.continuous = p.lap;

    const personalBest = s.bestLap === 0 || lapTime < s.bestLap;
    if (personalBest) s.bestLap = lapTime;
    const raceBest = this.bestLapTime === 0 || lapTime < this.bestLapTime;
    if (raceBest) {
      this.bestLapTime = lapTime;
      this.bestLapBoatId = p.boatId;
    }

    this.emit({
      type: 'lap',
      boatId: p.boatId,
      lap: p.lap,
      lapTime,
      personalBest,
      raceBest,
      time: this.raceTime,
    });

    if (p.lap >= this.laps) this.finishRacer(p);
  }

  private finishRacer(p: RacerProgress): void {
    if (p.finished) return;
    p.finished = true;
    p.totalTime = this.raceTime;
    this.finishers += 1;
    p.finishPosition = this.finishers;
    p.wrongWay = false;
    if (p.boatId === this.playerId) this.playerFinishTime = this.raceTime;

    this.emit({
      type: 'finish',
      boatId: p.boatId,
      place: p.finishPosition,
      totalTime: p.totalTime,
      time: this.raceTime,
    });
  }

  /**
   * Latch/unlatch the wrong-way flag. See the header for why both directions
   * are timed rather than just the on transition.
   */
  private checkWrongWay(
    state: BoatState,
    p: RacerProgress,
    s: RacerInternal,
    t: number,
    dt: number,
  ): void {
    this.course.tangentAt(t, _tangent);
    const closing = state.velocity.x * _tangent.x + state.velocity.z * _tangent.z;

    // Below walking pace the sign of the closing speed is noise, and a boat
    // stopped against a buoy is not "going the wrong way". Above it, how much
    // reverse speed is needed depends on whether the hull is actually pointing
    // backwards — see WRONG_WAY_SHUNT_SPEED.
    const facing = state.forward.x * _tangent.x + state.forward.z * _tangent.z;
    const floor = facing < WRONG_WAY_FACING ? WRONG_WAY_MIN_SPEED : WRONG_WAY_SHUNT_SPEED;
    const backwards = state.speed > floor && closing < WRONG_WAY_SPEED;

    if (backwards) {
      s.wrongWayTimer += dt;
      s.rightWayTimer = 0;
    } else {
      s.rightWayTimer += dt;
      s.wrongWayTimer = 0;
    }

    if (!p.wrongWay && s.wrongWayTimer >= WRONG_WAY_ON) {
      p.wrongWay = true;
      this.emit({ type: 'wrongWay', boatId: p.boatId, active: true, time: this.raceTime });
    } else if (p.wrongWay && s.rightWayTimer >= WRONG_WAY_OFF) {
      p.wrongWay = false;
      this.emit({ type: 'wrongWay', boatId: p.boatId, active: false, time: this.raceTime });
    }
  }

  // -------------------------------------------------------------------------
  // Placement
  // -------------------------------------------------------------------------

  /**
   * Sort into race order and report changes.
   *
   * Finished racers are frozen at their finishing place — they must not slide
   * back down the order as the rest of the field catches up on total progress.
   */
  private sortPositions(): void {
    const order = this.progress.slice().sort(comparePlacement);
    for (let i = 0; i < order.length; i++) {
      const p = order[i];
      const place = i + 1;
      p.position = place;
      const s = this.internal[p.boatId];
      if (s.lastPosition !== place) {
        this.emit({
          type: 'position',
          boatId: p.boatId,
          from: s.lastPosition,
          to: place,
          time: this.raceTime,
        });
        s.lastPosition = place;
      }
    }
  }

  private checkRaceEnd(): void {
    if (this.finishers >= this.progress.length) {
      this.endRace();
      return;
    }
    // Backstop: once the player is home, give the field a window and then call
    // it. A race that never resolves because one AI is wedged is worse than an
    // AI that gets a charitable classification.
    if (
      this.playerFinishTime >= 0 &&
      this.raceTime - this.playerFinishTime >= this.postPlayerTimeout
    ) {
      for (const p of this.progress) if (!p.finished) this.finishRacer(p);
      this.endRace();
    }
  }

  private endRace(): void {
    if (this.endEmitted) return;
    this.endEmitted = true;
    this.setPhase('finished');
    this.emit({ type: 'raceEnd', time: this.raceTime });
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  /** Progress record for a boat id, or null. */
  get(boatId: number): RacerProgress | null {
    return this.progress[boatId] ?? null;
  }

  /** Race order, best first. A fresh array; do not call this per frame. */
  standings(): RacerProgress[] {
    return this.progress.slice().sort(comparePlacement);
  }

  /**
   * Signed gap to another racer along the course, in metres. Positive means
   * `other` is ahead. Used by the AI's rubber-banding.
   */
  gapMetres(boatId: number, otherId: number): number {
    const a = this.progress[boatId];
    const b = this.progress[otherId];
    if (!a || !b) return 0;
    return (b.totalProgress - a.totalProgress) * this.course.length;
  }

  /** Lateral offset of a racer from the racing line, metres, positive = left. */
  lateralOffset(state: BoatState): number {
    const s = this.internal[state.id];
    this.course.progressInto(state.position, _progress, s?.hintT);
    return _progress.lateralOffset;
  }

  /** True while the racer is outside the drivable corridor. */
  offCourse(state: BoatState): boolean {
    const s = this.internal[state.id];
    this.course.progressInto(state.position, _progress, s?.hintT);
    return Math.abs(_progress.lateralOffset) > this.course.widthAt(_progress.t);
  }

  /**
   * Splits for the lap a racer is currently on, indexed by checkpoint, with
   * `-1` for gates not yet reached this lap. Live array — do not mutate.
   */
  splits(boatId: number): readonly number[] | null {
    return this.internal[boatId]?.splits ?? null;
  }

  /**
   * The racer's best split at each checkpoint, `-1` where never set. Together
   * with `splits()` this gives a HUD everything it needs for a running delta.
   */
  bestSplits(boatId: number): readonly number[] | null {
    return this.internal[boatId]?.bestSplits ?? null;
  }

  /** Fastest lap the racer has completed, seconds, or 0 if none yet. */
  bestLap(boatId: number): number {
    return this.internal[boatId]?.bestLap ?? 0;
  }

  /** World position and orientation of a racer's next gate, for HUD arrows. */
  nextGate(boatId: number): { position: Vector3; tangent: Vector3 } | null {
    const p = this.progress[boatId];
    if (!p) return null;
    const cp = this.course.checkpoints[p.nextCheckpoint];
    return { position: cp.position, tangent: cp.tangent };
  }

  private setPhase(phase: RacePhase): void {
    if (this.phase === phase) return;
    this.phase = phase;
    this.phaseTime = 0;
    if (phase === 'racing') {
      this.raceTime = 0;
      for (const s of this.internal) {
        s.lapStartTime = 0;
        // Re-prime the gate test at the flag: the boats have been sitting on the
        // grid with a stale `prevGateDistance` from the reset.
        s.gatePrimed = false;
      }
    }
    this.emit({ type: 'phase', phase, time: this.raceTime });
  }

  private emit(e: RaceEvent): void {
    this.onEvent?.(e);
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function blankInternal(gateCount: number): RacerInternal {
  return {
    hintT: 0,
    continuous: 0,
    prevGateDistance: 0,
    gatePrimed: false,
    missedReported: false,
    cutSinceGate: false,
    cutDistance: 0,
    wrongWayTimer: 0,
    rightWayTimer: 0,
    lapStartTime: 0,
    bestLap: 0,
    lastPosition: 1,
    splits: new Array<number>(gateCount).fill(-1),
    bestSplits: new Array<number>(gateCount).fill(-1),
  };
}

function comparePlacement(a: RacerProgress, b: RacerProgress): number {
  if (a.finished !== b.finished) return a.finished ? -1 : 1;
  if (a.finished && b.finished) return a.finishPosition - b.finishPosition;
  return b.totalProgress - a.totalProgress;
}
