/**
 * SEA STATE SWEEP
 *
 * How big should the swell be?
 *
 * The water was tuned for how it looks; the physics was tuned for how it
 * drives. Those two pull in opposite directions and the disagreement only shows
 * up in telemetry: at the amplitude the water shader was authored for, a full
 * race had the boats airborne 40-47% of the time, which is not "exciting" but
 * "the controls do nothing half the time".
 *
 * This sweeps the global amplitude and reports both sides of the trade — the
 * wave height a player sees, and the fraction of the race spent out of the
 * water — so the choice is made on numbers instead of taste.
 *
 *   npx tsx tools/seaStateSweep.ts
 */

import { Vector3 } from 'three';
import { BoatPhysics } from '../src/entities/BoatPhysics.ts';
import { BOAT_SPECS } from '../src/entities/hullSpec.ts';
import { oceanHeight, oceanParams } from '../src/world/gerstner.ts';
import { ACROSS_SWELL_X, ACROSS_SWELL_Z, SWELL_DIR_X, SWELL_DIR_Z } from '../src/race/Course.ts';
import type { BoatCommand } from '../src/contracts.ts';

const DT = 1 / 60;
const cmd: BoatCommand = { throttle: 1, brake: 0, steer: 0, drift: false };

/** Drive in a straight line on the given heading and gather airtime stats. */
function driveStraight(headingX: number, headingZ: number, seconds: number) {
  const heading = Math.atan2(headingX, headingZ);
  const b = new BoatPhysics(0, BOAT_SPECS[0], new Vector3(0, 0, 0), heading);
  b.respawn(new Vector3(0, 0, 0), heading, 0);

  let t = 0;
  // Let it get up to speed first; the launch phase is not representative.
  for (let i = 0; i < 60 * 8; i++) {
    t += DT;
    b.update(cmd, { dt: DT, elapsed: t, frame: i }, null);
  }

  let air = 0;
  let n = 0;
  let jumps = 0;
  let wasAir = false;
  let peak = 0;
  let curPeak = 0;
  let curLen = 0;
  let longest = 0;
  let hardest = 0;
  let speedSum = 0;

  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) {
    t += DT;
    b.update(cmd, { dt: DT, elapsed: t, frame: i }, null);
    n++;
    speedSum += b.speed;
    const above = b.position.y - oceanHeight(b.position.x, b.position.z, t);
    if (b.airborne) {
      air++;
      curLen += DT;
      curPeak = Math.max(curPeak, above);
      wasAir = true;
    } else if (wasAir) {
      if (curLen > 0.2) {
        jumps++;
        longest = Math.max(longest, curLen);
        peak = Math.max(peak, curPeak);
      }
      curLen = 0;
      curPeak = 0;
      wasAir = false;
      hardest = Math.max(hardest, b.landingImpact);
    }
  }
  return {
    airFrac: air / Math.max(n, 1),
    jumpsPerMin: (jumps / seconds) * 60,
    longest,
    peak,
    hardest,
    meanSpeed: speedSum / Math.max(n, 1),
  };
}

function seaStats(amp: number) {
  const prev = oceanParams.amplitude;
  oceanParams.amplitude = amp;
  let min = Infinity;
  let max = -Infinity;
  let sq = 0;
  let n = 0;
  for (let x = -500; x <= 500; x += 9) {
    for (let z = -500; z <= 500; z += 9) {
      const h = oceanHeight(x, z, 51.3);
      min = Math.min(min, h);
      max = Math.max(max, h);
      sq += h * h;
      n++;
    }
  }
  oceanParams.amplitude = prev;
  // Significant wave height, the standard descriptor: 4x the rms of surface
  // elevation. It is what a sailor would call "the sea state".
  return { min, max, hs: 4 * Math.sqrt(sq / n) };
}

console.log('\nSEA STATE SWEEP');
console.log(
  '  amp    Hs     range          | across-swell            | along-swell',
);
console.log(
  '                               | air%  jumps/min  peak   | air%  jumps/min  peak',
);

const original = oceanParams.amplitude;
for (const amp of [0.4, 0.5, 0.6, 0.7, 0.8, 0.92]) {
  oceanParams.amplitude = amp;
  const sea = seaStats(amp);
  const across = driveStraight(ACROSS_SWELL_X, ACROSS_SWELL_Z, 60);
  const along = driveStraight(SWELL_DIR_X, SWELL_DIR_Z, 60);
  console.log(
    `  ${amp.toFixed(2)}  ${sea.hs.toFixed(2)}m  ${sea.min.toFixed(1)}..${sea.max.toFixed(1)}m` +
      `   | ${(across.airFrac * 100).toFixed(0).padStart(3)}%  ${across.jumpsPerMin.toFixed(0).padStart(6)}    ${across.peak.toFixed(1)}m` +
      `  | ${(along.airFrac * 100).toFixed(0).padStart(3)}%  ${along.jumpsPerMin.toFixed(0).padStart(6)}    ${along.peak.toFixed(1)}m`,
  );
}
oceanParams.amplitude = original;

console.log(`
  Reading this table: the airtime straight should launch the boat, so a few
  jumps a minute with a 1.5-3 m peak is the goal there. The along-swell straight
  is the contrast section and should be nearly glued down — if its air% is high,
  the sea is too big for the whole course rather than just the fun part of it.
`);
