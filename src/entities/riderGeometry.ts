import { BufferAttribute, BufferGeometry, MathUtils, Vector3 } from 'three';

/**
 * RIDER GEOMETRY — every body part, authored by hand as lofted cross-sections.
 *
 * There are no assets in this project, so the character is built the same way a
 * modeller would block one out: a stack of explicit cross-section rings per
 * limb, lofted into a shell. Nothing here uses `CapsuleGeometry` or
 * `SphereGeometry`, and that is a deliberate art decision rather than purity —
 * a cel ramp quantises N·L into four bands, so a mathematically smooth surface
 * turns into wide, wobbling, low-contrast band boundaries that crawl as the
 * character animates. Faceted forms pin the terminator to an actual edge, which
 * is what makes hand-drawn shading read as *drawn*.
 *
 * Two conventions hold everywhere in this file and the rig depends on both:
 *
 *   1. ORIGIN AT THE JOINT. An upper arm's origin is the shoulder and the mesh
 *      hangs down -Y from there. Parenting a part to its bone is therefore the
 *      whole of the "skinning" step; there is no bind pose to invert.
 *   2. THE CHARACTER FACES +Z. Three.js orients a plain `Object3D` so that
 *      `lookAt` aims +Z at the target, so +Z forward keeps the rider consistent
 *      with anything else built with that assumption. With +Y up and a
 *      right-handed basis this puts the rider's RIGHT hand at -X (see `RIGHT`
 *      in Rider.ts) — the mirror of what most people guess, and worth stating
 *      out loud because every asymmetric detail below depends on it.
 *
 * Budget: the whole rider is ~2.0k triangles and is drawn eight times per frame
 * (four racers plus their inverted-hull ink shells), so segment counts are kept
 * deliberately low. Low counts are also what produces the faceting we want, so
 * the budget and the art direction pull in the same direction here.
 */

// ---------------------------------------------------------------------------
// Shared dimensions
// ---------------------------------------------------------------------------

/**
 * The single source of truth for bone lengths. `RiderRig` builds its skeleton
 * from these numbers, so a limb mesh and the bone it hangs from can never drift
 * apart. Metres; the rider is ~1.7 m if you straightened them out.
 */
export const RIDER_DIMS = {
  upperArm: 0.28,
  forearm: 0.26,
  hand: 0.12,
  thigh: 0.42,
  shin: 0.4,
  /** Hip joint to the top of the pelvis shell. */
  pelvisTop: 0.075,
  spineLower: 0.17,
  spineUpper: 0.17,
  neck: 0.165,
  head: 0.07,
  /** Crown of the helmet above the head joint. */
  helmetTop: 0.196,
} as const;

// ---------------------------------------------------------------------------
// Lofting core
// ---------------------------------------------------------------------------

export interface LoftOptions {
  /** Close the loop from the last ring point back to the first. Default true. */
  closed?: boolean;
  capStart?: boolean;
  capEnd?: boolean;
  /**
   * Ring indices that must read as a hard crease. The ring is emitted twice so
   * `computeVertexNormals` physically cannot average across it — this is how we
   * get a crisp cel terminator on a helmet jaw line or the top of a boot
   * instead of a smooth gradient smeared over the whole part.
   */
  hardRings?: readonly number[];
  /** Split every quad into its own flat-shaded face. Fully angular. */
  faceted?: boolean;
}

const _e1 = new Vector3();
const _e2 = new Vector3();
const _fn = new Vector3();
const _cen = new Vector3();
const _ref = new Vector3();
const _capDir = new Vector3();

function ringCentre(ring: readonly Vector3[], out: Vector3): Vector3 {
  out.set(0, 0, 0);
  for (const p of ring) out.add(p);
  return out.multiplyScalar(1 / ring.length);
}

