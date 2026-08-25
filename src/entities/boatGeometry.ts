import { BufferAttribute, BufferGeometry, MathUtils, Vector3 } from 'three';
import {
  ENGINE_POINT,
  HANDLEBAR_POINT,
  HULL_BEAM,
  HULL_CENTRE_BEAM,
  HULL_DRAFT,
  HULL_FREEBOARD,
  HULL_LENGTH,
  RIDER_MOUNT,
  RUDDER_POINT,
} from './hullSpec.ts';

/**
 * BOAT GEOMETRY — a racing hydroplane, lofted by hand from station profiles.
 *
 * Every dimension here is derived from `hullSpec.ts` rather than restated,
 * because the physics samples buoyancy at six fixed points on the hull bottom
 * and will happily push against empty air if the art drifts by ten centimetres.
 * The keel table below therefore bottoms out at exactly -HULL_DRAFT, the sheer
 * tops out at HULL_CENTRE_BEAM/2, and the sponsons reach exactly HULL_BEAM/2.
 *
 * THE CHINE IS THE POINT OF THIS FILE.
 *
 * A cel ramp quantises N·L into a handful of bands, so a smoothly rounded hull
 * gets a wide, low-contrast, crawling band boundary somewhere around its
 * turn-of-bilge — the exact opposite of drawn shading. The fix is a hard chine:
 * a single sharp longitudinal crease where the near-vertical topsides meet the
 * near-flat planing bottom. Two surfaces meeting at ~70 degrees pin the
 * terminator to a *line* the length of the boat, and that line is what makes
 * the hull read as ink-and-paint rather than as a lit 3D object.
 *
 * Which means the whole file is organised around NOT sharing vertices:
 *
 *   - the bottom and the topsides are separate surface bands. They occupy the
 *     same chine curve but do not share a single index, so
 *     `computeVertexNormals` physically cannot average across the crease.
 *   - port and starboard bottoms are likewise separate, giving a hard keel line
 *     that only shows when the hull is airborne, which is when it matters most.
 *   - the racing stripe is its own band, so its edges are geometric rather than
 *     an interpolated vertex-colour gradient.
 *   - everything that is not the main loft (cowl, sponsons, engine, fin, bars)
 *     is emitted faceted: one set of vertices per quad. Chunky and angular is
 *     the art direction, and it is also the cheapest way to guarantee that no
 *     edge accidentally goes smooth.
 *
 * Coordinates are hull-local metres, +X starboard, +Y up, +Z forward, origin at
 * the design waterline mid-hull — the same frame as `hullSpec.ts`. Geometry is
 * authored *in that frame*, so a part's mesh needs no local transform. The two
 * exceptions are called out on their builders: the rudder is authored about its
 * own pivot because it rotates, and the engine glow about its own centre
 * because it scales.
 */

// ---------------------------------------------------------------------------
// Livery tones
// ---------------------------------------------------------------------------

/**
 * Vertex colours MULTIPLY the material's base colour in `CelMaterial`, so 1.0
 * is the racer's paint at full strength and anything below it is a darker
 * shade of the same hue. That is the whole livery system: four boats, two
 * materials each, no textures.
 *
 * The darker tones are biased cool (blue above red) rather than being flat grey
 * multipliers. Scaling a saturated paint straight down desaturates it into mud;
 * pulling the red channel down hardest instead pushes the shadow towards the
 * ocean's indigo, which is where the rest of the palette already lives.
 */
type Tint = readonly [number, number, number];

/** Full-strength paint. */
const PAINT: Tint = [1, 1, 1];
/** Lighter flash, used on edges that should catch the eye. */
const FLASH: Tint = [1.22, 1.22, 1.26];
/** Mid panel — gunwale caps, coaming, rims. */
const PANEL: Tint = [0.6, 0.62, 0.7];
/** The racing stripe, and the sponson panel that answers it. */
const STRIPE: Tint = [0.25, 0.26, 0.34];
/** Wetted bottom paint. */
const WET: Tint = [0.5, 0.53, 0.62];
/** Keel line, a touch darker than the rest of the bottom. */
const KEEL: Tint = [0.33, 0.35, 0.44];
/** Interiors: the cockpit well, intake throats, the nozzle. Reads as shadow. */
const CAVITY: Tint = [0.18, 0.19, 0.25];

function mixTint(a: Tint, b: Tint, t: number): Tint {
  return [
    MathUtils.lerp(a[0], b[0], t),
    MathUtils.lerp(a[1], b[1], t),
    MathUtils.lerp(a[2], b[2], t),
  ];
}

// ---------------------------------------------------------------------------
// Surface builder
// ---------------------------------------------------------------------------

export interface SurfacePoint {
  x: number;
  y: number;
  z: number;
  t: Tint;
}

const _pa = new Vector3();
const _pb = new Vector3();
const _pc = new Vector3();
const _e1 = new Vector3();
const _e2 = new Vector3();
const _fn = new Vector3();
const _out = new Vector3();
const _ref = new Vector3();
const _dir = new Vector3();

/**
 * A tiny position/colour/index accumulator.
 *
 * The one non-obvious service it provides is `orientFaces`. Getting triangle
 * winding right by inspection across a dozen hand-lofted parts is a coin flip
 * per part, and a backfacing hull is invisible until someone runs the game —
 * which this file cannot do. So winding is never asserted, it is *measured*:
 * every face is compared against a known outward direction and flipped if it
 * disagrees. That turns a whole class of silent art bugs into arithmetic.
 */
class SurfaceBuilder {
  private readonly pos: number[] = [];
  private readonly col: number[] = [];
  private readonly idx: number[] = [];

  get faceCount(): number {
    return this.idx.length / 3;
  }

  vertex(x: number, y: number, z: number, t: Tint): number {
    this.pos.push(x, y, z);
    this.col.push(t[0], t[1], t[2]);
    return this.pos.length / 3 - 1;
  }

  point(p: SurfacePoint): number {
    return this.vertex(p.x, p.y, p.z, p.t);
  }

