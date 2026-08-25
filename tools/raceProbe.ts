/**
 * HEADLESS RACE PROBE
 *
 * The AI and the race director were developed against their own assumptions
 * about how a boat moves; the physics was developed against its own assumptions
 * about what would be asked of it. This runs the real AI, the real director and
 * the real physics together over a full three-lap race and checks that the
 * combination actually works — that the opponents can complete laps at all, that
 * they take different lines, that the field stays close, and that they make
 * visible mistakes.
 *
 * None of this needs a GPU, and none of it is visible in a screenshot.
 *
 *   npx tsx tools/raceProbe.ts
 */

import { Vector3 } from 'three';
import { Course } from '../src/race/Course.ts';
import { RaceDirector, type RaceEvent } from '../src/race/RaceDirector.ts';
import { AIController, AI_PRESETS } from '../src/race/AIController.ts';
import { BoatPhysics } from '../src/entities/BoatPhysics.ts';
import { BOAT_SPECS } from '../src/entities/hullSpec.ts';
import type { BoatCommand, BoatState } from '../src/contracts.ts';

const DT = 1 / 60;
const MAX_SECONDS = 60 * 8;

const course = new Course();
const director = new RaceDirector(course, 4);

const boats: BoatPhysics[] = [];
const ais: Array<AIController | null> = [];
for (let i = 0; i < 4; i++) {
  const slot = course.startGrid[i];
  const b = new BoatPhysics(i, BOAT_SPECS[i], slot.position.clone(), slot.heading);
  b.respawn(slot.position.clone(), slot.heading, 0);
  boats.push(b);
  ais.push(i === 0 ? null : new AIController(i, course, AI_PRESETS[i % AI_PRESETS.length]));
}

// The "player" is driven by the clean AI preset so the race is a fair four-way
// comparison rather than three boats racing an idle hull.
const playerAI = new AIController(0, course, AI_PRESETS[0]);

const events: RaceEvent[] = [];
director.onEvent = (e) => events.push(e);
director.start();

const states: BoatState[] = boats;
const idleCmd: BoatCommand = { throttle: 0, brake: 0, steer: 0, drift: false };

// Telemetry
const lateralSamples: number[][] = [[], [], [], []];
const speedSamples: number[][] = [[], [], [], []];
let offCourseFrames = [0, 0, 0, 0];
let airborneFrames = [0, 0, 0, 0];
let driftFrames = [0, 0, 0, 0];
let boostFrames = [0, 0, 0, 0];
let maxLateral = [0, 0, 0, 0];

let t = 0;
let frame = 0;
let finishedAt = -1;

while (t < MAX_SECONDS) {
  t += DT;
  frame++;
  const ctx = { dt: DT, elapsed: t, frame };
  const phase = director.phase;
  const launched = phase === 'racing' || phase === 'finished' || phase === 'results';

  for (let i = 0; i < 4; i++) {
    const ai = i === 0 ? playerAI : ais[i];
    let cmd = idleCmd;
    if (ai) {
      const prog = director.get(i);
      const playerProg = director.get(0);
      if (prog && playerProg) cmd = ai.update(boats[i], states, prog, playerProg, ctx);
    }
    const applied: BoatCommand = launched
      ? cmd
      : { throttle: 0, brake: 0, steer: cmd.steer, drift: false };
    boats[i].update(applied, ctx, null);
  }

  for (let a = 0; a < 4; a++) {
    for (let b = a + 1; b < 4; b++) boats[a].resolveBoatCollision(boats[b]);
  }

  director.update(states, ctx);

  if (launched) {
    for (let i = 0; i < 4; i++) {
      const lat = director.lateralOffset(boats[i]);
      lateralSamples[i].push(lat);
      maxLateral[i] = Math.max(maxLateral[i], Math.abs(lat));
      speedSamples[i].push(boats[i].speed);
      if (director.offCourse(boats[i])) offCourseFrames[i]++;
      if (boats[i].airborne) airborneFrames[i]++;
      if (boats[i].driftAmount > 0.3) driftFrames[i]++;
      if (boats[i].boostTime > 0) boostFrames[i]++;
    }
  }

  if (director.phase === 'results' && finishedAt < 0) finishedAt = t;
  if (finishedAt > 0 && t > finishedAt + 1) break;
}

// ---------------------------------------------------------------------------