/**
 * Flip a run of triangles if it is facing inwards.
 *
 * Getting loft winding right by inspection is a coin flip that stays wrong
 * until someone looks at the running game, and this subsystem cannot be looked
 * at in isolation. So instead of asserting a winding we *measure* one: sum the
 * area-weighted face normals against a known outward direction and reverse the
 * whole run if the vote comes out negative. Every group passed here is
 * internally consistent by construction (all side quads, or one cap), so a
 * single vote per group is enough and there is no risk of one lone triangle
 * ending up inverted.
 *
 * `refs` supplies, per vertex, a point on the section axis; for side faces the
 * outward direction is (face centroid - axis point), which is exactly the
 * radial direction. Caps pass an explicit `dir` instead because their outward
 * direction is along the loft axis, where the radial test degenerates.
 */
function orientGroup(
  positions: readonly number[],
  indices: number[],
  start: number,
  end: number,
  refs: readonly number[] | null,
  dir: Vector3 | null,
): void {
  let vote = 0;
  for (let t = start; t < end; t += 3) {
    const a = indices[t] * 3;
    const b = indices[t + 1] * 3;
    const c = indices[t + 2] * 3;
    _e1.set(positions[b] - positions[a], positions[b + 1] - positions[a + 1], positions[b + 2] - positions[a + 2]);
    _e2.set(positions[c] - positions[a], positions[c + 1] - positions[a + 1], positions[c + 2] - positions[a + 2]);
    // Length of the cross product is twice the triangle area, so this weights
    // big faces more heavily for free.
    _fn.crossVectors(_e1, _e2);

    if (dir) {
      vote += _fn.dot(dir);
    } else if (refs) {
      _cen.set(
        (positions[a] + positions[b] + positions[c]) / 3,
        (positions[a + 1] + positions[b + 1] + positions[c + 1]) / 3,
        (positions[a + 2] + positions[b + 2] + positions[c + 2]) / 3,
      );
      _ref.set(
        (refs[a] + refs[b] + refs[c]) / 3,
        (refs[a + 1] + refs[b + 1] + refs[c + 1]) / 3,
        (refs[a + 2] + refs[b + 2] + refs[c + 2]) / 3,
      );
      vote += _fn.dot(_cen.sub(_ref));
    }
  }
  if (vote >= 0) return;
  for (let t = start; t < end; t += 3) {
    const tmp = indices[t + 1];
    indices[t + 1] = indices[t + 2];
    indices[t + 2] = tmp;
  }
}

/**
 * Loft a stack of equal-length rings into a closed shell.
 *
 * Rings do not have to be circular or even convex — they only have to be
 * star-shaped about their own centroid, which every section in this file is.
 * That is what lets the same routine build a helmet, a boot and the crescent-ish
 * visor lens without special cases.
 */