  /** Emits a triangle, silently dropping slivers so collapsed loft rows cost nothing. */
  tri(a: number, b: number, c: number): void {
    const ia = a * 3;
    const ib = b * 3;
    const ic = c * 3;
    _pa.set(this.pos[ia], this.pos[ia + 1], this.pos[ia + 2]);
    _pb.set(this.pos[ib], this.pos[ib + 1], this.pos[ib + 2]);
    _pc.set(this.pos[ic], this.pos[ic + 1], this.pos[ic + 2]);
    _e1.subVectors(_pb, _pa);
    _e2.subVectors(_pc, _pa);
    if (_e1.cross(_e2).lengthSq() < 1e-12) return;
    this.idx.push(a, b, c);
  }

  quad(a: number, b: number, c: number, d: number): void {
    this.tri(a, b, c);
    this.tri(a, c, d);
  }

  /**
   * Flip every face from `fromFace` onwards that points the wrong way.
   *
   * `radial` compares the face normal against (centroid - ref), which is the
   * outward direction for anything lofted around an axis. Caps and flat plates
   * pass `radial = false` and a literal direction instead, because their
   * outward direction is *along* the axis where the radial test degenerates.
   * `sign` is -1 for surfaces we look at from the inside: intake throats and
   * the cockpit well.
   */
  orientFaces(fromFace: number, ref: Vector3, radial: boolean, sign = 1): void {
    for (let f = fromFace; f < this.faceCount; f++) {
      const o = f * 3;
      const ia = this.idx[o] * 3;
      const ib = this.idx[o + 1] * 3;
      const ic = this.idx[o + 2] * 3;
      _pa.set(this.pos[ia], this.pos[ia + 1], this.pos[ia + 2]);
      _pb.set(this.pos[ib], this.pos[ib + 1], this.pos[ib + 2]);
      _pc.set(this.pos[ic], this.pos[ic + 1], this.pos[ic + 2]);
      _e1.subVectors(_pb, _pa);
      _e2.subVectors(_pc, _pa);
      _fn.crossVectors(_e1, _e2);
      if (radial) {
        _out.copy(_pa).add(_pb).add(_pc).multiplyScalar(1 / 3).sub(ref);
      } else {
        _out.copy(ref);
      }
      if (_fn.dot(_out) * sign < 0) {
        const swap = this.idx[o + 1];
        this.idx[o + 1] = this.idx[o + 2];
        this.idx[o + 2] = swap;
      }
    }
  }

  finish(name: string): BufferGeometry {
    const g = new BufferGeometry();
    g.name = name;
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.pos), 3));
    // Every geometry carries a colour attribute whether or not it uses one.
    // `CelMaterial` with `vertexColors: true` declares `in vec3 color`, and a
    // mesh that fails to supply it renders pure black rather than untinted.
    g.setAttribute('color', new BufferAttribute(new Float32Array(this.col), 3));
    g.setIndex(this.idx);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

interface StitchOptions {
  /** Axis point for the radial outward test, per span. */
  ref?: (span: number) => Vector3;
  /** Literal outward direction, for flat sheets where the radial test is useless. */
  dir?: Vector3;
  sign?: number;
}

/**
 * Stitch a (row x column) grid of points into quads.
 *
 * Rows are stations running along the hull, columns run across the surface.
 * The grid owns its vertices outright — two calls never share one — which is
 * precisely how the chine, the keel, the stripe edges and the deck join stay
 * hard through `computeVertexNormals`.
 */
function stitchGrid(
  b: SurfaceBuilder,
  grid: readonly (readonly SurfacePoint[])[],
  opts: StitchOptions = {},
): void {
  const ids = grid.map((row) => row.map((p) => b.point(p)));
  const sign = opts.sign ?? 1;
  for (let i = 0; i + 1 < ids.length; i++) {
    const from = b.faceCount;
    const a = ids[i];
    const c = ids[i + 1];
    const cols = Math.min(a.length, c.length);
    for (let j = 0; j + 1 < cols; j++) {
      b.quad(a[j], a[j + 1], c[j + 1], c[j]);
    }
    if (opts.dir) b.orientFaces(from, opts.dir, false, sign);
    else if (opts.ref) b.orientFaces(from, opts.ref(i), true, sign);
  }
}

// ---------------------------------------------------------------------------
// Tube lofting, for everything that is not the hull
// ---------------------------------------------------------------------------

type Axis = 'x' | 'y' | 'z';

function ringCentroid(ring: readonly SurfacePoint[], out: Vector3): Vector3 {
  out.set(0, 0, 0);
  for (const p of ring) out.add(_pa.set(p.x, p.y, p.z));
  return out.multiplyScalar(1 / ring.length);
}

/**
 * A regular polygon ring around an axis.
 *
 * `phase` exists so a polygon can be rolled to put a *flat* where something has
 * to sit — an octagonal engine barrel with a vertex on top has nowhere to mount
 * a fin, and a vertex-up barrel also catches the specular as a thin sliver
 * instead of a readable shape.
 */
function tubeRing(
  cx: number,
  cy: number,
  cz: number,
  axis: Axis,
  r: number,
  segs: number,
  tint: Tint,
  phase = 0,
): SurfacePoint[] {
  const ring: SurfacePoint[] = [];
  for (let i = 0; i < segs; i++) {
    const a = phase + (i / segs) * Math.PI * 2;
    const u = Math.cos(a) * r;
    const v = Math.sin(a) * r;
    if (axis === 'z') ring.push({ x: cx + u, y: cy + v, z: cz, t: tint });
    else if (axis === 'y') ring.push({ x: cx + u, y: cy, z: cz + v, t: tint });
    else ring.push({ x: cx, y: cy + u, z: cz + v, t: tint });
  }
  return ring;
}

const _ringA = new Vector3();
const _ringB = new Vector3();

