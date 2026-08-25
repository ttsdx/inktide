import { CatmullRomCurve3, MathUtils, Vector3 } from 'three';
import type { CoursePoint } from '../contracts.ts';
import { WAVES, oceanHeight } from '../world/gerstner.ts';

/**
 * THE CIRCUIT — "Windward Reef"
 *
 * The track is authored as a *turtle walk* over a table of named straights and
 * circular arcs rather than as a hand-placed list of spline knots. Three
 * reasons, all of them about being able to change the layout later without
 * breaking it:
 *
 *   1. Radii are stated directly, so the corner speeds are known at authoring
 *      time (`v = sqrt(a_lat / kappa)`) instead of being an emergent property
 *      of whatever the spline happened to do between two knots.
 *   2. The loop is *solved* closed. Two of the section dimensions are left free
 *      — the length of the start/finish straight and the scale of the big
 *      sweeper — and because the walk's end position is affine in those two
 *      numbers, closure is a single 2x2 solve at construction. Editing any
 *      other section re-solves those two automatically, so the circuit can
 *      never end up with a kink at the seam.
 *   3. Control points are emitted at a bounded angular step, so the centripetal
 *      Catmull-Rom that interpolates them tracks the intended arcs to well
 *      under a metre and never overshoots into a cusp.
 *
 * ORIENTATION AGAINST THE SWELL
 *
 * The whole layout is authored in a rotated (U, V) frame where +V is the travel
 * direction of the dominant 112 m swell (`WAVES[0]`) and +U is perpendicular to
 * it. The start/finish straight is authored at heading 0, i.e. exactly along
 * +U, which makes `dot(tangent, swellDir) == 0` true by construction rather
 * than by tuning.
 *
 * That heading is the airtime section, and it is worth being precise about why,
 * because the naive reason ("you cross the crests square on") is actually
 * backwards: crest *lines* run perpendicular to a wave's travel direction, so
 * driving perpendicular to `WAVES[0]` means driving *along* its crest line and
 * feeling it only at its 8.5 s temporal period. The launches come from the
 * other five waves in the table:
 *
 *   - `WAVES[1]` (1.35 m, 78.5 m long) has direction (0.502, -0.865), which is
 *     `dot = -0.975` against +U — very nearly head-on. Closing speed at 33 m/s
 *     is 33*0.975 + 11.4 = 43.6 m/s, so a 2.5 m crest-to-trough roller arrives
 *     every 1.8 s for the whole 680 m straight. That is the launch ramp.
 *   - `WAVES[4]` (0.3 m, 14.3 m) is also head-on and puts hard chop on the
 *     faces so the take-off is never clean.
 *   - `WAVES[0]` meanwhile heaves the whole straight up and down slowly, which
 *     modulates how big each launch is instead of making them uniform.
 *
 * The net effect is what the brief asked for — a straight where boats are in
 * the air more than they are on the water — and it is reproducible because it
 * is derived from the wave table rather than eyeballed.
 */

// ---------------------------------------------------------------------------
// The swell frame
// ---------------------------------------------------------------------------

const _swellLen = Math.hypot(WAVES[0].dirX, WAVES[0].dirZ) || 1;

/** Travel direction of the dominant swell in world XZ. +V of the author frame. */
export const SWELL_DIR_X = WAVES[0].dirX / _swellLen;
export const SWELL_DIR_Z = WAVES[0].dirZ / _swellLen;

/** Perpendicular to the swell. +U of the author frame; the airtime heading. */
export const ACROSS_SWELL_X = -SWELL_DIR_Z;
export const ACROSS_SWELL_Z = SWELL_DIR_X;

/** (U, V) -> world XZ. An isometry, so lengths and radii carry over exactly. */
function toWorldX(u: number, v: number): number {
  return ACROSS_SWELL_X * u + SWELL_DIR_X * v;
}
function toWorldZ(u: number, v: number): number {
  return ACROSS_SWELL_Z * u + SWELL_DIR_Z * v;
}

// ---------------------------------------------------------------------------
// Section table
// ---------------------------------------------------------------------------

export type SectionKind = 'straight' | 'arc';

/** A finished section, with its span on the spline resolved. */
export interface CourseSection {
  readonly name: string;
  /** Why this section exists, for anyone re-tuning the layout. */
  readonly note: string;
  readonly kind: SectionKind;
  /** Half-width of the drivable corridor through this section, metres. */
  readonly halfWidth: number;
  /** Signed turn radius in metres; Infinity on straights. */
  readonly radius: number;
  /** Signed sweep in degrees. Positive turns left (towards the left normal). */
  readonly sweepDeg: number;
  /** Arc length of the section along the authored polyline. */
  readonly length: number;
  /** Normalised arc-length span on the spline. `t1` may wrap past 1 for the last. */
  readonly t0: number;
  readonly t1: number;
}

interface RawSection {
  name: string;
  note: string;
  halfWidth: number;
  /** Straight length in metres. Mutually exclusive with radius/sweep. */
  length?: number;
  radius?: number;
  sweepDeg?: number;
}

