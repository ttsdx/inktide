/**
 * HEADLESS HANDLING PROBE
 *
 * The screenshot harness verifies how the game looks. This verifies how it
 * drives, which no screenshot can show. It runs the real `BoatPhysics` against
 * the real Gerstner wave field at a fixed 1/60 tick and measures the numbers
 * the handling was designed around, so a tuning change that quietly breaks the
 * top speed or makes the hull unstable is caught immediately instead of at the
 * next capture.
 *
 *   npx tsx tools/physicsProbe.ts
 */

import { Vector3 } from 'three';
import { BoatPhysics } from '../src/entities/BoatPhysics.ts';
import { BOAT_SPECS } from '../src/entities/hullSpec.ts';
import { oceanHeight, oceanParams, TOTAL_STEEPNESS, MAX_WAVE_HEIGHT } from '../src/world/gerstner.ts';
import type { BoatCommand } from '../src/contracts.ts';

const DT = 1 / 60;

const cmd = (o: Partial<BoatCommand> = {}): BoatCommand => ({
  throttle: 0,
  brake: 0,
  steer: 0,
  drift: false,
  ...o,
});

function makeBoat(specIndex = 0): BoatPhysics {
  const b = new BoatPhysics(specIndex, BOAT_SPECS[specIndex], new Vector3(0, 0, 0), 0);
  b.respawn(new Vector3(0, 0, 0), 0, 0);
  return b;
}

function run(b: BoatPhysics, c: BoatCommand, seconds: number, t0 = 0): number {
  let t = t0;
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) {
    t += DT;
    b.update(c, { dt: DT, elapsed: t, frame: i }, null);
  }
  return t;
}

const results: Array<[string, string, string]> = [];
const record = (name: string, value: string, target: string) => {
  results.push([name, value, target]);
};

// ---------------------------------------------------------------------------
console.log('\nWAVE FIELD');
console.log(`  total steepness   ${TOTAL_STEEPNESS.toFixed(3)}  (must be < 1.0 or the surface folds)`);
console.log(`  max crest height  ${MAX_WAVE_HEIGHT.toFixed(2)} m`);
console.log(`  amplitude scale   ${oceanParams.amplitude}`);
console.log(`  choppiness        ${oceanParams.choppiness}`);

// Sample the surface over a large area to get the realistic height spread,
// rather than the theoretical maximum which requires every wave to align.
{
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let n = 0;
  for (let x = -400; x <= 400; x += 7) {
    for (let z = -400; z <= 400; z += 7) {
      const h = oceanHeight(x, z, 37.5);
      min = Math.min(min, h);
      max = Math.max(max, h);
      sum += h * h;
      n++;
    }
  }
  const rms = Math.sqrt(sum / n);
  console.log(`  observed range    ${min.toFixed(2)} .. ${max.toFixed(2)} m   (rms ${rms.toFixed(2)})`);
}

// ---------------------------------------------------------------------------
console.log('\nSTABILITY');
{
  // A boat left alone on the water must settle, not oscillate or diverge. This
  // is the single most important check: an unstable buoyancy spring looks like
  // a bug in every other system.
  const b = makeBoat();
  run(b, cmd(), 12);
  const restY = b.position.y;
  const waterY = oceanHeight(b.position.x, b.position.z, 12);
  let maxRate = 0;
  let t = 12;
  for (let i = 0; i < 600; i++) {
    t += DT;
    b.update(cmd(), { dt: DT, elapsed: t, frame: i }, null);
    maxRate = Math.max(maxRate, Math.abs(b.pitch), Math.abs(b.roll));
  }
  const finite = Number.isFinite(b.position.y) && Number.isFinite(b.pitch);
  record('idle: stays finite', finite ? 'yes' : 'NO — DIVERGED', 'yes');
  record('idle: waterline offset', `${(restY - waterY).toFixed(2)} m`, '-0.2 .. +0.4');
  record('idle: peak pitch/roll', `${(maxRate * 57.3).toFixed(1)} deg`, '< 25 deg on open swell');
}

// ---------------------------------------------------------------------------
console.log('\nSPEED');
{
  const b = makeBoat();
  // Time to reach 95% of top speed from rest.
  let t = 0;
  let timeTo95 = -1;
  const target = BOAT_SPECS[0].topSpeed * 0.95;
  for (let i = 0; i < 60 * 20; i++) {
    t += DT;
    b.update(cmd({ throttle: 1 }), { dt: DT, elapsed: t, frame: i }, null);
    if (timeTo95 < 0 && b.forwardSpeed >= target) timeTo95 = t;
  }
  record('top speed (flat out, 20 s)', `${b.forwardSpeed.toFixed(1)} m/s`, `~${BOAT_SPECS[0].topSpeed} m/s`);
  record('0 to 95% top speed', timeTo95 > 0 ? `${timeTo95.toFixed(1)} s` : 'never reached', '4 - 6 s');
}

// ---------------------------------------------------------------------------
console.log('\nTURNING');
for (const drift of [false, true]) {
  const b = makeBoat();
  let t = run(b, cmd({ throttle: 1 }), 8);
  const startHeading = b.heading;
  let turnTime = -1;
  for (let i = 0; i < 60 * 15; i++) {
    t += DT;
    b.update(cmd({ throttle: 1, steer: 1, drift }), { dt: DT, elapsed: t, frame: i }, null);
    if (Math.abs(b.heading - startHeading) >= Math.PI) {
      turnTime = i * DT;
      break;
    }
  }
  record(
    `180 deg turn ${drift ? 'with drift' : 'no drift'}`,
    turnTime > 0 ? `${turnTime.toFixed(1)} s` : 'never completed',
    drift ? 'less than the no-drift figure' : '3.5 - 5.0 s',
  );
  record(`  speed held through turn`, `${b.speed.toFixed(1)} m/s`, 'should not collapse to 0');
}