/** Loft a sequence of closed rings, one flat-shaded facet per quad. */
function loftRings(b: SurfaceBuilder, rings: readonly (readonly SurfacePoint[])[]): void {
  for (let i = 0; i + 1 < rings.length; i++) {
    const a = rings[i];
    const c = rings[i + 1];
    const n = Math.min(a.length, c.length);
    ringCentroid(a, _ringA);
    ringCentroid(c, _ringB);
    _ref.addVectors(_ringA, _ringB).multiplyScalar(0.5);
    const from = b.faceCount;
    for (let j = 0; j < n; j++) {
      const k = (j + 1) % n;
      // Fresh vertices per facet: this is what keeps every edge of the cowl,
      // the sponsons and the engine hard without any extra bookkeeping.
      const p0 = b.point(a[j]);
      const p1 = b.point(a[k]);
      const p2 = b.point(c[k]);
      const p3 = b.point(c[j]);
      b.quad(p0, p1, p2, p3);
    }
    b.orientFaces(from, _ref, true, 1);
  }
}

const _fanC = new Vector3();

/** Close a ring with a triangle fan facing `dir`. */
function fanCap(
  b: SurfaceBuilder,
  ring: readonly SurfacePoint[],
  dir: Vector3,
  tint?: Tint,
): void {
  ringCentroid(ring, _fanC);
  const t = tint ?? ring[0].t;
  const hub = b.vertex(_fanC.x, _fanC.y, _fanC.z, t);
  const ids = ring.map((p) => b.vertex(p.x, p.y, p.z, tint ?? p.t));
  const from = b.faceCount;
  for (let i = 0; i < ids.length; i++) b.tri(hub, ids[i], ids[(i + 1) % ids.length]);
  b.orientFaces(from, dir, false, 1);
}

const _mouthC = new Vector3();

/**
 * Turn a ring into a recessed mouth: a throat wall stepping inwards and back,
 * then a floor.
 *
 * This is how the air scoops read as intakes rather than as painted-on dark
 * patches. A flat dark polygon on the front of a cowl looks like a decal from
 * every angle; 12 cm of actual recess catches its own shadow, so the shape
 * survives a moving camera and a moving key light.
 */
function insetMouth(
  b: SurfaceBuilder,
  ring: readonly SurfacePoint[],
  push: Vector3,
  shrink: number,
  tint: Tint,
): void {
  ringCentroid(ring, _mouthC);
  const inner: SurfacePoint[] = ring.map((p) => ({
    x: _mouthC.x + (p.x - _mouthC.x) * shrink + push.x,
    y: _mouthC.y + (p.y - _mouthC.y) * shrink + push.y,
    z: _mouthC.z + (p.z - _mouthC.z) * shrink + push.z,
    t: tint,
  }));

  // Throat wall, seen from inside the tunnel, hence sign -1.
  const from = b.faceCount;
  const n = ring.length;
  for (let j = 0; j < n; j++) {
    const k = (j + 1) % n;
    b.quad(b.point(ring[j]), b.point(ring[k]), b.point(inner[k]), b.point(inner[j]));
  }
  _ref.copy(_mouthC).add(push);
  b.orientFaces(from, _ref, true, -1);

  _dir.copy(push).multiplyScalar(-1).normalize();
  fanCap(b, inner, _dir, tint);
}

type Profile2 = readonly (readonly [number, number])[];

/**
 * Extrude a (z, y) outline sideways into a flat plate.
 *
 * Fins and rudders are the one place where a genuinely thin form is right, and
 * a plate built this way has three hard edges around its whole silhouette,
 * which is what the ink pass wants.
 */
function extrudePlate(
  b: SurfaceBuilder,
  profile: Profile2,
  halfThickness: number,
  face: Tint,
  rim: Tint,
): void {
  let cz = 0;
  let cy = 0;
  for (const p of profile) {
    cz += p[0];
    cy += p[1];
  }
  cz /= profile.length;
  cy /= profile.length;
  const n = profile.length;

  for (const side of [1, -1]) {
    const x = side * halfThickness;
    const hub = b.vertex(x, cy, cz, face);
    const ids = profile.map((p) => b.vertex(x, p[1], p[0], face));
    const from = b.faceCount;
    for (let i = 0; i < n; i++) b.tri(hub, ids[i], ids[(i + 1) % n]);
    b.orientFaces(from, _dir.set(side, 0, 0), false, 1);
  }

  const outer = profile.map((p) => b.vertex(halfThickness, p[1], p[0], rim));
  const inner = profile.map((p) => b.vertex(-halfThickness, p[1], p[0], rim));
  const from = b.faceCount;
  for (let i = 0; i < n; i++) {
    const k = (i + 1) % n;
    b.quad(outer[i], outer[k], inner[k], inner[i]);
  }
  b.orientFaces(from, _ref.set(0, cy, cz), true, 1);
}

// ---------------------------------------------------------------------------
// Longitudinal interpolation
// ---------------------------------------------------------------------------

/**
 * Monotone cubic (Fritsch-Carlson) interpolation of one station channel.
 *
 * A plain Catmull-Rom through unevenly spaced control stations overshoots, and
 * an overshoot here is not cosmetic: the keel table bottoms out at exactly
 * -HULL_DRAFT, so a spline that dips 3 cm below its control values between two
 * stations makes the deepest part of the hull deeper than the number the
 * buoyancy solver was tuned against. Limiting the tangents guarantees the
 * interpolant stays inside the control values it passes through, which means
 * the extremes in the table below are the extremes of the finished hull.
 */
class Channel {
  private readonly m: number[];