export function loftRings(rings: readonly (readonly Vector3[])[], opts: LoftOptions = {}): BufferGeometry {
  const ringCount = rings.length;
  if (ringCount < 2) throw new Error('loftRings: need at least two rings');
  const n = rings[0].length;
  for (const r of rings) {
    if (r.length !== n) throw new Error('loftRings: every ring must have the same point count');
  }

  const closed = opts.closed ?? true;
  const capStart = opts.capStart ?? true;
  const capEnd = opts.capEnd ?? true;
  const hard = new Set(opts.hardRings ?? []);

  const centres = rings.map((r) => ringCentre(r, new Vector3()));

  const positions: number[] = [];
  const refs: number[] = [];
  const indices: number[] = [];

  /** Append one copy of a ring and return its first vertex index. */
  const pushBlock = (r: number): number => {
    const base = positions.length / 3;
    const c = centres[r];
    for (const p of rings[r]) {
      positions.push(p.x, p.y, p.z);
      refs.push(c.x, c.y, c.z);
    }
    return base;
  };

  // Walk the stack building spans. A creased ring gets two vertex blocks: the
  // first terminates the span below it, the second starts the span above, so
  // the two sides never share a vertex and never share a normal. No degenerate
  // zero-height span is emitted between them.
  const spans: Array<[number, number]> = [];
  let prev = -1;
  for (let r = 0; r < ringCount; r++) {
    const bIn = pushBlock(r);
    if (prev >= 0) spans.push([prev, bIn]);
    prev = hard.has(r) && r > 0 && r < ringCount - 1 ? pushBlock(r) : bIn;
  }

  const segs = closed ? n : n - 1;
  for (const [a, b] of spans) {
    for (let i = 0; i < segs; i++) {
      const j = (i + 1) % n;
      indices.push(a + i, a + j, b + j);
      indices.push(a + i, b + j, b + i);
    }
  }
  orientGroup(positions, indices, 0, indices.length, refs, null);

  // Caps get their own copy of the rim so the cap face stays hard against the
  // wall it closes; sharing the rim would round the top of every boot off.
  const addCap = (r: number, awayFrom: number): void => {
    const start = indices.length;
    const base = pushBlock(r);
    const c = centres[r];
    const centreIndex = positions.length / 3;
    positions.push(c.x, c.y, c.z);
    refs.push(c.x, c.y, c.z);
    const fanEnd = closed ? n : n - 1;
    for (let i = 0; i < fanEnd; i++) {
      indices.push(centreIndex, base + i, base + ((i + 1) % n));
    }
    orientGroup(positions, indices, start, indices.length, null, _capDir.subVectors(c, centres[awayFrom]));
  };
  if (capStart) addCap(0, Math.min(1, ringCount - 1));
  if (capEnd) addCap(ringCount - 1, Math.max(0, ringCount - 2));

  let geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geo.setIndex(indices);

  if (opts.faceted) {
    const flat = geo.toNonIndexed();
    geo.dispose();
    geo = flat;
  }
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

// ---------------------------------------------------------------------------
// Section helper
// ---------------------------------------------------------------------------

export interface Section {
  /** Height of the ring along the part's own axis. */
  y: number;
  /** Half-extent along X (across the body). */
  w: number;
  /** Half-extent along Z (front to back). */
  d: number;
  /** Lateral offset of the ring centre. */
  x?: number;
  /** Fore/aft offset of the ring centre. */
  z?: number;
  /**
   * Superellipse exponent. 2 is a plain ellipse, 3-4 is the squarish
   * "armour panel" shape almost everything here uses, 8 is nearly a box. The
   * squarer the section the flatter its facets and the harder its cel bands.
   */
  round?: number;
  /** Emit this ring as a hard crease. */
  hard?: boolean;
}

/**
 * Sample a superellipse |x/w|^n + |z/d|^n = 1.
 *
 * Sampling by angle rather than by arc length deliberately bunches vertices
 * towards the corners, which is where the silhouette needs the resolution.
 */
function sectionRing(s: Section, segments: number): Vector3[] {
  const n = s.round ?? 3.2;
  const e = 2 / n;
  const cx = s.x ?? 0;
  const cz = s.z ?? 0;
  const pts: Vector3[] = [];
  for (let i = 0; i < segments; i++) {
    // An even segment count with this phase puts a vertex dead centre on the
    // front, back and both sides, so the silhouette stays symmetric.
    const t = (i / segments) * Math.PI * 2;
    const c = Math.cos(t);
    const si = Math.sin(t);
    const x = Math.sign(c) * Math.pow(Math.abs(c), e) * s.w;
    const z = Math.sign(si) * Math.pow(Math.abs(si), e) * s.d;
    pts.push(new Vector3(cx + x, s.y, cz + z));
  }
  return pts;
}

/** Loft a stack of superelliptical sections. The workhorse for limbs and shells. */
export function loftSections(
  sections: readonly Section[],
  segments: number,
  opts: Omit<LoftOptions, 'hardRings'> = {},
): BufferGeometry {
  const rings = sections.map((s) => sectionRing(s, segments));
  const hardRings: number[] = [];
  sections.forEach((s, i) => {
    if (s.hard) hardRings.push(i);
  });
  return loftRings(rings, { ...opts, hardRings });
}

// ---------------------------------------------------------------------------
// Head
// ---------------------------------------------------------------------------

/**
 * Full-face racing helmet. Origin at the head joint (roughly the atlas), which
 * sits a little behind and below the visual centre of the head.
 *
 * The silhouette is doing all the work at the distance a rider is actually seen
 * from, so three features are exaggerated well past life: a chin bar that juts
 * forward, a brow that overhangs the visor by a hard step, and a crown that
 * tapers fast so the head does not read as a ball. The two creases at the jaw
 * and the brow are the only ones the cel ramp needs — everything else can round.
 *
 * The head is ~0.30 m on a 1.7 m body, a touch over the anime 1/6 rule, because
 * the helmet has to survive being 40 px tall on screen.
 */
export function buildHelmet(): BufferGeometry {
  return loftSections(
    [
      { y: -0.11, w: 0.05, d: 0.07, z: 0.034, round: 3.0 },
      // Jaw line: the underside of the chin bar. Hard, so the shadow under the
      // helmet is a drawn line and not a soft gradient into the neck.
      { y: -0.082, w: 0.082, d: 0.1, z: 0.022, round: 3.2, hard: true },
      { y: -0.035, w: 0.104, d: 0.116, z: 0.008, round: 3.4 },
      // The front is pulled in through the eye band so the visor can sit proud
      // of it rather than fighting it in the depth buffer.
      { y: 0.012, w: 0.116, d: 0.122, z: 0.002, round: 3.6 },
      // Brow shelf: overhangs the visor, then steps straight back. Two hard
      // rings in a row is what makes it a shelf rather than a bulge.
      { y: 0.048, w: 0.119, d: 0.132, z: 0.0, round: 3.6, hard: true },
      { y: 0.07, w: 0.117, d: 0.12, z: -0.004, round: 3.5, hard: true },
      { y: 0.118, w: 0.108, d: 0.113, z: -0.008, round: 3.2 },
      { y: 0.163, w: 0.082, d: 0.086, z: -0.012, round: 2.8 },
      { y: RIDER_DIMS.helmetTop, w: 0.04, d: 0.044, z: -0.016, round: 2.5 },
    ],
    10,
  );
}

/**
 * Visor lens. Origin at the head joint so it parents next to the helmet.
 *
 * Built as a solid wedge rather than a shell: the cross-section is an arc across
 * the front closed by a straight chord at the back. The chord lives inside the
 * helmet where nothing can see it, and it keeps the section star-shaped so the
 * generic loft handles it. A crescent shell would be watertight too but it
 * would double the triangle count for a surface nobody can see the back of.
 *
 * Unlike the helmet this is sampled on a circle, not a superellipse. The visor
 * is the one part that should read as glass: a smooth sweep under an emissive
 * material catches the rim term as one continuous highlight, which is what
 * turns the face into a single bright shape.
 */
export function buildVisor(): BufferGeometry {
  const rows: Array<{ y: number; s: number; hard?: boolean }> = [
    { y: -0.056, s: 0.92 },
    { y: -0.03, s: 1.0, hard: true },
    { y: 0.008, s: 1.0 },
    { y: 0.038, s: 0.96, hard: true },
    { y: 0.054, s: 0.8 },
  ];
  const W = 0.12;
  const D = 0.134;
  const ZC = 0.004;
  const SPAN = 1.3; // radians either side of dead ahead: a ~150 degree wrap
  const ARC = 8;

  const rings = rows.map((r) => {
    const pts: Vector3[] = [];
    for (let i = 0; i < ARC; i++) {
      const a = MathUtils.lerp(-SPAN, SPAN, i / (ARC - 1));
      pts.push(new Vector3(Math.sin(a) * W * r.s, r.y, ZC + Math.cos(a) * D * r.s));
    }
    return pts;
  });
  const hardRings: number[] = [];
  rows.forEach((r, i) => {
    if (r.hard) hardRings.push(i);
  });
  return loftRings(rings, { hardRings });
}

/**
 * Rear spoiler fin. Small, accent-coloured, and the only thing that tells you
 * which way the rider's head is pointing when they are seen from behind.
 */
export function buildHelmetFin(): BufferGeometry {
  return loftSections(
    [
      { y: 0.185, w: 0.014, d: 0.026, z: -0.058, round: 3.0 },
      { y: 0.145, w: 0.022, d: 0.05, z: -0.08, round: 3.2, hard: true },
      { y: 0.08, w: 0.024, d: 0.058, z: -0.098, round: 3.2 },
      { y: 0.025, w: 0.017, d: 0.038, z: -0.106, round: 2.8 },
    ],
    6,
  );
}

/**
 * Racer-coloured stripe running over the crown from brow to fin.
 *
 * Swept along an arc in the YZ plane instead of stacked along Y, so this one
 * builds its rings by hand: a small rectangular cross-section walked over the
 * helmet's profile, floated a few millimetres proud so it never z-fights.
 */
export function buildHelmetStripe(): BufferGeometry {
  const STEPS = 7;
  const HALF_W = 0.021;
  const THICK = 0.009;
  const cy = 0.03;
  const cz = -0.006;
  const ry = 0.15;
  const rz = 0.148;

  const rings: Vector3[][] = [];
  for (let i = 0; i < STEPS; i++) {
    // From just above the brow, over the crown, down to the root of the fin.
    const a = MathUtils.lerp(0.42, 2.55, i / (STEPS - 1));
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const yi = cy + ry * sa;
    const zi = cz + rz * ca;
    const yo = cy + (ry + THICK) * sa;
    const zo = cz + (rz + THICK) * ca;
    rings.push([
      new Vector3(-HALF_W, yi, zi),
      new Vector3(HALF_W, yi, zi),
      new Vector3(HALF_W, yo, zo),
      new Vector3(-HALF_W, yo, zo),
    ]);
  }
  return loftRings(rings, { faceted: true });
}

/** The sliver of neck visible under the chin bar. Origin at the neck joint. */
export function buildNeck(): BufferGeometry {
  return loftSections(
    [
      { y: -0.03, w: 0.05, d: 0.05, round: 2.6 },
      { y: 0.06, w: 0.045, d: 0.047, round: 2.6 },
    ],
    6,
  );
}

// ---------------------------------------------------------------------------
// Torso
// ---------------------------------------------------------------------------

/**
 * Chest and shoulder shell. Origin at the chest joint (base of the ribcage).
 *
 * The two hard rings at 0.100 and 0.150 build the deltoid shelf: the section
 * widens fast, holds, then collapses into the neck. Under a cel ramp that shelf
 * catches the key light as one flat plane, which is the single strongest read
 * of "broad shoulders" available without adding triangles.
 *
 * It extends below its own origin to overlap the abdomen. Overlapping shells
 * are how a rigid-part rig survives a spine bend without opening a seam, and
 * they cost nothing because the intersection is buried inside a solid body.
 */
export function buildTorso(): BufferGeometry {
  return loftSections(
    [
      { y: -0.085, w: 0.128, d: 0.098, round: 3.0 },
      { y: -0.02, w: 0.152, d: 0.108, round: 3.2 },
      { y: 0.045, w: 0.18, d: 0.116, round: 3.4 },
      { y: 0.1, w: 0.212, d: 0.118, round: 3.6, hard: true },
      { y: 0.15, w: 0.228, d: 0.112, round: 3.8, hard: true },
      { y: 0.185, w: 0.196, d: 0.094, round: 3.4 },
      { y: 0.205, w: 0.14, d: 0.07, round: 3.0 },
    ],
    10,
  );
}

/**
 * Abdomen. Origin at the lower spine joint.
 *
 * The waist pinch at y=0.06 is 10 mm narrower than the ring below it, which is
 * anatomically nonsense and exactly the point: the taper from a 0.46 m shoulder
 * to a 0.26 m waist is the proportion that makes the silhouette read as a
 * stylised athlete rather than a barrel.
 */
export function buildAbdomen(): BufferGeometry {
  return loftSections(
    [
      { y: -0.02, w: 0.135, d: 0.1, round: 3.0 },
      { y: 0.06, w: 0.128, d: 0.094, round: 3.0 },
      { y: 0.13, w: 0.136, d: 0.098, round: 3.2 },
      { y: RIDER_DIMS.spineLower + 0.03, w: 0.15, d: 0.106, round: 3.4 },
    ],
    10,
  );
}

/** Pelvis and upper thigh mass. Origin at the hips, which is the rig root. */
export function buildPelvis(): BufferGeometry {
  return loftSections(
    [
      { y: RIDER_DIMS.pelvisTop, w: 0.14, d: 0.104, round: 3.0 },
      // Belt line. A hard ring here gives the suit a drawn waistband for free.
      { y: 0.02, w: 0.156, d: 0.112, round: 3.2, hard: true },
      { y: -0.045, w: 0.158, d: 0.116, round: 3.4 },
      { y: -0.105, w: 0.14, d: 0.108, round: 3.2 },
      { y: -0.14, w: 0.105, d: 0.086, round: 2.8 },
    ],
    10,
  );
}

// ---------------------------------------------------------------------------
// Arms
// ---------------------------------------------------------------------------

/** Upper arm. Origin at the shoulder, hanging down -Y. */
export function buildUpperArm(): BufferGeometry {
  return loftSections(
    [
      { y: 0.03, w: 0.058, d: 0.058, round: 3.0 },
      { y: -0.01, w: 0.068, d: 0.066, round: 3.2, hard: true },
      { y: -0.09, w: 0.058, d: 0.058, round: 3.0 },
      { y: -0.2, w: 0.046, d: 0.048, round: 2.8 },
      { y: -RIDER_DIMS.upperArm + 0.008, w: 0.043, d: 0.045, round: 2.8 },
    ],
    8,
  );
}

/** Forearm. Origin at the elbow. Slightly deeper than wide, like a real one. */
export function buildForearm(): BufferGeometry {
  return loftSections(
    [
      { y: 0.02, w: 0.048, d: 0.05, round: 2.8 },
      { y: -0.04, w: 0.052, d: 0.054, round: 3.0 },
      { y: -0.15, w: 0.042, d: 0.044, round: 2.8 },
      { y: -RIDER_DIMS.forearm + 0.025, w: 0.038, d: 0.04, round: 2.6 },
    ],
    8,
  );
}

/**
 * Glove. Origin at the wrist.
 *
 * The rings march forward in Z as they descend, so the mesh is a closed fist
 * already curled around a handlebar. Modelling the grip into the geometry means
 * the animation never has to solve fingers, which is the whole reason the
 * character is wearing gloves in the first place.
 */
export function buildGlove(): BufferGeometry {
  // A CLOSED FIST, not a tapered stub.
  //
  // The previous shape narrowed smoothly from the cuff to a point, following
  // the forearm's axis, which is the silhouette of an arm ending rather than of
  // a hand gripping something. Reviewers reading the frames concluded the
  // riders had no hands at all — and at the size the character reaches in a
  // cockpit shot, roughly 900 px tall, that is a fair reading of what was
  // there.
  //
  // What makes a fist read is not detail, it is two hard breaks: the knuckle
  // line where the hand stops being a wrist, and the finger break where the
  // curled fingers meet the palm. Both are `hard` rings here, and the widest
  // point is now the knuckles rather than the cuff, so the shape swells before
  // it closes instead of tapering all the way down.
  return loftSections(
    [
      { y: 0.012, w: 0.042, d: 0.046, round: 3.0 },
      // Gauntlet cuff: hard, because a crisp ring here separates glove from
      // forearm at any distance and hides the joint between the two meshes.
      { y: -0.014, w: 0.054, d: 0.062, z: 0.006, round: 3.2, hard: true },
      // Knuckles, and the widest section on the hand.
      { y: -0.042, w: 0.066, d: 0.078, z: 0.020, round: 3.4, hard: true },
      // Finger break: the curl starts here and the section steps in.
      { y: -0.074, w: 0.060, d: 0.074, z: 0.032, round: 3.2, hard: true },
      { y: -RIDER_DIMS.hand, w: 0.046, d: 0.058, z: 0.040, round: 2.8 },
    ],
    6,
  );
}

/**
 * The thumb, as its own mesh laid over the top of the fist.
 *
 * A fist without one reads as a mitten, and a mitten reads as a placeholder.
 * It is four sections and about sixty triangles, which buys the single feature
 * that says a hand is wrapped around something rather than resting on it.
 */
export function buildThumb(side: number): BufferGeometry {
  const s = Math.sign(side) || 1;
  return loftSections(
    [
      { y: -0.016, w: 0.020, d: 0.024, x: -s * 0.040, z: 0.020, round: 2.6 },
      { y: -0.034, w: 0.023, d: 0.027, x: -s * 0.050, z: 0.034, round: 2.8, hard: true },
      { y: -0.056, w: 0.021, d: 0.025, x: -s * 0.052, z: 0.046, round: 2.6 },
      { y: -0.070, w: 0.014, d: 0.018, x: -s * 0.048, z: 0.052, round: 2.2 },
    ],
    5,
  );
}

/**
 * Shoulder pad. Origin at the shoulder joint; `side` is +1 for the rider's left
 * (+X) and -1 for the right. Accent-coloured, and the largest flat plane on the
 * character, which makes it the panel that identifies a racer at range.
 */
export function buildShoulderPad(side: number): BufferGeometry {
  const s = Math.sign(side) || 1;
  return loftSections(
    [
      { y: 0.075, w: 0.07, d: 0.086, x: s * 0.005, round: 3.2 },
      { y: 0.03, w: 0.098, d: 0.108, x: s * 0.02, round: 3.4, hard: true },
      // Pad rim: the flare stops dead here instead of rounding off, so the pad
      // throws a hard shadow line down the arm.
      { y: -0.03, w: 0.106, d: 0.112, x: s * 0.038, round: 3.6, hard: true },
      { y: -0.062, w: 0.086, d: 0.092, x: s * 0.046, round: 3.2 },
    ],
    8,
  );
}

// ---------------------------------------------------------------------------
// Legs
// ---------------------------------------------------------------------------

/** Thigh. Origin at the hip joint. */
export function buildThigh(): BufferGeometry {
  return loftSections(
    [
      { y: 0.045, w: 0.098, d: 0.1, round: 3.0 },
      { y: -0.03, w: 0.104, d: 0.108, round: 3.2 },
      { y: -0.18, w: 0.088, d: 0.094, round: 3.0 },
      { y: -0.33, w: 0.074, d: 0.08, round: 2.8 },
      { y: -RIDER_DIMS.thigh + 0.015, w: 0.07, d: 0.076, round: 2.8 },
    ],
    8,
  );
}

/**
 * Shin. Origin at the knee.
 *
 * The two hard rings at the top are a knee pad. The knee is the most flexed
 * joint in the rest pose and the one that moves most on a landing, so it is
 * worth the four extra triangles to give it an edge that the eye can track
 * through the compression.
 */
export function buildShin(): BufferGeometry {
  return loftSections(
    [
      { y: 0.04, w: 0.078, d: 0.082, round: 3.0, hard: true },
      { y: -0.02, w: 0.082, d: 0.09, round: 3.2, hard: true },
      { y: -0.15, w: 0.062, d: 0.07, round: 2.8 },
      { y: -0.3, w: 0.05, d: 0.056, round: 2.6 },
      { y: -RIDER_DIMS.shin + 0.028, w: 0.048, d: 0.052, round: 2.6 },
    ],
    8,
  );
}

/**
 * Boot. Origin at the ankle, toe towards +Z for both feet.
 *
 * Deliberately oversized — chunky boots and gloves are the cheapest way to sell
 * anime proportions, because they put visual mass at the extremities where the
 * silhouette is thinnest. The hard ring at the cuff and the hard ring at the
 * sole bracket the boot as its own object rather than a continuation of the leg.
 */
export function buildBoot(): BufferGeometry {
  return loftSections(
    [
      { y: 0.03, w: 0.07, d: 0.076, round: 3.0 },
      { y: -0.01, w: 0.082, d: 0.092, z: 0.006, round: 3.4, hard: true },
      { y: -0.06, w: 0.076, d: 0.104, z: 0.026, round: 3.4 },
      { y: -0.098, w: 0.07, d: 0.122, z: 0.05, round: 3.6, hard: true },
      { y: -0.118, w: 0.062, d: 0.112, z: 0.056, round: 3.4 },
    ],
    8,
  );
}