/**
 * The layout. `runLength` and `sweeperScale` are the two free dimensions the
 * closure solve fills in; everything else is authored.
 *
 * Corner speeds quoted below assume an 8 m/s^2 lateral budget, which is roughly
 * what a hull at `slidiness` 0.3 will hold before it starts washing out.
 */
function layout(runLength: number, sweeperScale: number): RawSection[] {
  return [
    {
      // ---- THE AIRTIME SECTION, and the start/finish line sits at its start.
      // Authored at heading 0 = exactly perpendicular to WAVES[0]; see the file
      // header for why that is the launch heading. ~680 m of open water with a
      // 2.5 m roller arriving every 1.8 s.
      name: 'Windward Run',
      note: 'Start/finish straight. Runs across the swell — boats spend more of it airborne than wet.',
      halfWidth: 15.5,
      length: runLength,
    },
    {
      // ---- THE HAIRPIN. 56 m radius holds ~21 m/s, i.e. about 60% of top
      // speed, so it is the one corner that must be braked for properly and the
      // one place a drift is mandatory rather than optional.
      name: 'The Pin',
      note: 'Hairpin at the far end of the run. 56 m radius: brake hard, drift, boost out.',
      halfWidth: 12.5,
      radius: 56,
      sweepDeg: 180,
    },
    {
      name: 'Kickback',
      note: 'Short breather out of the hairpin so the drift has somewhere to land.',
      halfWidth: 13,
      length: 92,
    },
    {
      name: 'Reef Bend',
      note: 'Fast right-hander that turns the track off the return leg and out onto the drag.',
      halfWidth: 14,
      radius: 135,
      sweepDeg: -52,
    },
    {
      // ---- THE SECOND FAST STRAIGHT. Runs 38 deg off the swell direction, so
      // the boats surf along the faces here instead of launching off them. The
      // contrast with the Windward Run is deliberate: two long straights that
      // feel completely different.
      name: 'Leeward Drag',
      note: 'Fast straight angled with the swell — long surfing runs, top speed, no air.',
      halfWidth: 17,
      length: 300,
    },
    {
      name: 'Coral Turn',
      note: 'Mirror of Reef Bend, feeding the chicane. Nearly flat out.',
      halfWidth: 14,
      radius: 135,
      sweepDeg: 52,
    },
    // ---- THE CHICANE. Five elements, 60 m radii, and the corridor pinches to
    // 8.5 m — narrower than anywhere else on the lap. At 22 m/s there is no
    // room to carry a slide through it, which is what makes it the section that
    // actually separates a clean AI from an aggressive one.
    {
      name: 'Chicane In',
      note: 'Chicane entry. Corridor pinches to 8.5 m from here to the exit.',
      halfWidth: 9,
      radius: 60,
      sweepDeg: 32,
    },
    { name: 'Chicane Mid A', note: 'Chicane link.', halfWidth: 8.5, length: 22 },
    {
      name: 'Chicane Flick',
      note: 'The direction change. Twice the sweep of the entry, same radius.',
      halfWidth: 8.5,
      radius: 60,
      sweepDeg: -64,
    },
    { name: 'Chicane Mid B', note: 'Chicane link.', halfWidth: 8.5, length: 22 },
    {
      name: 'Chicane Out',
      note: 'Chicane exit, corridor opens back up.',
      halfWidth: 10,
      radius: 60,
      sweepDeg: 32,
    },
    {
      name: 'Windward Approach',
      note: 'Short run-up that squares the boats off for the sweeper entry.',
      halfWidth: 15,
      length: 110,
    },
    // ---- THE WIDE SWEEPER, as a decreasing-radius pair rather than one arc.
    // A constant-radius 180 is a hold-the-wheel corner; tightening it on exit
    // means the entry line you choose determines whether you get on the power
    // early, which is the only thing that makes a 750 m corner interesting.
    {
      name: 'Sweeper In',
      note: 'Wide sweeper, opening phase. ~270 m radius — flat out if you commit.',
      halfWidth: 22,
      radius: 1.26 * sweeperScale,
      sweepDeg: 112,
    },
    {
      name: 'Sweeper Out',
      note: 'Sweeper tightens to ~172 m on exit. Punishes an early apex.',
      halfWidth: 18,
      radius: 0.8 * sweeperScale,
      sweepDeg: 68,
    },
    // ---- A fast S onto the start/finish straight. Its only job is to stop the
    // Windward Run being a quarter of the lap in one unbroken line.
    { name: 'Salt Kink A', note: 'Fast kink onto the main straight.', halfWidth: 15, radius: 260, sweepDeg: 16 },
    { name: 'Salt Kink B', note: 'Fast kink link.', halfWidth: 15, length: 30 },
    { name: 'Salt Kink C', note: 'Fast kink, unwinding onto the line.', halfWidth: 15, radius: 260, sweepDeg: -16 },
    {
      // Dead straight, and long enough to hold the whole 2x2 grid. The start
      // slots are authored as negative distances from t = 0, so without this
      // the back row would sit inside Salt Kink C and the four boats would
      // start on four different headings.
      name: 'Grid Approach',
      note: 'Straight run to the line. Holds the start grid; continuous with the Windward Run.',
      halfWidth: 15.5,
      length: 74,
    },
  ];
}