  constructor(
    private readonly xs: readonly number[],
    private readonly ys: readonly number[],
  ) {
    const n = xs.length;
    const d: number[] = [];
    for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));

    const m: number[] = [d[0]];
    for (let i = 1; i < n - 1; i++) m.push((d[i - 1] + d[i]) * 0.5);
    m.push(d[n - 2]);

    for (let i = 0; i < n - 1; i++) {
      if (d[i] === 0) {
        m[i] = 0;
        m[i + 1] = 0;
        continue;
      }
      const a = m[i] / d[i];
      const bb = m[i + 1] / d[i];
      const s = Math.hypot(a, bb);
      if (s > 3) {
        m[i] = (3 / s) * a * d[i];
        m[i + 1] = (3 / s) * bb * d[i];
      }
    }
    this.m = m;
  }

  at(x: number): number {
    const xs = this.xs;
    let i = 0;
    while (i < xs.length - 2 && x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i];
    const s = MathUtils.clamp((x - xs[i]) / h, 0, 1);
    const s2 = s * s;
    const s3 = s2 * s;
    return (
      (2 * s3 - 3 * s2 + 1) * this.ys[i] +
      (s3 - 2 * s2 + s) * h * this.m[i] +
      (-2 * s3 + 3 * s2) * this.ys[i + 1] +
      (s3 - s2) * h * this.m[i + 1]
    );
  }
}