const fmt = (s: number) => {
  if (!Number.isFinite(s) || s <= 0) return '   --   ';
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r.toFixed(2).padStart(5, '0')}`;
};
const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const rms = (a: number[]) => (a.length ? Math.sqrt(mean(a.map((v) => v * v))) : 0);

console.log(`\nRACE — ${course.length.toFixed(0)} m x ${director.laps} laps, simulated ${t.toFixed(0)} s`);
console.log(`  final phase: ${director.phase}`);

console.log('\nRESULTS');
const standings = director.standings();
for (const p of standings) {
  const spec = BOAT_SPECS[p.boatId];
  const best = director.bestLap(p.boatId);
  const laps = p.lapTimes.map((l) => fmt(l)).join('  ');
  console.log(
    `  ${String(p.finishPosition || '-').padStart(2)}  ${spec.name.padEnd(14)} ` +
      `total ${fmt(p.totalTime)}  best ${fmt(best)}  laps [${laps}]  ` +
      `${p.finished ? '' : `DNF (lap ${p.lap}, ${(p.lapProgress * 100).toFixed(0)}%)`}`,
  );
}

const finishers = standings.filter((p) => p.finished);
console.log(`\n  finishers: ${finishers.length}/4`);
if (finishers.length >= 2) {
  const spread = finishers[finishers.length - 1].totalTime - finishers[0].totalTime;
  console.log(`  1st-to-last spread: ${spread.toFixed(1)} s over ${director.laps} laps`);
  console.log(
    `  winning margin:     ${(finishers[1].totalTime - finishers[0].totalTime).toFixed(2)} s`,
  );
}

console.log('\nPER-RACER BEHAVIOUR');
console.log(
  '  boat            preset       mean spd  max lat  off-course  airborne  drifting  boosting',
);
for (let i = 0; i < 4; i++) {
  const preset = i === 0 ? 'player' : AI_PRESETS[i % AI_PRESETS.length].name;
  const n = Math.max(1, speedSamples[i].length);
  const pct = (v: number) => `${((v / n) * 100).toFixed(0)}%`.padStart(6);
  console.log(
    `  ${BOAT_SPECS[i].name.padEnd(14)}  ${preset.padEnd(12)} ` +
      `${mean(speedSamples[i]).toFixed(1).padStart(7)}  ` +
      `${maxLateral[i].toFixed(1).padStart(6)}  ` +
      `${pct(offCourseFrames[i])}      ${pct(airborneFrames[i])}    ${pct(driftFrames[i])}    ${pct(boostFrames[i])}`,
  );
}

console.log('\nLINE VARIETY  (rms lateral offset from the centreline, metres)');
for (let i = 0; i < 4; i++) {
  const r = rms(lateralSamples[i]);
  console.log(`  ${BOAT_SPECS[i].name.padEnd(14)} ${r.toFixed(2)}  ${'#'.repeat(Math.round(r * 3))}`);
}

// Mean pairwise separation of the lines: if this is near zero the four boats
// are driving the same racing line and the pack will look like a train.
{
  let sum = 0;
  let n = 0;
  const len = Math.min(...lateralSamples.map((a) => a.length));
  for (let k = 0; k < len; k += 10) {
    for (let a = 0; a < 4; a++) {
      for (let b = a + 1; b < 4; b++) {
        sum += Math.abs(lateralSamples[a][k] - lateralSamples[b][k]);
        n++;
      }
    }
  }
  console.log(`  mean pairwise line separation: ${(sum / Math.max(n, 1)).toFixed(2)} m`);
}

console.log('\nEVENTS');
const counts = new Map<string, number>();
for (const e of events) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
for (const [k, v] of [...counts].sort()) console.log(`  ${k.padEnd(12)} ${v}`);

const wrongWay = events.filter((e) => e.type === 'wrongWay');
console.log(`  wrong-way events: ${wrongWay.length}`);

console.log('\nLEAD CHANGES');
{
  let leader = -1;
  let changes = 0;
  const order: string[] = [];
  for (const e of events) {
    if (e.type === 'gate' && e.boatId >= 0) {
      const lead = director.standings()[0];
      if (lead && lead.boatId !== leader) {
        leader = lead.boatId;
        changes++;
        order.push(BOAT_SPECS[leader].name);
      }
    }
  }
  console.log(`  ${changes} recorded (final leader ${BOAT_SPECS[standings[0]?.boatId ?? 0].name})`);
}
console.log('');