/** Longest gap between emitted control points on a straight, metres. */
const STRAIGHT_STEP = 24;
/** Largest angular step between emitted control points on an arc, degrees. */
const ARC_STEP_DEG = 11;

interface WalkResult {
  /** Author-frame control points, first point at the origin, no duplicate close. */
  u: number[];
  v: number[];
  /** Index into `u`/`v` of the first point of each section. */
  sectionStart: number[];
  /** Polyline arc length of each section. */
  sectionLength: number[];
  endU: number;
  endV: number;
  total: number;
}

/**
 * Walk the section table, emitting control points in the author frame.
 *
 * Headings are in degrees with 0 along +U and positive sweeps turning towards
 * +V (i.e. left, matching the left-hand normal convention in `CoursePoint`).
 */
function walk(sections: RawSection[]): WalkResult {
  const u: number[] = [0];
  const v: number[] = [0];
  const sectionStart: number[] = [];
  const sectionLength: number[] = [];

  let cu = 0;
  let cv = 0;
  let heading = 0;
  let total = 0;

  for (const s of sections) {
    sectionStart.push(u.length - 1);

    if (s.length !== undefined) {
      const steps = Math.max(1, Math.ceil(s.length / STRAIGHT_STEP));
      const dx = Math.cos(heading * MathUtils.DEG2RAD);
      const dy = Math.sin(heading * MathUtils.DEG2RAD);
      const u0 = cu;
      const v0 = cv;
      for (let i = 1; i <= steps; i++) {
        const d = (s.length * i) / steps;
        u.push(u0 + dx * d);
        v.push(v0 + dy * d);
      }
      cu = u0 + dx * s.length;
      cv = v0 + dy * s.length;
      sectionLength.push(s.length);
      total += s.length;
    } else {
      const r = s.radius ?? 1;
      const sweep = (s.sweepDeg ?? 0) * MathUtils.DEG2RAD;
      const sign = Math.sign(sweep) || 1;
      // Centre sits a radius away, 90 deg to the turn side of the heading.
      const perp = heading * MathUtils.DEG2RAD + (sign * Math.PI) / 2;
      const ccu = cu + Math.cos(perp) * r;
      const ccv = cv + Math.sin(perp) * r;
      const a0 = Math.atan2(cv - ccv, cu - ccu);
      const steps = Math.max(2, Math.ceil(Math.abs(s.sweepDeg ?? 0) / ARC_STEP_DEG));
      for (let i = 1; i <= steps; i++) {
        const a = a0 + (sweep * i) / steps;
        u.push(ccu + Math.cos(a) * r);
        v.push(ccv + Math.sin(a) * r);
      }
      cu = ccu + Math.cos(a0 + sweep) * r;
      cv = ccv + Math.sin(a0 + sweep) * r;
      heading += s.sweepDeg ?? 0;
      const len = r * Math.abs(sweep);
      sectionLength.push(len);
      total += len;
    }
  }

  // The walk closes on itself, so the final point duplicates the first; drop it
  // because CatmullRomCurve3 in closed mode adds the wrap segment itself.
  u.pop();
  v.pop();

  return { u, v, sectionStart, sectionLength, endU: cu, endV: cv, total };
}

/**
 * Solve the two free dimensions so the loop closes exactly.
 *
 * The walk's end point is affine in (runLength, sweeperScale): the run
 * contributes a fixed unit direction scaled by its length, and scaling both
 * sweeper radii scales that whole sub-arc's displacement linearly. So evaluate
 * the walk three times to get the affine basis and invert a 2x2.
 */
function solveClosure(): { runLength: number; sweeperScale: number } {
  const base = walk(layout(0, 0));
  const dRun = walk(layout(1, 0));
  const dSweep = walk(layout(0, 1));

  const a11 = dRun.endU - base.endU;
  const a12 = dSweep.endU - base.endU;
  const a21 = dRun.endV - base.endV;
  const a22 = dSweep.endV - base.endV;
  const det = a11 * a22 - a12 * a21;

  return {
    runLength: (-base.endU * a22 + base.endV * a12) / det,
    sweeperScale: (-a11 * base.endV + a21 * base.endU) / det,
  };
}

// ---------------------------------------------------------------------------
// Lookup tables
// ---------------------------------------------------------------------------

/**
 * Number of arc-length-uniform samples in the fine table. 2048 over ~2700 m is
 * a sample every 1.3 m, which is finer than the shortest wave in the ocean
 * (8.15 m) and finer than a hull length, so nothing the player can perceive
 * falls between two samples.
 */
