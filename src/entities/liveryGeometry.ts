import { BufferAttribute, BufferGeometry, Color, MathUtils } from 'three';
import { sponsonWallAt } from './boatGeometry.ts';

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
 * WHERE IT GOES, AND WHY NOT ON THE HULL
 *
 * On the outboard wall of the sponson, not on the hull's own topside. The
 * topside is where a number belongs on a boat without outriggers, and that is
 * where this went first — but these hulls are hydroplanes and the sponson
 * covers nearly all of that panel, so the numeral came back almost entirely
 * buried behind it with a couple of pale slivers showing. The sponson wall is
 * by a wide margin the largest flat area on the boat and it is what a chase
 * camera coming up behind a rival actually sees.
 *
 * Each vertex still takes its position from the real sponson section at its own
 * z, through `sponsonWallAt`, rather than from a flat plate: the wall tapers
 * fore and aft, so a plate would float off it at the ends.
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
 * The numeral's box on the sponson wall, in hull space.
 *
 * `z0`/`z1` bracket the part of the wall that is close to parallel-sided, and
 * the two `v` values inset the numeral from the wall's top and bottom chamfers
 * so its ink never collides with the panel's own edges.
 */
const PANEL = { z0: -1.05, z1: 0.35, v0: 0.2, v1: 0.86 };

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
function segment(b: Builder, rect: Rect, side: -1 | 1, mirror: boolean, colour: Color): void {
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
    const z = MathUtils.lerp(PANEL.z0, PANEL.z1, uz);
    const wall = sponsonWallAt(z, side);
    const t = MathUtils.lerp(PANEL.v0, PANEL.v1, v);
    const y = MathUtils.lerp(wall.yBottom, wall.yTop, t);

    // The wall is close to vertical, so the relief is straight outboard. Inner
    // face a hair proud of the panel so it never z-fights with it; the outer
    // face carries the rest.
    for (const push of [0.002, RELIEF]) {
      b.pos.push(wall.x + push * side, y, z);
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
