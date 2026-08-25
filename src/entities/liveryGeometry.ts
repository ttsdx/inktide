import { BufferAttribute, BufferGeometry, Color, MathUtils } from 'three';
import { sampleHullStation } from './boatGeometry.ts';

/**
 * RACE NUMBERS
 *
 * Four boats that differ only in hue are four boats a player cannot tell apart
 * once they are more than fifty metres away, in spray, or on a minimap-sized
 * portion of the screen. Every racing game solves this the same way and has for
 * fifty years: put a big number on the thing.
 *
 * WHY SEVEN-SEGMENT
 *
 * The numerals are built from rectangles on a seven-segment layout rather than
 * from letterforms. Three reasons, in order of how much they mattered:
 *
 *   A digit made of rectangles needs no glyph outlines, no triangulation and no
 *   font — which is the only way to have numbers at all in a project that ships
 *   zero external assets and generates every vertex in code.
 *
 *   Rectangles survive being small. The number has to read at the distance a
 *   rival is actually seen from, and a stroke of constant width holds its shape
 *   down to a few pixels where a modelled numeral's thin joins disappear first.
 *
 *   It suits the art direction. The rest of the frame is hard-edged flat shapes
 *   with ink round them; a seven-segment numeral is already that.
 *
 * HOW IT SITS ON THE HULL
 *
 * Not as a flat plate. The topside is curved in both directions, so a plate
 * either floats off the middle of the number or buries its corners. Each vertex
 * instead has its outboard position looked up from the real hull section at its
 * own z and y — `sampleHullStation` is the same function the hull loft itself
 * is built from — and is then pushed out along the local surface normal. The
 * number is therefore painted on the boat rather than bolted to it, and it
 * stays that way if the hull's control points are ever edited.
 */

/** Stroke width as a fraction of the numeral's box. */
const STROKE = 0.2;
/** How far the plate stands off the hull surface, in metres. */
const RELIEF = 0.012;

type Rect = readonly [number, number, number, number]; // u0, v0, u1, v1

/**
 * The seven segments on a unit box. `u` runs along the numeral's reading
 * direction and `v` upwards.
 *
 *      --A--
 *     |F   B|
 *      --G--
 *     |E   C|
 *      --D--
 */
const SEGMENTS: Record<string, Rect> = {
  A: [STROKE * 0.6, 1 - STROKE, 1 - STROKE * 0.6, 1],
  G: [STROKE * 0.6, 0.5 - STROKE / 2, 1 - STROKE * 0.6, 0.5 + STROKE / 2],
  D: [STROKE * 0.6, 0, 1 - STROKE * 0.6, STROKE],
  F: [0, 0.5, STROKE, 1],
  B: [1 - STROKE, 0.5, 1, 1],
  E: [0, 0, STROKE, 0.5],
  C: [1 - STROKE, 0, 1, 0.5],
};

/** Which segments each racing number lights. Only 1-4 exist in this game. */
const DIGITS: Record<number, readonly string[]> = {
  1: ['B', 'C'],
  2: ['A', 'B', 'G', 'E', 'D'],
  3: ['A', 'B', 'G', 'C', 'D'],
  4: ['F', 'B', 'G', 'C'],
};

/**
 * A racing numeral's box on the hull flank, in hull space.
 *
 * Sited on the topside between the chine and the sheer, forward of the cockpit
 * where the panel is broadest and where a chase camera looking past a rival
 * actually sees it.
 */
const FLANK = { z0: -0.45, z1: 1.05, v0: 0.06, v1: 0.86 };

/**
 * Where a point sits on the topside at a given station.
 *
 * The topside is the run from the chine to the sheer, so a normalised height
 * `t` interpolates between the two. Returns the outboard half-width and the
 * world Y, plus the section's local slope so the relief can be pushed along
 * something close to the surface normal instead of straight out sideways.
 */