const LUT = 2048;

/** Stride used for the global nearest-point scan. 2048/8 = 256 probes. */
const COARSE_STRIDE = 8;

/**
 * Half-window, in fine samples, of the hinted nearest-point search. 24 samples
 * is ~32 m; a boat at 40 m/s moves 0.67 m per frame, so this tolerates a
 * two-order-of-magnitude frame spike before it has to fall back.
 */
const HINT_WINDOW = 24;

/**
 * Baseline for the curvature finite difference, in fine samples. Differencing
 * the tangent angle over ~8 m rather than over one sample keeps the spline's
 * own polynomial ripple out of the result; boats respond to curvature averaged
 * over roughly their own length anyway.
 */
const CURV_HALF = 3;
/** Box-filter half-width applied to curvature afterwards, in fine samples. */
const CURV_SMOOTH = 8;

/** Metres over which the corridor width blends between adjacent sections. */
const WIDTH_BLEND = 28;

export interface Checkpoint {
  /** Index in `Course.checkpoints`. */
  readonly index: number;
  readonly t: number;
  readonly position: Vector3;
  readonly tangent: Vector3;
  /** Half-width of the gate opening, metres. Wider than the corridor. */
  readonly width: number;
  /** True for the one gate that is also the start/finish line. */
  readonly startFinish: boolean;
}

export interface StartSlot {
  readonly position: Vector3;
  /** Yaw such that forward = (sin(h), 0, cos(h)) — the three.js Y-rotation. */
  readonly heading: number;
}

export interface CourseProgress {
  t: number;
  distanceAlong: number;
  lateralOffset: number;
}

const _v0 = new Vector3();
const _v1 = new Vector3();

export interface CourseOptions {
  /** How many checkpoint gates to place. Clamped to 10..14 by the brief. */
  checkpointCount?: number;
  /** Number of grid slots. */
  gridSlots?: number;
}

export class Course {
  readonly curve: CatmullRomCurve3;
  /** Total lap length in metres, measured on the spline. */
  readonly length: number;
  readonly sections: readonly CourseSection[];
  readonly checkpoints: readonly Checkpoint[];
  readonly startGrid: readonly StartSlot[];
  /** Index into `checkpoints` of the start/finish gate. Always 0. */
  readonly startFinishIndex = 0;
  /** The section boats get airborne on, exposed so the HUD can name it. */
  readonly airtimeSection: CourseSection;

  // Fine arc-length-uniform tables. Parallel arrays, not objects, because these
  // are read several thousand times a frame.
  private readonly px = new Float32Array(LUT);
  private readonly pz = new Float32Array(LUT);
  private readonly tx = new Float32Array(LUT);
  private readonly tz = new Float32Array(LUT);
  /** Signed curvature, 1/m. Positive turns left. */
  private readonly kappa = new Float32Array(LUT);
  private readonly halfWidth = new Float32Array(LUT);

  private readonly ds: number;

  constructor(opts: CourseOptions = {}) {
    const { runLength, sweeperScale } = solveClosure();
    const raw = layout(runLength, sweeperScale);
    const w = walk(raw);

    // Centre the layout on the world origin. The ocean is unbounded so this is
    // purely so the camera far plane and the wake field's finite extent are
    // used symmetrically.
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (let i = 0; i < w.u.length; i++) {
      minU = Math.min(minU, w.u[i]);
      maxU = Math.max(maxU, w.u[i]);
      minV = Math.min(minV, w.v[i]);
      maxV = Math.max(maxV, w.v[i]);
    }
    const offU = -(minU + maxU) * 0.5;
    const offV = -(minV + maxV) * 0.5;

    const points: Vector3[] = [];
    for (let i = 0; i < w.u.length; i++) {
      const u = w.u[i] + offU;
      const v = w.v[i] + offV;
      points.push(new Vector3(toWorldX(u, v), 0, toWorldZ(u, v)));
    }

    this.curve = new CatmullRomCurve3(points, true, 'centripetal', 0.5);
    // The default 200 divisions would quantise the arc-length map to ~13 m,
    // which shows up as visible bunching in the ribbon's chevron spacing.
    this.curve.arcLengthDivisions = 6000;
    this.length = this.curve.getLength();
    this.ds = this.length / LUT;

    this.fillPositions();
    this.fillTangents();
    this.fillCurvature();

    this.sections = this.resolveSections(raw, w, points);
    this.fillWidths(this.sections);
    this.airtimeSection = this.sections[0];

    this.checkpoints = this.placeCheckpoints(
      MathUtils.clamp(opts.checkpointCount ?? 12, 10, 14),
    );
    this.startGrid = this.buildGrid(opts.gridSlots ?? 4);
  }

  // -------------------------------------------------------------------------
  // Table construction
  // -------------------------------------------------------------------------

  private fillPositions(): void {
    const p = new Vector3();
    for (let i = 0; i < LUT; i++) {
      this.curve.getPointAt(i / LUT, p);
      this.px[i] = p.x;
      this.pz[i] = p.z;
    }
  }