// ---------------------------------------------------------------------------
console.log('\nDRIFT AND BOOST');
{
  const b = makeBoat();
  let t = run(b, cmd({ throttle: 1 }), 8);
  // Hold a drift for two seconds and see how much charge accrues.
  for (let i = 0; i < 120; i++) {
    t += DT;
    b.update(cmd({ throttle: 1, steer: 1, drift: true }), { dt: DT, elapsed: t, frame: i }, null);
  }
  const charge = b.boostCharge;
  const slipAngle = Math.atan2(b.lateralSpeed, Math.max(b.forwardSpeed, 1)) * 57.3;
  record('drift: charge after 2 s', charge.toFixed(2), '0.6 - 1.0');
  record('drift: slip angle', `${slipAngle.toFixed(1)} deg`, '10 - 35 deg');

  // Release and measure the boost payoff.
  const speedBefore = b.forwardSpeed;
  t += DT;
  b.update(cmd({ throttle: 1, steer: 0, drift: false }), { dt: DT, elapsed: t, frame: 0 }, null);
  const boostDuration = b.boostTime;
  let peak = speedBefore;
  for (let i = 0; i < 180; i++) {
    t += DT;
    b.update(cmd({ throttle: 1 }), { dt: DT, elapsed: t, frame: i }, null);
    peak = Math.max(peak, b.forwardSpeed);
  }
  record('boost: duration', `${boostDuration.toFixed(2)} s`, '0.8 - 2.0 s');
  record('boost: peak speed gain', `+${(peak - speedBefore).toFixed(1)} m/s`, '+4 m/s or more');
}

// ---------------------------------------------------------------------------
console.log('\nAIRTIME');
{
  // Drive across the swell (perpendicular to the dominant wave direction, which
  // travels along roughly (0.955, 0.296)) and measure the jumps.
  const heading = Math.atan2(-0.296, 0.955) + Math.PI / 2;
  const b = new BoatPhysics(0, BOAT_SPECS[0], new Vector3(0, 0, 0), heading);
  b.respawn(new Vector3(0, 0, 0), heading, 0);
  let t = run(b, cmd({ throttle: 1 }), 6);

  let jumps = 0;
  let longestAir = 0;
  let highestAir = 0;
  let currentAir = 0;
  let peakHeight = 0;
  let wasAir = false;
  let maxLanding = 0;

  for (let i = 0; i < 60 * 60; i++) {
    t += DT;
    b.update(cmd({ throttle: 1 }), { dt: DT, elapsed: t, frame: i }, null);
    const above = b.position.y - oceanHeight(b.position.x, b.position.z, t);
    if (b.airborne) {
      currentAir += DT;
      peakHeight = Math.max(peakHeight, above);
      wasAir = true;
    } else if (wasAir) {
      if (currentAir > 0.25) {
        jumps++;
        longestAir = Math.max(longestAir, currentAir);
        highestAir = Math.max(highestAir, peakHeight);
      }
      currentAir = 0;
      peakHeight = 0;
      wasAir = false;
      maxLanding = Math.max(maxLanding, b.landingImpact);
    }
  }
  record('airtime: jumps in 60 s', String(jumps), 'several — the swell should launch you');
  record('airtime: longest hang', `${longestAir.toFixed(2)} s`, '0.6 - 1.4 s');
  record('airtime: peak height', `${highestAir.toFixed(2)} m`, '1.5 - 3.5 m');
  record('airtime: hardest landing', `${maxLanding.toFixed(1)} m/s`, 'nonzero, drives shake + spray');
}

// ---------------------------------------------------------------------------
console.log('\nPER-BOAT SPECS');
for (let i = 0; i < BOAT_SPECS.length; i++) {
  const b = makeBoat(i);
  run(b, cmd({ throttle: 1 }), 18);
  const top = b.forwardSpeed;
  const startHeading = b.heading;
  let t = 18;
  let turnTime = -1;
  for (let s = 0; s < 60 * 12; s++) {
    t += DT;
    b.update(cmd({ throttle: 1, steer: 1 }), { dt: DT, elapsed: t, frame: s }, null);
    if (Math.abs(b.heading - startHeading) >= Math.PI) {
      turnTime = s * DT;
      break;
    }
  }
  console.log(
    `  ${BOAT_SPECS[i].name.padEnd(14)} top ${top.toFixed(1)} m/s   ` +
      `180deg ${turnTime > 0 ? turnTime.toFixed(1) + ' s' : '  -  '}   ` +
      `slidiness ${BOAT_SPECS[i].slidiness}`,
  );
}

// ---------------------------------------------------------------------------
console.log('\nCOLLISION');
{
  const a = new BoatPhysics(0, BOAT_SPECS[0], new Vector3(0, 0, 0), 0);
  const b2 = new BoatPhysics(1, BOAT_SPECS[1], new Vector3(1.2, 0, 0), 0);
  a.respawn(new Vector3(0, 0, 0), 0, 0);
  b2.respawn(new Vector3(1.2, 0, 0), 0, 0);
  a.velocity.set(6, 0, 0);
  a.resolveBoatCollision(b2);
  const sep = Math.hypot(b2.position.x - a.position.x, b2.position.z - a.position.z);
  record('collision: separated', sep.toFixed(2) + ' m', '>= 3.10 m (2 x hull radius)');
  record('collision: impulse recorded', a.collisionImpact.toFixed(2), '> 0');
}

// ---------------------------------------------------------------------------
console.log('\nRESULTS');
const w = Math.max(...results.map((r) => r[0].length));
for (const [name, value, target] of results) {
  console.log(`  ${name.padEnd(w)}  ${value.padEnd(22)} target: ${target}`);
}
console.log('');
