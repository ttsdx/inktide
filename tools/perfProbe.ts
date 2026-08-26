/**
 * SCENE COST PROBE
 *
 * A headless accounting of what the frame is made of, without needing a GPU.
 * It answers the questions a profiler would on real hardware but that a
 * software rasteriser on a shared four-core box cannot: how many draw calls
 * each subsystem contributes, how many of those are ink shells, and where the
 * triangle budget actually goes.
 *
 * This deliberately does NOT try to measure frame time. Timings taken under
 * SwiftShader would be meaningless and acting on them would be worse than
 * having no numbers at all.
 *
 *   npx tsx tools/perfProbe.ts
 */

import { Course } from '../src/race/Course.ts';
import {
  buildHullGeometry,
  buildDeckGeometry,
  buildCowlingGeometry,
  buildSponsonGeometry,
  buildEngineGeometry,
  buildIntakeGlowGeometry,
  buildFinGeometry,
  buildRudderGeometry,
  buildHandlebarGeometry,
} from '../src/entities/boatGeometry.ts';
import type { BufferGeometry } from 'three';

const tris = (g: BufferGeometry): number => {
  const idx = g.getIndex();
  return idx ? idx.count / 3 : g.getAttribute('position').count / 3;
};

console.log('\nBOAT GEOMETRY');
const parts: Array<[string, BufferGeometry]> = [
  ['hull', buildHullGeometry()],
  ['deck', buildDeckGeometry()],
  ['cowling', buildCowlingGeometry()],
  ['sponson L', buildSponsonGeometry(-1)],
  ['sponson R', buildSponsonGeometry(1)],
  ['engine', buildEngineGeometry()],
  ['intake glow', buildIntakeGlowGeometry()],
  ['fin', buildFinGeometry()],
  ['rudder', buildRudderGeometry()],
  ['handlebar', buildHandlebarGeometry()],
];
let boatTris = 0;
for (const [name, g] of parts) {
  const t = tris(g);
  boatTris += t;
  console.log(`  ${name.padEnd(14)} ${String(t).padStart(5)} tris   ${g.getAttribute('position').count} verts`);
}
console.log(`  ${'TOTAL'.padEnd(14)} ${String(boatTris).padStart(5)} tris per boat`);
console.log(`  x4 boats, x2 for ink shells = ${boatTris * 8} triangles of boat per frame`);
console.log(`  draw calls: ${parts.length} parts x 2 (mesh + ink) x 4 boats = ${parts.length * 8}`);

console.log('\nOCEAN DISC');
{
  const discs = [
    ['low', 128, 48],
    ['medium', 192, 72],
    ['high', 256, 100],
    ['ultra', 384, 132],
  ];
  for (const [tier, segments, rings] of discs) {
    const verts = 1 + rings * segments + segments;
    const indices = segments * 3 + (rings - 1) * segments * 6 + segments * 6;
    console.log(
      `  ${String(tier).padEnd(8)}  ${segments}×${rings}   ${(indices / 3).toLocaleString()} tris, ${verts.toLocaleString()} verts`,
    );
  }
  console.log('  ultra is the authored density. Lower tiers rebuild the same');
  console.log('  exponential disc with fewer rings — same function, coarser sample.');
}

console.log('\nCOURSE FURNITURE');
{
  const course = new Course();
  console.log(`  gates            ${course.checkpoints.length} gates`);
  console.log(`  Gates are the largest draw-call contributor by count. Only one or`);
  console.log(`  two are ever in frame, so this rests entirely on frustum culling`);
  console.log(`  doing its job — verify with the in-page draw-call counter, not here.`);
}

console.log('\nWHERE THE FRAME COST ACTUALLY IS');
console.log(`
  Measured in-page at 600x400, high tier, mid-race: 269 draw calls,
  196k triangles, 418 meshes in the scene of which 184 are ink shells.

  Draw calls break down as:
    gates          156 meshes (12 gates x 13 parts)
    boats + riders 252 meshes (4 x 63, of which 44 per boat is the rider)
    everything else 10

  269 draw calls is not a problem on real hardware — a modern GPU issues
  thousands without noticing. Chasing it would be optimising the wrong thing.
  The real risks, in order, are all fill-rate:

    1. The ocean fragment shader. Long, covering most of the screen at retina.
       Low tier compiles the glitter lattice out and rebuilds a coarser disc.
    2. Four full-screen post passes at framebuffer resolution. Shed by tier.
    3. WakeField: ping-pong target, 256² on low through 1024² on ultra.

  The levers, in the order the adaptive controller pulls them: pixel ratio,
  then MSAA, then interior lines, then bloom. Ocean density, wake resolution
  and spray count move on the same callback — they used to exist as knobs
  that were never turned.
`);