  private fillTangents(): void {
    // Central difference on the arc-length-uniform positions. This is both
    // cheaper and better conditioned than CatmullRomCurve3.getTangentAt, which
    // differences the *parametric* curve and therefore inherits the knot
    // spacing's non-uniformity.
    for (let i = 0; i < LUT; i++) {
      const a = (i + LUT - 1) % LUT;
      const b = (i + 1) % LUT;
      const dx = this.px[b] - this.px[a];
      const dz = this.pz[b] - this.pz[a];
      const inv = 1 / (Math.hypot(dx, dz) || 1);
      this.tx[i] = dx * inv;
      this.tz[i] = dz * inv;
    }
  }

  private fillCurvature(): void {
    const rawK = new Float32Array(LUT);
    for (let i = 0; i < LUT; i++) {
      const a = (i - CURV_HALF + LUT) % LUT;
      const b = (i + CURV_HALF) % LUT;
      // Signed angle from tangent(a) to tangent(b), via the 2D cross/dot pair
      // so it is continuous across the +-pi seam.
      const cross = this.tx[a] * this.tz[b] - this.tz[a] * this.tx[b];
      const dot = this.tx[a] * this.tx[b] + this.tz[a] * this.tz[b];
      const dTheta = Math.atan2(cross, dot);
      // World XZ is left-handed with respect to the (x, z) plane read as (x, y),
      // so a positive atan2 there is a *right* turn in world terms. Negate to
      // make positive curvature mean "turns towards the left-hand normal".
      rawK[i] = -dTheta / (2 * CURV_HALF * this.ds);
    }

    // Box filter. Curvature from finite differences of an interpolating spline
    // ripples at the knot frequency; a boat cannot respond to that and the AI
    // must not brake for it.
    const n = CURV_SMOOTH * 2 + 1;
    for (let i = 0; i < LUT; i++) {
      let sum = 0;
      for (let j = -CURV_SMOOTH; j <= CURV_SMOOTH; j++) {
        sum += rawK[(i + j + LUT) % LUT];
      }
      this.kappa[i] = sum / n;
    }
  }

  /**
   * Resolve each authored section's span on the spline by projecting its first
   * control point onto the fine table. Using the polyline's cumulative length
   * as a proxy would be off by the spline/polyline discrepancy, which is small
   * but enough to put a corridor-width transition in the wrong place.
   */
  private resolveSections(
    raw: RawSection[],
    w: WalkResult,
    points: Vector3[],
  ): CourseSection[] {
    const starts: number[] = [];
    for (let i = 0; i < raw.length; i++) {
      const idx = w.sectionStart[i] % points.length;
      starts.push(this.closestT(points[idx]));
    }
    // Section 0 starts at the seam, where the projection can land either side
    // of t = 1. Pin it, then force the rest monotonic so the width rasteriser
    // and `sectionAt` can rely on a simple ordered scan.
    starts[0] = 0;
    for (let i = 1; i < starts.length; i++) {
      if (starts[i] <= starts[i - 1]) starts[i] = Math.min(1, starts[i - 1] + 1e-4);
    }

    const out: CourseSection[] = [];
    for (let i = 0; i < raw.length; i++) {
      const s = raw[i];
      const t0 = starts[i];
      const t1 = i + 1 < raw.length ? starts[i + 1] : 1;
      out.push({
        name: s.name,
        note: s.note,
        kind: s.length !== undefined ? 'straight' : 'arc',
        halfWidth: s.halfWidth,
        radius: s.radius ?? Infinity,
        sweepDeg: s.sweepDeg ?? 0,
        length: w.sectionLength[i],
        t0,
        t1,
      });
    }
    return out;
  }

  /**
   * Rasterise the per-section corridor widths into the fine table, blending
   * over `WIDTH_BLEND` metres at each boundary. A hard step in the corridor
   * would make the buoy line and the AI's apex offsets jump.
   */
  private fillWidths(sections: readonly CourseSection[]): void {
    // Nearest-boundary blend: for each sample find its section, then lerp
    // towards the neighbouring section's width based on distance to the seam.
    const idxOf = new Int32Array(LUT);
    let cur = 0;
    for (let i = 0; i < LUT; i++) {
      const t = i / LUT;
      while (cur + 1 < sections.length && t >= sections[cur + 1].t0) cur++;
      idxOf[i] = cur;
    }

    const blendSamples = Math.max(1, Math.round(WIDTH_BLEND / this.ds));
    for (let i = 0; i < LUT; i++) {
      const here = sections[idxOf[i]].halfWidth;
      const prev = sections[idxOf[(i - blendSamples + LUT) % LUT]].halfWidth;
      const next = sections[idxOf[(i + blendSamples) % LUT]].halfWidth;
      // A symmetric three-tap does the same job as a search for the seam and
      // cannot get the sign of the ramp wrong at a double boundary.
      this.halfWidth[i] = here * 0.5 + prev * 0.25 + next * 0.25;
    }
    // Second pass smooths the residual corner off the tent function above.
    const tmp = Float32Array.from(this.halfWidth);
    const h = Math.max(1, Math.round(blendSamples * 0.5));
    for (let i = 0; i < LUT; i++) {
      let sum = 0;
      for (let j = -h; j <= h; j++) sum += tmp[(i + j + LUT) % LUT];
      this.halfWidth[i] = sum / (h * 2 + 1);
    }
  }