function topsideAt(z: number, t: number): { half: number; y: number; slope: number } {
  const st = sampleHullStation(z);
  const half = MathUtils.lerp(st.chineHalf, st.sheerHalf, t);
  const y = MathUtils.lerp(st.chineY, st.sheerY, t);
  // d(half)/d(y) across the topside: positive where the section flares out as
  // it rises. The surface normal in the section plane is perpendicular to that.
  const dy = st.sheerY - st.chineY;
  const dh = st.sheerHalf - st.chineHalf;
  return { half, y, slope: Math.abs(dy) > 1e-4 ? dh / dy : 0 };
}

interface Builder {
  pos: number[];
  col: number[];
  idx: number[];
}

/**
 * One segment, conformed to the hull and given thickness.
 *
 * Both faces are emitted, plus the four sides, because the ink shell inverts a
 * closed volume — an open plate turns inside out and the outline explodes.
 */
function segment(b: Builder, rect: Rect, side: number, mirror: boolean, colour: Color): void {
  const [u0, v0, u1, v1] = rect;
  const corners: Array<[number, number]> = [
    [u0, v0],
    [u1, v0],
    [u1, v1],
    [u0, v1],
  ];

  const base = b.pos.length / 3;

  for (const [u, v] of corners) {
    // The port side reads the other way round, so its u axis is flipped.
    const uz = mirror ? 1 - u : u;
    const z = MathUtils.lerp(FLANK.z0, FLANK.z1, uz);
    const t = MathUtils.lerp(FLANK.v0, FLANK.v1, v);
    const { half, y, slope } = topsideAt(z, t);

    // Outward normal in the section plane: (1, -slope) normalised, pointing
    // away from the centreline.
    const nl = Math.hypot(1, slope) || 1;
    const nx = (1 / nl) * side;
    const ny = -slope / nl;

    // Inner face sits a hair proud of the hull so it never z-fights with it;
    // the outer face carries the relief.
    for (const push of [0.001, RELIEF]) {
      b.pos.push(half * side + nx * push, y + ny * push, z);
      b.col.push(colour.r, colour.g, colour.b);
    }
  }

  // Each corner contributed two vertices: inner at 2i, outer at 2i+1.
  const inner = (i: number) => base + i * 2;
  const outer = (i: number) => base + i * 2 + 1;

  // Outer face. Winding is flipped on the port side so both read front-facing.
  const face = mirror
    ? [
        [outer(0), outer(1), outer(2)],
        [outer(0), outer(2), outer(3)],
      ]
    : [
        [outer(0), outer(2), outer(1)],
        [outer(0), outer(3), outer(2)],
      ];
  for (const f of face) b.idx.push(...f);

  // Inner face, wound the other way.
  const back = mirror
    ? [
        [inner(0), inner(2), inner(1)],
        [inner(0), inner(3), inner(2)],
      ]
    : [
        [inner(0), inner(1), inner(2)],
        [inner(0), inner(2), inner(3)],
      ];
  for (const f of back) b.idx.push(...f);

  // Sides.
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    if (mirror) {
      b.idx.push(inner(i), outer(i), inner(j));
      b.idx.push(inner(j), outer(i), outer(j));
    } else {
      b.idx.push(inner(i), inner(j), outer(i));
      b.idx.push(inner(j), outer(j), outer(i));
    }
  }
}

/**
 * The race number for one flank, in hull space.
 *
 * `side` is +1 for starboard and -1 for port. Vertex colours are flat white so
 * the material's own paint colour comes through unmodulated; the contrast comes
 * from the material, not from here.
 */
export function buildRaceNumberGeometry(digit: number, side: -1 | 1): BufferGeometry {
  const segs = DIGITS[digit] ?? DIGITS[1];
  const b: Builder = { pos: [], col: [], idx: [] };
  const white = new Color(1, 1, 1);

  // Starboard reads bow-forward along +z; port is the mirror of it.
  const mirror = side === -1;
  for (const name of segs) segment(b, SEGMENTS[name], side, mirror, white);

  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(new Float32Array(b.pos), 3));
  geo.setAttribute('color', new BufferAttribute(new Float32Array(b.col), 3));
  geo.setIndex(b.idx);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}