function smooth01(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------------------
// The station table
// ---------------------------------------------------------------------------

const HALF_LENGTH = HULL_LENGTH / 2;
const CENTRE_HALF = HULL_CENTRE_BEAM / 2;
const SPONSON_HALF = HULL_BEAM / 2;

/**
 * One transverse section of the centre hull: a half-profile from the keel up to
 * the sheer, described by the only three points that matter.
 *
 *   keel   (0, keelY)                the bottom of the vee
 *   chine  (chineHalf, chineY)       THE crease
 *   sheer  (sheerHalf, sheerY)       where the hull stops and the deck starts
 *
 * Everything between them is generated, so the table stays short enough to read
 * as a shape rather than as data.
 */
export interface HullStation {
  z: number;
  keelY: number;
  chineHalf: number;
  chineY: number;
  sheerHalf: number;
  sheerY: number;
}

/**
 * Control stations, transom first (naval-architecture order) so the numbers
 * read as a run of sections rather than a spline.
 *
 * The shape being described, aft to forward:
 *
 *   -2.70 .. -1.30  Almost no deadrise (2-5 cm of it). This is the planing
 *                   surface; the flatter it is the more the boat skips rather
 *                   than knifes, which is the whole arcade feel. It is also
 *                   where the two aft probes sit, at -0.44.
 *   -0.60 ..  0.30  Maximum beam and maximum draft. The keel sits at exactly
 *                   -HULL_DRAFT across this run, so the monotone limiter pins
 *                   it flat and nothing between stations goes deeper.
 *    1.05 ..  1.70  Deadrise opens up towards the bow so the forefoot can
 *                   part water instead of slapping it.
 *    2.10           The bow probe's station. Keel at exactly -0.30 to match.
 *    2.40 ..  2.70  The keel climbs 0.72 m in the last 0.60 m of length. That
 *                   steep run *is* the raked stem: the bottom band turns
 *                   through vertical and becomes the front of the boat, which
 *                   is far more aggressive in silhouette than a stem drawn as
 *                   a separate surface, and costs nothing extra.
 */
const CTRL_Z = [-2.7, -2.15, -1.3, -0.6, 0.3, 1.05, 1.7, 2.1, 2.4, HALF_LENGTH];

const CH_KEEL_Y = new Channel(CTRL_Z, [
  -0.36, -0.4, -0.45, -HULL_DRAFT, -HULL_DRAFT, -0.43, -0.39, -0.3, 0.02, 0.42,
]);
const CH_CHINE_HALF = new Channel(CTRL_Z, [
  0.56, 0.6, 0.64, 0.65, 0.63, 0.56, 0.4, 0.26, 0.16, 0.055,
]);
const CH_CHINE_Y = new Channel(CTRL_Z, [
  -0.34, -0.37, -0.4, -0.4, -0.39, -0.34, -0.24, -0.06, 0.2, 0.5,
]);
const CH_SHEER_HALF = new Channel(CTRL_Z, [
  0.58, 0.62, 0.65, CENTRE_HALF, CENTRE_HALF, 0.62, 0.52, 0.4, 0.26, 0.085,
]);
const CH_SHEER_Y = new Channel(CTRL_Z, [
  0.6, 0.58, 0.56, 0.55, 0.54, 0.54, 0.55, 0.56, 0.58, 0.6,
]);

/** The interpolated half-section at any longitudinal position. */
export function sampleHullStation(z: number): HullStation {
  return {
    z,
    keelY: CH_KEEL_Y.at(z),
    chineHalf: CH_CHINE_HALF.at(z),
    chineY: CH_CHINE_Y.at(z),
    sheerHalf: CH_SHEER_HALF.at(z),
    sheerY: CH_SHEER_Y.at(z),
  };
}

/**
 * Where the loft is actually evaluated. Spacing is deliberately uneven: tight
 * through the bow (where the sections change fastest and the silhouette is
 * read), tight through the cockpit (because the coaming rim is generated from
 * these same stations and a coarse rim looks polygonal from the driver's seat),
 * loose in the middle where nothing is happening.
 *
 * The four probe stations -2.15, -1.30, 1.05 and 2.10 are members of this list
 * on purpose, so there is a real vertex row exactly where buoyancy samples.
 */
const HULL_STATION_Z: readonly number[] = [
  -HALF_LENGTH, -2.42, -2.15, -1.86, -1.58, -1.3, -1.1, -0.9, -0.7, -0.5, -0.3, -0.1, 0.1, 0.3,
  0.5, 0.72, 1.05, 1.38, 1.7, 1.95, 2.1, 2.3, 2.5, HALF_LENGTH,
];

const STATIONS: readonly HullStation[] = HULL_STATION_Z.map(sampleHullStation);

// --- cross-section parameterisation ---------------------------------------

/** Bottom band columns, keel (0) to chine (1). */
const BOTTOM_U = [0, 0.4, 0.74, 1];

/**
 * Bottom surface at fractional distance `u` from keel to chine.
 *
 * The height blend is very slightly convex rather than linear, which gives the
 * bottom panel a hint of a rolled surface between keel and chine. Fully linear
 * reads as a folded sheet of paper; fully round loses the chine.
 */
function bottomPoint(st: HullStation, u: number, side: number, t: Tint): SurfacePoint {
  return {
    x: side * st.chineHalf * u,
    y: st.keelY + (st.chineY - st.keelY) * (0.8 * u + 0.2 * u * u),
    z: st.z,
    t,
  };
}

/**
 * Topside surface at fractional height `v` from chine (0) to sheer (1).
 *
 * The width uses a smoothstep so dx/dv is zero at v = 0: the topsides leave the
 * chine dead vertical. That maximises the angle between the two bands, and the
 * angle at the crease is exactly what the cel ramp turns into a hard line.
 */
function topsidePoint(st: HullStation, v: number, side: number, t: Tint): SurfacePoint {
  return {
    x: side * MathUtils.lerp(st.chineHalf, st.sheerHalf, smooth01(v)),
    y: MathUtils.lerp(st.chineY, st.sheerY, v),
    z: st.z,
    t,
  };
}

/**
 * The racing stripe's lower and upper edge, as fractions of topside height.
 *
 * The stripe sweeps: it sits low and wide at the bow and rises towards the
 * transom. A stripe at constant height parallel to the chine is invisible,
 * because it just reads as another band of the shading. One that climbs across
 * the length crosses the chine's convergence at the bow and gives the hull an
 * apparent rake it does not geometrically have.
 */
function stripeEdges(z: number): [number, number] {
  const t = MathUtils.clamp((HALF_LENGTH - z) / HULL_LENGTH, 0, 1);
  const centre = 0.42 + 0.24 * t;
  const half = 0.13 + 0.05 * t;
  return [centre - half, centre + half];
}

// ---------------------------------------------------------------------------
// Hull
// ---------------------------------------------------------------------------

/** Outline of one station, in the order the surface bands lay it down. */
function stationOutline(st: HullStation): SurfacePoint[] {
  const [s0, s1] = stripeEdges(st.z);
  const vs = [s0 * 0.5, s0, s1, s1 + (1 - s1) * 0.5, 1];
  const out: SurfacePoint[] = [];
  // Port side, sheer down to the keel...
  for (let i = vs.length - 1; i >= 0; i--) out.push(topsidePoint(st, vs[i], -1, PANEL));
  for (let i = BOTTOM_U.length - 1; i >= 1; i--) out.push(bottomPoint(st, BOTTOM_U[i], -1, PANEL));
  // ...through the keel, and back up the starboard side.
  out.push(bottomPoint(st, 0, 1, KEEL));
  for (let i = 1; i < BOTTOM_U.length; i++) out.push(bottomPoint(st, BOTTOM_U[i], 1, PANEL));
  for (const v of vs) out.push(topsidePoint(st, v, 1, PANEL));
  return out;
}

/**
 * The lofted centre hull: planing bottom, hard chine, near-vertical topsides,
 * raked stem, and a swept racing stripe cut into the topsides as its own band.
 *
 * Bands, none of which share a vertex with any other:
 *   bottom     port and starboard, keel to chine
 *   topside A  chine to the stripe's lower edge
 *   topside B  the stripe
 *   topside C  the stripe's upper edge to the sheer
 *   caps       transom and stem, flat faces closing the loft
 */
export function buildHullGeometry(): BufferGeometry {
  const b = new SurfaceBuilder();

  for (const side of [-1, 1]) {
    stitchGrid(
      b,
      STATIONS.map((st) =>
        BOTTOM_U.map((u) => bottomPoint(st, u, side, mixTint(KEEL, WET, u))),
      ),
      // Reference above the bottom panel so "outward" resolves to downward.
      { ref: (i) => _ref.set(0, STATIONS[i].keelY + 0.4, STATIONS[i].z) },
    );

    const topRef = (i: number): Vector3 => {
      const st = STATIONS[i];
      return _ref.set(0, (st.chineY + st.sheerY) * 0.5, st.z);
    };

    // Band A: chine up to the stripe. Two spans, so the near-vertical part of
    // the topside still gets a little longitudinal shape.
    stitchGrid(
      b,
      STATIONS.map((st) => {
        const [s0] = stripeEdges(st.z);
        return [0, s0 * 0.5, s0].map((v) => topsidePoint(st, v, side, PAINT));
      }),
      { ref: topRef },
    );

    // Band B: the stripe itself. Two rows, one span, and because its vertices
    // are its own, both of its edges are geometrically crisp rather than an
    // interpolated colour ramp.
    stitchGrid(
      b,
      STATIONS.map((st) => {
        const [s0, s1] = stripeEdges(st.z);
        return [s0, s1].map((v) => topsidePoint(st, v, side, STRIPE));
      }),
      { ref: topRef },
    );

    // Band C: stripe to sheer. Darkens into the sheer so the gunwale highlight
    // added by the deck has something to sit against.
    stitchGrid(
      b,
      STATIONS.map((st) => {
        const [, s1] = stripeEdges(st.z);
        const vs = [s1, s1 + (1 - s1) * 0.5, 1];
        return vs.map((v, k) => topsidePoint(st, v, side, k === 2 ? PANEL : PAINT));
      }),
      { ref: topRef },
    );
  }

  // Stem and transom. Both are flat faces on their own vertices, which is what
  // makes the transom edge the hard corner an arcade boat needs — a rounded
  // stern loses the whole rear silhouette against the water.
  fanCap(b, stationOutline(STATIONS[0]), _dir.set(0, 0, -1), PANEL);
  fanCap(b, stationOutline(STATIONS[STATIONS.length - 1]), _dir.set(0, 0, 1), PANEL);

  return b.finish('hull');
}

// ---------------------------------------------------------------------------
// Deck
// ---------------------------------------------------------------------------

const COAMING_Y = HULL_FREEBOARD;
/** Two centimetres under RIDER_MOUNT, so boots rest on the floor, not in it. */
const COCKPIT_FLOOR_Y = RIDER_MOUNT.y - 0.02;
const COCKPIT_HALF = 0.47;

/**
 * How open the cockpit is at this station, 0..1.
 *
 * The well is a lens rather than a rounded rectangle: the opening's half-width
 * is this mask times COCKPIT_HALF, so the coaming rim, the well walls and the
 * floor are all generated from the same station list as the deck and cannot
 * crack apart. The aft ramp is longer than the forward one because the rider
 * sits at RIDER_MOUNT.z = -0.28 and needs the room behind them.
 */
function cockpitOpening(z: number): number {
  return Math.min(smooth01((z + 1.22) / 0.34), smooth01((0.52 - z) / 0.3));
}

/** Top of the rolled gunwale, just inboard and above the sheer. */
function gunwaleTop(st: HullStation): { x: number; y: number } {
  return { x: st.sheerHalf - 0.05, y: st.sheerY + 0.055 };
}

/** Deck columns from the gunwale top inboard to the coaming rim. */
const DECK_U = [0, 0.45, 0.8, 0.91, 1];

/**
 * The deck: a rolled gunwale, a flat field, a raised coaming lip, and the well.
 *
 * Deliberately a separate geometry from the hull even though its outboard edge
 * is the hull's sheer line evaluated from the same table. Sharing the edge
 * would smooth the deck into the topsides and lose the second most important
 * crease on the boat.
 *
 * Fore and aft of the cockpit the rim collapses to the centreline, so the same
 * grid that makes the coaming makes a spine ridge down the fore and after
 * decks. One topology, two features.
 */
export function buildDeckGeometry(): BufferGeometry {
  const b = new SurfaceBuilder();

  for (const side of [-1, 1]) {
    // Rolled gunwale: a 5 cm band from the sheer up to the deck edge, tinted
    // light so it reads as a lit edge running the full length. This is the
    // cheapest way to make a hull look like it has a rubbing strake.
    stitchGrid(
      b,
      STATIONS.map((st) => {
        const g = gunwaleTop(st);
        return [
          { x: side * st.sheerHalf, y: st.sheerY, z: st.z, t: PANEL },
          { x: side * g.x, y: g.y, z: st.z, t: FLASH },
        ];
      }),
      { ref: (i) => _ref.set(0, STATIONS[i].sheerY - 0.3, STATIONS[i].z) },
    );

    stitchGrid(
      b,
      STATIONS.map((st) => {
        const g = gunwaleTop(st);
        const lip = cockpitOpening(st.z);
        const rimHalf = COCKPIT_HALF * lip;
        // Outside the cockpit the "rim" is a low spine ridge; inside it climbs
        // to HULL_FREEBOARD, which is where that number is defined to be.
        const rimY = MathUtils.lerp(g.y + 0.045, COAMING_Y, lip);
        return DECK_U.map((u) => ({
          x: side * MathUtils.lerp(g.x, rimHalf, u),
          // The rise is squeezed into the last 20% of the width so the coaming
          // is a lip you could grip, not a domed deck.
          y: MathUtils.lerp(g.y, rimY, smooth01((u - 0.8) / 0.2)),
          z: st.z,
          t: u >= 0.91 ? PANEL : PAINT,
        }));
      }),
      { ref: (i) => _ref.set(0, STATIONS[i].sheerY - 0.3, STATIONS[i].z) },
    );
  }

  // --- the well ------------------------------------------------------------
  // Only the stations that actually open. The first and last of them have a
  // rim half-width of zero, which seals the ends for free.
  const wellStations = STATIONS.filter((st) => st.z > -1.32 && st.z < 0.74);

  for (const side of [-1, 1]) {
    const rim = (st: HullStation) => {
      const lip = cockpitOpening(st.z);
      const g = gunwaleTop(st);
      return {
        half: COCKPIT_HALF * lip,
        y: MathUtils.lerp(g.y + 0.045, COAMING_Y, lip),
      };
    };

    stitchGrid(
      b,
      wellStations.map((st) => {
        const r = rim(st);
        return [0, 0.55, 1].map((v) => ({
          x: side * r.half * MathUtils.lerp(1, 0.86, v),
          y: MathUtils.lerp(r.y, COCKPIT_FLOOR_Y, v),
          z: st.z,
          t: v === 0 ? PANEL : CAVITY,
        }));
      }),
      // Seen from inside the well, so the outward test is inverted.
      { ref: (i) => _ref.set(0, COAMING_Y, wellStations[i].z), sign: -1 },
    );

    stitchGrid(
      b,
      wellStations.map((st) => {
        const half = rim(st).half * 0.86;
        return [1, 0.5, 0].map((k) => ({
          x: side * half * k,
          y: COCKPIT_FLOOR_Y,
          z: st.z,
          t: CAVITY,
        }));
      }),
      { dir: _dir.set(0, 1, 0) },
    );
  }

  return b.finish('deck');
}

// ---------------------------------------------------------------------------
// Cowling
// ---------------------------------------------------------------------------

const COWL_Z = [0.55, 0.85, 1.2, 1.5, 1.75, 1.98];
const COWL_HALF = [0.52, 0.5, 0.45, 0.37, 0.28, 0.17];
const COWL_TOP = [0.82, 0.83, 0.8, 0.75, 0.71, 0.68];

/**
 * The nose cowl: an eight-sided faceted shell over the fore deck, ending in a
 * recessed intake mouth.
 *
 * Its base is sampled from the deck's own crown height and then sunk 3 cm, so
 * the cowl is always buried in the deck it sits on regardless of what the sheer
 * table does. Sitting it at a fixed height would leave a gap at one end of the
 * boat or the other the first time anyone edits a station.
 */
export function buildCowlingGeometry(): BufferGeometry {
  const b = new SurfaceBuilder();

  const ring = (i: number): SurfacePoint[] => {
    const z = COWL_Z[i];
    const w = COWL_HALF[i];
    const st = sampleHullStation(z);
    const base = st.sheerY + 0.055 - 0.03;
    const top = COWL_TOP[i];
    const mid = MathUtils.lerp(base, top, 0.42);
    return [
      { x: w, y: base, z, t: PANEL },
      { x: w * 0.92, y: mid, z, t: PAINT },
      { x: w * 0.6, y: top - 0.03, z, t: PAINT },
      { x: 0, y: top, z, t: FLASH },
      { x: -w * 0.6, y: top - 0.03, z, t: PAINT },
      { x: -w * 0.92, y: mid, z, t: PAINT },
      { x: -w, y: base, z, t: PANEL },
      { x: 0, y: base - 0.02, z, t: PANEL },
    ];
  };

  const rings = COWL_Z.map((_, i) => ring(i));
  loftRings(b, rings);

  // Aft face is buried behind the coaming but still gets closed: an open shell
  // shows its own backfaces through the cockpit from a low chase camera.
  fanCap(b, rings[0], _dir.set(0, 0, -1), PANEL);
  insetMouth(b, rings[rings.length - 1], _dir.set(0, 0, -0.13), 0.6, CAVITY);

  return b.finish('cowling');
}

// ---------------------------------------------------------------------------
// Sponsons
// ---------------------------------------------------------------------------

const SPONSON_Z = [1.78, 1.45, 1.05, 0.55, -0.1, -0.7, -1.3, -1.95];
/** Inboard wall, kept inside the hull's chine at every station so it is buried. */
const SPONSON_IN = [0.34, 0.42, 0.5, 0.55, 0.58, 0.6, 0.62, 0.6];
const SPONSON_OUT = [0.62, 0.94, 1.1, 1.17, 1.205, SPONSON_HALF, SPONSON_HALF, 1.19];
/**
 * Sponson underside. The two outboard probe pairs live at -0.34 (z = 1.05) and
 * -0.44 (z = -1.30) and these are those numbers: the probes sample the sponson
 * bottoms, not the centre hull, because that is where a hydroplane's roll
 * authority comes from.
 */
const SPONSON_BOT = [-0.1, -0.26, -0.34, -0.375, -0.4, -0.42, -0.44, -0.44];
const SPONSON_TOP = [0.28, 0.3, 0.3, 0.305, 0.31, 0.32, 0.33, 0.34];

/**
 * An outrigger sponson.
 *
 * These are the signature silhouette element: they push the beam out to
 * HULL_BEAM/2 and sit far below the deck, so the boat reads as three hulls in
 * a row from head-on and as a wedge from the side. They are also what the four
 * outboard buoyancy probes actually rest on, and their flat bottoms carry a
 * built-in angle of attack — 10 cm shallower at the forward probe than at the
 * aft one — which is why the physics gets planing lift out of a bow-up attitude
 * rather than having to fake it.
 *
 * The outboard wall is tinted with the stripe tone so it answers the hull's
 * racing stripe instead of introducing a third value.
 */
export function buildSponsonGeometry(side: -1 | 1): BufferGeometry {
  const b = new SurfaceBuilder();

  const ring = (i: number): SurfacePoint[] => {
    const z = SPONSON_Z[i];
    const xi = SPONSON_IN[i] * side;
    const xo = SPONSON_OUT[i] * side;
    const bot = SPONSON_BOT[i];
    const top = SPONSON_TOP[i];
    return [
      { x: xi, y: bot, z, t: WET },
      { x: xo - 0.03 * side, y: bot, z, t: WET },
      { x: xo, y: bot + 0.13, z, t: STRIPE },
      { x: xo - 0.05 * side, y: top, z, t: STRIPE },
      { x: (xi + xo) * 0.5, y: top + 0.035, z, t: FLASH },
      { x: xi, y: top + 0.02, z, t: PAINT },
    ];
  };

  const rings = SPONSON_Z.map((_, i) => ring(i));
  loftRings(b, rings);
  fanCap(b, rings[0], _dir.set(0, 0, 1), PANEL);
  fanCap(b, rings[rings.length - 1], _dir.set(0, 0, -1), PANEL);

  return b.finish(side < 0 ? 'sponsonPort' : 'sponsonStarboard');
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

const ENGINE_Z = [-1.1, -1.35, -1.72, -2.05, -2.3];
const ENGINE_R = [0.26, 0.31, 0.32, 0.3, 0.24];
/** Octagon rolled by half a segment so the barrel has a flat top to mount on. */
const OCTAGON_PHASE = Math.PI / 8;

/**
 * Where the exhaust glow belongs.
 *
 * ENGINE_POINT sits inside the barrel — it is the mass centre the physics and
 * the audio care about, not a surface. The glow has to be somewhere a camera
 * can see it, and for a chase camera that means the nozzle plane at the back.
 * Derived from ENGINE_POINT rather than written out so the two cannot drift.
 */
export const ENGINE_NOZZLE = new Vector3(
  ENGINE_POINT.x,
  ENGINE_POINT.y,
  ENGINE_POINT.z - 0.62,
);

/** Rudder pivot, re-exported so the boat does not have to reach into hullSpec. */
export const RUDDER_PIVOT = RUDDER_POINT;

/**
 * The engine: a faceted octagonal turbine barrel on the after deck, with a
 * forward-facing roof scoop and a recessed nozzle.
 *
 * Centred on ENGINE_POINT's axis and tapering aft into the nozzle, so the
 * boost glow mounted at ENGINE_NOZZLE sits in an actual recess and lights the
 * inside of it. The barrel's lower half is buried in the deck; that is
 * intentional, an engine bolted on top of a flat deck looks like a prop.
 */
export function buildEngineGeometry(): BufferGeometry {
  const b = new SurfaceBuilder();
  const cy = ENGINE_POINT.y;

  const rings = ENGINE_Z.map((z, i) => {
    const t = i === 0 ? PANEL : i >= 3 ? PANEL : PAINT;
    return tubeRing(ENGINE_POINT.x, cy, z, 'z', ENGINE_R[i], 8, t, OCTAGON_PHASE);
  });
  loftRings(b, rings);
  fanCap(b, rings[0], _dir.set(0, 0, 1), PANEL);
  insetMouth(b, rings[rings.length - 1], _dir.set(0, 0, 0.16), 0.62, CAVITY);

  // Roof scoop. Small, forward-facing, recessed: from the chase camera this is
  // the one piece of the engine that is unambiguously machinery rather than a
  // painted box, and it costs about forty triangles.
  const scoopY = cy + 0.26;
  const scoopRings = [
    tubeRing(0, scoopY, -1.62, 'z', 0.11, 6, PANEL, Math.PI / 6),
    tubeRing(0, scoopY + 0.02, -1.44, 'z', 0.13, 6, PAINT, Math.PI / 6),
    tubeRing(0, scoopY + 0.02, -1.3, 'z', 0.13, 6, PAINT, Math.PI / 6),
  ];
  loftRings(b, scoopRings);
  fanCap(b, scoopRings[0], _dir.set(0, 0, -1), PANEL);
  insetMouth(b, scoopRings[2], _dir.set(0, 0, -0.1), 0.55, CAVITY);

  return b.finish('engine');
}

/**
 * The glow plate for the nozzle.
 *
 * Authored about its own origin in the XY plane, facing aft, because it is the
 * one part the boat scales at runtime — a flare has to grow from its centre,
 * and that only works if the centre is the origin. Mount it at ENGINE_NOZZLE.
 */
export function buildIntakeGlowGeometry(): BufferGeometry {
  const b = new SurfaceBuilder();
  const ring = tubeRing(0, 0, 0, 'z', 0.19, 16, PAINT, 0);
  fanCap(b, ring, _dir.set(0, 0, -1), PAINT);
  return b.finish('engineGlow');
}

// ---------------------------------------------------------------------------
// Fin, rudder, handlebars
// ---------------------------------------------------------------------------

/**
 * The stabiliser fin.
 *
 * Swept back hard, which is doing a specific job: from the chase camera the
 * boat is nearly all deck and the fin is the only vertical the eye can read
 * yaw against, so a fin that leans is worth several degrees of apparent turn.
 * Base is buried in the engine barrel.
 */
export function buildFinGeometry(): BufferGeometry {
  const b = new SurfaceBuilder();
  extrudePlate(
    b,
    [
      [-1.62, 0.7],
      [-2.58, 0.7],
      [-2.66, 1.06],
      [-2.02, 1.1],
    ],
    0.035,
    PAINT,
    STRIPE,
  );
  return b.finish('fin');
}

/**
 * The rudder blade, authored about its own pivot so the boat can just set
 * `rotation.y` on it.
 *
 * Kept shallow on purpose: the blade bottoms out at exactly -HULL_DRAFT in hull
 * space, so the deepest point of the assembled boat is still the number the
 * spec says it is. A rudder hanging below the keel would be more correct and
 * would quietly make every draft assumption in the project wrong.
 */
export function buildRudderGeometry(): BufferGeometry {
  const b = new SurfaceBuilder();
  const bottom = -HULL_DRAFT - RUDDER_POINT.y;
  extrudePlate(
    b,
    [
      [0.13, 0.14],
      [-0.19, 0.14],
      [-0.15, bottom],
      [0.06, bottom],
    ],
    0.025,
    PAINT,
    PANEL,
  );
  return b.finish('rudder');
}

/**
 * The handlebars, at HANDLEBAR_POINT.
 *
 * A stem out of the cowl, a swept crossbar, and two fat grips. The sweep is
 * quadratic in |x| so the bar ends come back and up towards the rider — the
 * rider's hand IK solves to a point on this bar, and bars that run dead
 * straight across put the wrists in a position no person would hold.
 */
export function buildHandlebarGeometry(): BufferGeometry {
  const b = new SurfaceBuilder();
  const hx = HANDLEBAR_POINT.x;
  const hy = HANDLEBAR_POINT.y;
  const hz = HANDLEBAR_POINT.z;

  const stem = [
    tubeRing(hx, 0.64, hz - 0.06, 'y', 0.075, 6, PANEL, Math.PI / 6),
    tubeRing(hx, 0.85, hz - 0.02, 'y', 0.062, 6, PANEL, Math.PI / 6),
    tubeRing(hx, hy, hz, 'y', 0.05, 6, PANEL, Math.PI / 6),
  ];
  loftRings(b, stem);
  fanCap(b, stem[0], _dir.set(0, -1, 0), PANEL);
  fanCap(b, stem[stem.length - 1], _dir.set(0, 1, 0), PANEL);

  const barHalf = 0.32;
  const barRing = (x: number, r: number, t: Tint): SurfacePoint[] => {
    const k = Math.abs(x) / barHalf;
    return tubeRing(hx + x, hy + 0.022 * k * k, hz - 0.055 * k * k, 'x', r, 6, t, Math.PI / 6);
  };

  const bar = [-barHalf, -0.22, -0.1, 0, 0.1, 0.22, barHalf].map((x) =>
    barRing(x, 0.036, PANEL),
  );
  loftRings(b, bar);
  fanCap(b, bar[0], _dir.set(-1, 0, 0), PANEL);
  fanCap(b, bar[bar.length - 1], _dir.set(1, 0, 0), PANEL);

  // Grips straddle x = +-0.212, which is where RiderRig's GRIP puts the wrists.
  for (const side of [-1, 1]) {
    const grip = [
      barRing(side * 0.15, 0.05, CAVITY),
      barRing(side * 0.21, 0.056, CAVITY),
      barRing(side * 0.29, 0.052, CAVITY),
    ];
    loftRings(b, grip);
    fanCap(b, grip[0], _dir.set(-side, 0, 0), CAVITY);
    fanCap(b, grip[grip.length - 1], _dir.set(side, 0, 0), CAVITY);
  }

  return b.finish('handlebar');
}