  /**
   * Place the checkpoint gates.
   *
   * Two stages, because a gate straddling a corner apex is both ugly (two
   * pylons skewed across the corridor) and unfair (its plane test gets
   * sensitive to the line taken):
   *
   *   1. A *global* phase search. Gate 0 is pinned to the start/finish line,
   *      and gates 1..n-1 stay perfectly evenly spaced but slide together by a
   *      shared offset, chosen to minimise the sum of squared curvature under
   *      them. Sliding as a set is what lets a gate escape a 176 m hairpin that
   *      is longer than any per-gate nudge window could reach out of.
   *   2. A per-gate nudge of up to 34 m on top, with a cost per metre moved so that on
   *      a constant-radius arc — where every candidate is equally curved and
   *      the search would otherwise pick arbitrarily — the gate stays put and
   *      the spacing stays even.
   */
  private placeCheckpoints(count: number): Checkpoint[] {
    const out: Checkpoint[] = [];

    // --- stage 1: shared phase ---------------------------------------------
    // Capped at a quarter of the gate spacing: gate 0 is pinned, so a bigger
    // shift would leave a conspicuously short gap on one side of the line and a
    // long one on the other.
    const phaseLimit = 0.25 / count;
    const phaseSteps = 96;
    let bestPhase = 0;
    let bestPhaseCost = Infinity;
    for (let s = -phaseSteps; s <= phaseSteps; s++) {
      const phase = (phaseLimit * s) / phaseSteps;
      let cost = 0;
      for (let i = 1; i < count; i++) {
        const k = this.signedCurvatureAt(i / count + phase);
        // Fourth power, not squared: the objective has to be dominated by the
        // *worst* gate. With a squared cost the three unavoidable gates inside
        // the 750 m sweeper drown out the one gate that could be walked out of
        // the hairpin, and the search settles for leaving it on the apex.
        cost += k * k * k * k;
      }
      if (cost < bestPhaseCost) {
        bestPhaseCost = cost;
        bestPhase = phase;
      }
    }

    // --- stage 2: per-gate nudge -------------------------------------------
    const searchSamples = Math.round(34 / this.ds);
    /** 1/m of curvature traded per metre of displacement from the nominal spot. */
    const moveCost = 6e-5;

    for (let i = 0; i < count; i++) {
      const nominal = i === 0 ? 0 : Course.wrap(i / count + bestPhase);
      let t = nominal;
      if (i > 0) {
        const centre = Math.round(nominal * LUT);
        let best = Infinity;
        let bestIdx = centre;
        for (let j = -searchSamples; j <= searchSamples; j++) {
          const idx = (centre + j + LUT) % LUT;
          const cost = Math.abs(this.kappa[idx]) + Math.abs(j) * this.ds * moveCost;
          if (cost < best) {
            best = cost;
            bestIdx = idx;
          }
        }
        t = bestIdx / LUT;
      }

      const position = new Vector3();
      const tangent = new Vector3();
      this.positionAt(t, position);
      this.tangentAt(t, tangent);
      out.push({
        index: i,
        t,
        position,
        tangent,
        // Gates open wider than the corridor: the corridor is advisory, the
        // gate is a hard validation test, and a gate you can physically miss
        // while driving a legal line would be a bug.
        width: this.widthAt(t) + 7,
        startFinish: i === 0,
      });
    }
    return out;
  }

