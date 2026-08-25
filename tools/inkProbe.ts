/**
 * HEADLESS INK PROBE
 *
 * Requirement 2 of the brief is that every boat, rider, buoy and gate carries
 * an inverted-hull outline of constant screen width. Whether that is actually
 * true of a given part is invisible in a capture until you crop to full
 * resolution and go looking, and it is invisible in the source because the
 * outline is attached by a traversal rather than written out per mesh — a part
 * added to the wrong parent, or one whose bounding box trips the width clamp,
 * silently has no line and nothing says so.
 *
 * The boat's race numbers arrived exactly that way. So this walks a fully built
 * boat and rider and prints, for every mesh, whether it has an ink shell and
 * what that shell is allowed to draw.
 *
 * `uMaxPushWorld` is the interesting column. It caps the push so an ink line
 * can never be wider than a third of its own subject, and it is expressed in
 * metres. Divided by the metres-per-pixel at a representative distance it gives
 * the widest line the part can actually produce; if that is under a pixel the
 * part is uninked in practice however carefully it was configured.
 *
 *   npx tsx tools/inkProbe.ts
 */

import './domShim.ts';
import type { Mesh, ShaderMaterial } from 'three';
import { Boat } from '../src/entities/Boat.ts';
import { Rider } from '../src/entities/Rider.ts';
import { BOAT_SPECS } from '../src/entities/hullSpec.ts';

/**
 * Metres per pixel at the distance a boat is normally judged from.
 *
 * The chase camera sits about 10 m back with a 56-degree vertical field of
 * view, and the retina framebuffer is 1800 px tall. Anything the outline pass
 * is allowed to push less than this is drawing nothing.
 */
const CHASE_DISTANCE = 10;
const FOV_Y = (56 * Math.PI) / 180;
const FRAMEBUFFER_H = 1800;
const M_PER_PX = (2 * CHASE_DISTANCE * Math.tan(FOV_Y / 2)) / FRAMEBUFFER_H;

interface Row {
  name: string;
  inked: boolean;
  widthPx: number;
  maxPushM: number;
  maxPushPx: number;
}

function walk(root: { traverse(cb: (o: unknown) => void): void }, label: string): Row[] {
  const rows: Row[] = [];
  root.traverse((o: unknown) => {
    const m = o as Mesh;
    if (!m.isMesh || m.userData.isOutline) return;
    if (m.userData.noOutline) return;

    const shell = m.children.find((c) => c.userData.isOutline) as Mesh | undefined;
    if (!shell) {
      rows.push({ name: `${label}/${m.name}`, inked: false, widthPx: 0, maxPushM: 0, maxPushPx: 0 });
      return;
    }
    const u = (shell.material as ShaderMaterial).uniforms;
    const maxPushM = u.uMaxPushWorld?.value ?? Infinity;
    rows.push({
      name: `${label}/${m.name}`,
      inked: true,
      widthPx: u.uWidthPx?.value ?? 0,
      maxPushM,
      maxPushPx: maxPushM / M_PER_PX,
    });
  });
  return rows;
}

const boat = new Boat(BOAT_SPECS[0]);
const rider = new Rider(0);
boat.riderMount.add(rider.root);

const rows = [...walk(boat.root, 'boat'), ...walk(rider.root, 'rider')];

console.log('\nINK COVERAGE  (push budget evaluated at 10 m, 1800 px tall framebuffer)');
console.log(`  one pixel = ${(M_PER_PX * 1000).toFixed(2)} mm at that distance\n`);
console.log('  part                              inked  widthPx  maxPush(mm)  maxPush(px)');

const missing: string[] = [];
const starved: string[] = [];

for (const r of rows) {
  if (!r.inked) {
    missing.push(r.name);
    console.log(`  ${r.name.padEnd(33)} NO`);
    continue;
  }
  // The shell can only draw min(widthPx, maxPushPx).
  const effective = Math.min(r.widthPx, r.maxPushPx);
  const flag = effective < 1 ? '  <- starved' : '';
  if (effective < 1) starved.push(r.name);
  console.log(
    `  ${r.name.padEnd(33)} yes    ${r.widthPx.toFixed(1).padStart(5)}    ` +
      `${(r.maxPushM * 1000).toFixed(1).padStart(9)}    ${r.maxPushPx.toFixed(1).padStart(8)}${flag}`,
  );
}

console.log('\nCHECKS');
const check = (name: string, ok: boolean, detail: string) =>
  console.log(`  ${ok ? 'pass' : 'FAIL'}  ${name.padEnd(38)} ${detail}`);
check('every visible part has an ink shell', missing.length === 0,
  missing.length ? missing.join(', ') : `${rows.length} meshes`);
check('no part is clamped below one pixel', starved.length === 0,
  starved.length ? starved.join(', ') : 'all parts can draw their line');
console.log();
