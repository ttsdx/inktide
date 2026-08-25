/**
 * COURSE PROBE
 *
 * Checks the circuit's geometry the way a track designer would: how long a lap
 * is, whether the corners have a range of radii rather than all being the same
 * bend, whether the checkpoints are evenly spread, and — the one that is easy
 * to get wrong and impossible to see in a screenshot — whether the "airtime"
 * straight really does run across the swell rather than along it.
 *
 *   npx tsx tools/courseProbe.ts
 */

import { Vector3 } from 'three';
import { Course, SWELL_DIR_X, SWELL_DIR_Z, ACROSS_SWELL_X, ACROSS_SWELL_Z } from '../src/race/Course.ts';
import { WAVES } from '../src/world/gerstner.ts';

const course = new Course();

console.log('\nCIRCUIT');
console.log(`  lap length        ${course.length.toFixed(0)} m`);
console.log(`  lap time at 33 m/s ${(course.length / 33).toFixed(0)} s`);
console.log(`  checkpoints       ${course.checkpoints.length}`);
console.log(`  start slots       ${course.startGrid.length}`);

console.log('\nSECTIONS');
for (const s of course.sections) {
  const detail =
    s.kind === 'arc'
      ? `radius ${s.radius.toFixed(0)} m, sweep ${s.sweepDeg.toFixed(0)} deg`
      : `${s.length.toFixed(0)} m straight`;
  console.log(`  ${s.name.padEnd(20)} ${s.kind.padEnd(9)} ${detail.padEnd(30)} half-width ${s.halfWidth.toFixed(0)} m`);
}

// ---------------------------------------------------------------------------
console.log('\nSWELL ALIGNMENT');
const swellWavelength = WAVES[0].wavelength;
console.log(`  primary swell dir  (${SWELL_DIR_X.toFixed(3)}, ${SWELL_DIR_Z.toFixed(3)}), wavelength ${swellWavelength} m`);
console.log(`  across-swell dir   (${ACROSS_SWELL_X.toFixed(3)}, ${ACROSS_SWELL_Z.toFixed(3)})`);

{
  // For every section, measure the mean |dot(tangent, swellDir)|. A value near
  // 1 means the section runs ALONG the swell (a smooth ride, the boat surfs one
  // wave); near 0 means it runs ACROSS it, hitting crests square on, which is
  // where the airtime comes from.
  const rows: Array<[string, number]> = [];
  for (const s of course.sections) {
    let sum = 0;
    let n = 0;
    for (let i = 0; i <= 24; i++) {
      const t = s.t0 + ((s.t1 - s.t0) * i) / 24;
      const p = course.sample(Course.wrap(t));
      sum += Math.abs(p.tangent.x * SWELL_DIR_X + p.tangent.z * SWELL_DIR_Z);
      n++;
    }
    rows.push([s.name, sum / n]);
  }
  rows.sort((a, b) => a[1] - b[1]);
  for (const [name, v] of rows) {
    const bar = '#'.repeat(Math.round(v * 30));
    const label = v < 0.35 ? 'ACROSS swell (airtime)' : v > 0.75 ? 'along swell (smooth)' : 'oblique';
    console.log(`  ${name.padEnd(20)} ${v.toFixed(2)} ${bar.padEnd(30)} ${label}`);
  }

  const airtime = course.airtimeSection;
  const airtimeAlign = rows.find((r) => r[0] === airtime.name)?.[1] ?? 1;
  console.log(
    `\n  designated airtime section: "${airtime.name}" alignment ${airtimeAlign.toFixed(2)} ` +
      `-> ${airtimeAlign < 0.35 ? 'CORRECT, runs across the swell' : 'WRONG, does not run across the swell'}`,
  );
  // How many crests will a boat cross along it?
  const crossings = (airtime.length * Math.sqrt(1 - airtimeAlign * airtimeAlign)) / swellWavelength;
  console.log(`  crests crossed along it: ~${crossings.toFixed(1)}`);
}

// ---------------------------------------------------------------------------
console.log('\nCURVATURE');
{
  const N = 600;
  let minR = Infinity;
  let maxK = 0;
  const buckets = { flatOut: 0, easy: 0, medium: 0, hard: 0 };
  for (let i = 0; i < N; i++) {
    const p = course.sample(i / N);
    const k = p.curvature;
    maxK = Math.max(maxK, k);
    if (k > 1e-6) minR = Math.min(minR, 1 / k);
    if (k < 0.002) buckets.flatOut++;
    else if (k < 0.006) buckets.easy++;
    else if (k < 0.014) buckets.medium++;
    else buckets.hard++;
  }
  console.log(`  tightest radius   ${minR.toFixed(0)} m`);
  console.log(`  max curvature     ${maxK.toFixed(5)} 1/m`);
  const pct = (n: number) => `${((n / N) * 100).toFixed(0)}%`;
  console.log(
    `  distribution      flat-out ${pct(buckets.flatOut)}  easy ${pct(buckets.easy)}  ` +
      `medium ${pct(buckets.medium)}  hard ${pct(buckets.hard)}`,
  );
  // A circuit where every corner is the same is boring. We want a real spread.
  const kinds = Object.values(buckets).filter((v) => v / N > 0.05).length;
  console.log(`  variety           ${kinds} of 4 difficulty bands are meaningfully present`);
}

// ---------------------------------------------------------------------------
console.log('\nCHECKPOINT SPACING');
{
  const gaps: number[] = [];
  for (let i = 0; i < course.checkpoints.length; i++) {
    const a = course.checkpoints[i].t;
    const b = course.checkpoints[(i + 1) % course.checkpoints.length].t;
    gaps.push(Course.wrapDelta(b, a) * course.length);
  }
  const min = Math.min(...gaps);
  const max = Math.max(...gaps);
  console.log(`  gate spacing      ${min.toFixed(0)} m .. ${max.toFixed(0)} m`);
  console.log(`  start/finish idx  ${course.startFinishIndex}`);
}

// ---------------------------------------------------------------------------
console.log('\nPROJECTION');
{
  // closestT has to be both correct and cheap; it is called for every racer
  // every frame. Verify it round-trips and time it.
  let worst = 0;
  for (let i = 0; i < 200; i++) {
    const t = i / 200;
    const p = course.sample(t);
    const off = p.position.clone().addScaledVector(p.normal, (Math.random() - 0.5) * 30);
    const back = course.closestT(off, t);
    worst = Math.max(worst, Math.abs(Course.wrapDelta(back, t)) * course.length);
  }
  console.log(`  worst reprojection error ${worst.toFixed(1)} m`);

  const probe = new Vector3();
  const t0 = performance.now();
  let hint = 0;
  for (let i = 0; i < 100000; i++) {
    probe.set(Math.sin(i) * 400, 0, Math.cos(i * 0.7) * 400);
    hint = course.closestT(probe, hint);
  }
  const ms = performance.now() - t0;
  console.log(`  100k projections in ${ms.toFixed(0)} ms (${((ms / 100000) * 1000).toFixed(2)} us each)`);
}

// ---------------------------------------------------------------------------
console.log('\nSTART GRID');
for (let i = 0; i < course.startGrid.length; i++) {
  const s = course.startGrid[i];
  console.log(
    `  slot ${i}  (${s.position.x.toFixed(1)}, ${s.position.z.toFixed(1)})  heading ${((s.heading * 180) / Math.PI).toFixed(0)} deg`,
  );
}
console.log('');