  /**
   * Staggered 2x2 grid behind the start/finish line.
   *
   * Slots alternate sides and step back 8 m at a time, which is the arcade
   * convention: it guarantees nobody is directly in anybody's spray and it puts
   * pole on the inside of the first kink (`Salt Kink C` unwinds to the left, so
   * the inside line at t=0 is the right-hand side).
   */
  private buildGrid(slots: number): StartSlot[] {
    const out: StartSlot[] = [];
    const pos = new Vector3();
    const tan = new Vector3();
    const nrm = new Vector3();

    for (let i = 0; i < slots; i++) {
      const back = 14 + i * 8;
      const side = i % 2 === 0 ? -1 : 1;
      const t = this.advance(0, -back);
      this.positionAt(t, pos);
      this.tangentAt(t, tan);
      nrm.set(tan.z, 0, -tan.x);
      out.push({
        position: new Vector3(
          pos.x + nrm.x * side * 5.5,
          0,
          pos.z + nrm.z * side * 5.5,
        ),
        heading: Math.atan2(tan.x, tan.z),
      });
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Sampling
  // -------------------------------------------------------------------------

  /** Wrap a parameter into [0, 1). */
  static wrap(t: number): number {
    return t - Math.floor(t);
  }

  /**
   * Shortest signed difference `a - b` on the lap, in [-0.5, 0.5). Used
   * everywhere progress is compared, because the raw difference is wrong for
   * exactly the pairs that matter (either side of the start/finish line).
   */
  static wrapDelta(a: number, b: number): number {
    let d = (a - b) % 1;
    if (d >= 0.5) d -= 1;
    if (d < -0.5) d += 1;
    return d;
  }

  /** Move `metres` along the lap from `t`, wrapping. Negative goes backwards. */
  advance(t: number, metres: number): number {
    return Course.wrap(t + metres / this.length);
  }

  private lerpIndex(t: number): { i: number; j: number; f: number } {
    const x = Course.wrap(t) * LUT;
    const i = Math.floor(x) % LUT;
    return { i, j: (i + 1) % LUT, f: x - Math.floor(x) };
  }

  positionAt(t: number, out: Vector3, time?: number): Vector3 {
    const { i, j, f } = this.lerpIndex(t);
    const x = this.px[i] + (this.px[j] - this.px[i]) * f;
    const z = this.pz[i] + (this.pz[j] - this.pz[i]) * f;
    out.set(x, time === undefined ? 0 : oceanHeight(x, z, time), z);
    return out;
  }

  tangentAt(t: number, out: Vector3): Vector3 {
    const { i, j, f } = this.lerpIndex(t);
    // Interpolating then renormalising is fine: adjacent tangents are within
    // 0.05 deg of each other even in the hairpin.
    const x = this.tx[i] + (this.tx[j] - this.tx[i]) * f;
    const z = this.tz[i] + (this.tz[j] - this.tz[i]) * f;
    const inv = 1 / (Math.hypot(x, z) || 1);
    out.set(x * inv, 0, z * inv);
    return out;
  }

  /** Left-hand normal in XZ: `up x tangent`. */
  normalAt(t: number, out: Vector3): Vector3 {
    this.tangentAt(t, out);
    return out.set(out.z, 0, -out.x);
  }

  /** Signed curvature, 1/m. Positive curves towards the left-hand normal. */
  signedCurvatureAt(t: number): number {
    const { i, j, f } = this.lerpIndex(t);
    return this.kappa[i] + (this.kappa[j] - this.kappa[i]) * f;
  }

  curvatureAt(t: number): number {
    return Math.abs(this.signedCurvatureAt(t));
  }

  /** Half-width of the drivable corridor, metres. */
  widthAt(t: number): number {
    const { i, j, f } = this.lerpIndex(t);
    return this.halfWidth[i] + (this.halfWidth[j] - this.halfWidth[i]) * f;
  }

  sectionAt(t: number): CourseSection {
    const tt = Course.wrap(t);
    for (let i = this.sections.length - 1; i >= 0; i--) {
      if (tt >= this.sections[i].t0) return this.sections[i];
    }
    return this.sections[this.sections.length - 1];
  }

  /** Fill a `CoursePoint`. `time` resolves Y against the waves; omit for Y = 0. */
  sampleInto(t: number, out: CoursePoint, time?: number): CoursePoint {
    this.positionAt(t, out.position, time);
    this.tangentAt(t, out.tangent);
    out.normal.set(out.tangent.z, 0, -out.tangent.x);
    out.curvature = this.curvatureAt(t);
    out.width = this.widthAt(t);
    return out;
  }

  /** Allocating convenience form. Use `sampleInto` in per-frame code. */
  sample(t: number, time?: number): CoursePoint {
    return this.sampleInto(
      t,
      {
        position: new Vector3(),
        tangent: new Vector3(),
        normal: new Vector3(),
        curvature: 0,
        width: 0,
      },
      time,
    );
  }

  // -------------------------------------------------------------------------
  // Projection
  // -------------------------------------------------------------------------

  /**
   * Project a world position onto the spline and return its arc-length
   * parameter.
   *
   * With a hint this is O(1): a fixed 49-sample window of the fine table
   * followed by a segment projection. Without one it is a strided scan of the
   * whole table (256 probes) plus the same refinement, which is only used on
   * spawn, reset and during construction.
   *
   * If the winning sample lands on the edge of the hinted window the hint was
   * stale (a reset, a teleport, a pathological frame spike) and we fall back to
   * the global scan rather than returning a confidently wrong answer.
   */
  closestT(position: Vector3, hintT?: number): number {
    const x = position.x;
    const z = position.z;

    if (hintT !== undefined) {
      const centre = Math.round(Course.wrap(hintT) * LUT);
      let best = Infinity;
      let bestOffset = 0;
      for (let o = -HINT_WINDOW; o <= HINT_WINDOW; o++) {
        const idx = (centre + o + LUT) % LUT;
        const dx = this.px[idx] - x;
        const dz = this.pz[idx] - z;
        const d = dx * dx + dz * dz;
        if (d < best) {
          best = d;
          bestOffset = o;
        }
      }
      if (Math.abs(bestOffset) < HINT_WINDOW) {
        return this.refine((centre + bestOffset + LUT) % LUT, x, z);
      }
    }

    let best = Infinity;
    let bestIdx = 0;
    for (let idx = 0; idx < LUT; idx += COARSE_STRIDE) {
      const dx = this.px[idx] - x;
      const dz = this.pz[idx] - z;
      const d = dx * dx + dz * dz;
      if (d < best) {
        best = d;
        bestIdx = idx;
      }
    }
    // The strided scan can be off by up to half a stride, so sweep the stride
    // around the winner at full resolution before refining.
    let fineBest = Infinity;
    let fineIdx = bestIdx;
    for (let o = -COARSE_STRIDE; o <= COARSE_STRIDE; o++) {
      const idx = (bestIdx + o + LUT) % LUT;
      const dx = this.px[idx] - x;
      const dz = this.pz[idx] - z;
      const d = dx * dx + dz * dz;
      if (d < fineBest) {
        fineBest = d;
        fineIdx = idx;
      }
    }
    return this.refine(fineIdx, x, z);
  }

  /** Sub-sample refinement: project onto the two segments adjacent to `i`. */
  private refine(i: number, x: number, z: number): number {
    const prev = (i - 1 + LUT) % LUT;
    const next = (i + 1) % LUT;

    const a = this.projectSegment(prev, i, x, z);
    const b = this.projectSegment(i, next, x, z);

    return a.d2 <= b.d2 ? Course.wrap((prev + a.f) / LUT) : Course.wrap((i + b.f) / LUT);
  }

  private projectSegment(
    i0: number,
    i1: number,
    x: number,
    z: number,
  ): { f: number; d2: number } {
    const ax = this.px[i0];
    const az = this.pz[i0];
    const bx = this.px[i1] - ax;
    const bz = this.pz[i1] - az;
    const denom = bx * bx + bz * bz;
    let f = denom > 1e-9 ? ((x - ax) * bx + (z - az) * bz) / denom : 0;
    f = f < 0 ? 0 : f > 1 ? 1 : f;
    const dx = ax + bx * f - x;
    const dz = az + bz * f - z;
    return { f, d2: dx * dx + dz * dz };
  }

  /** Non-allocating form of `progressAt`. */
  progressInto(position: Vector3, out: CourseProgress, hintT?: number): CourseProgress {
    const t = this.closestT(position, hintT);
    this.positionAt(t, _v0);
    this.normalAt(t, _v1);
    out.t = t;
    out.distanceAlong = t * this.length;
    out.lateralOffset = (position.x - _v0.x) * _v1.x + (position.z - _v0.z) * _v1.z;
    return out;
  }

  progressAt(position: Vector3, hintT?: number): CourseProgress {
    return this.progressInto(position, { t: 0, distanceAlong: 0, lateralOffset: 0 }, hintT);
  }

  // -------------------------------------------------------------------------
  // Queries the AI and the corner-preview shader need
  // -------------------------------------------------------------------------

  /**
   * Worst curvature between `t` and `t + metres` ahead, signed by whichever
   * sample had the largest magnitude. This is the AI's braking input: it must
   * be the *peak* of the corner rather than the average, or the AI arrives at
   * the apex 15% too fast every single time.
   */
  peakCurvatureAhead(t: number, metres: number): number {
    const steps = Math.max(2, Math.round(metres / (this.ds * 4)));
    let peak = 0;
    for (let i = 0; i <= steps; i++) {
      const k = this.signedCurvatureAt(t + (metres * i) / steps / this.length);
      if (Math.abs(k) > Math.abs(peak)) peak = k;
    }
    return peak;
  }

  /**
   * Signed curvature sampled at `count` points spaced `spacing` metres ahead of
   * `t`. Feeds the racing line's corner-preview colour band; the array is
   * written in place so nothing allocates per frame.
   */
  curvatureProfile(
    t: number,
    count: number,
    spacing: number,
    out: Float32Array,
  ): Float32Array {
    for (let i = 0; i < count && i < out.length; i++) {
      out[i] = this.signedCurvatureAt(t + (i * spacing) / this.length);
    }
    return out;
  }

  /** Diagnostics for the layout, used by the numeric sanity harness. */
  describe(): string {
    const lines: string[] = [];
    lines.push(`Windward Reef — ${this.length.toFixed(1)} m lap`);
    for (const s of this.sections) {
      const r = Number.isFinite(s.radius) ? `R${s.radius.toFixed(0)}` : 'straight';
      lines.push(
        `  ${s.name.padEnd(18)} ${r.padEnd(9)} ${s.length.toFixed(0).padStart(4)} m` +
          `  t ${s.t0.toFixed(4)}..${s.t1.toFixed(4)}  hw ${s.halfWidth}`,
      );
    }
    return lines.join('\n');
  }
}
