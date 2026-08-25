/**
 * RACE SEQUENCE SHOTS
 *
 * The start, the flag and the results screen — the three moments that make a
 * race a race rather than a driving demo, and the three that had never once
 * been captured.
 *
 * They all run with `setAutopilot: true`, handing the player's boat to the
 * clean AI preset. A scripted throttle-only input cannot reach the finish; it
 * drives straight off the first corner. This is the only way a shot can be
 * defined as "the moment the winner crosses the line".
 *
 *   node tools/capture.mjs --shotfile tools/raceShots.mjs --out shots/race-seq
 */

export const SHOT_GROUPS = { race: 'Countdown, finish, results' };

const AUTO = { setAutopilot: true };

export const SHOTS = [
  {
    id: 'seq-01-countdown-3',
    group: 'race',
    time: 0.6,
    includeHud: true,
    setup: AUTO,
    camera: { mode: 'flyby' },
    description: 'Countdown at 3. Cinematic camera over the grid, HUD sliding in.',
  },
  {
    id: 'seq-02-countdown-1',
    group: 'race',
    time: 2.6,
    includeHud: true,
    setup: AUTO,
    camera: { mode: 'flyby' },
    description: 'Countdown at 1, just before the green.',
  },
  {
    id: 'seq-03-launch',
    group: 'race',
    time: 4.4,
    includeHud: true,
    setup: AUTO,
    camera: { mode: 'chase' },
    description: 'First seconds after GO. Four boats accelerating off the grid.',
  },
  {
    id: 'seq-04-pack-lap1',
    group: 'race',
    time: 40.0,
    includeHud: true,
    setup: AUTO,
    camera: { mode: 'heli' },
    description: 'Mid lap one, the field still together.',
  },
  {
    id: 'seq-05-lap-cross',
    group: 'race',
    time: 88.0,
    includeHud: true,
    setup: AUTO,
    camera: { mode: 'chase' },
    description: 'Around the first lap crossing: lap counter and split delta.',
  },
  {
    id: 'seq-06-final-lap',
    group: 'race',
    time: 200.0,
    includeHud: true,
    setup: AUTO,
    camera: { mode: 'chase' },
    description: 'Lap three, HUD showing 3/3.',
  },
  {
    id: 'seq-07-finish',
    group: 'race',
    time: 258.0,
    includeHud: true,
    setup: AUTO,
    camera: { mode: 'chase' },
    description: 'At or near the flag.',
  },
  {
    id: 'seq-08-results',
    group: 'race',
    time: 272.0,
    includeHud: true,
    setup: AUTO,
    camera: { mode: 'results' },
    description: 'Results screen: placement, totals, best laps, gaps.',
  },
  {
    id: 'seq-09-results-late',
    group: 'race',
    time: 280.0,
    includeHud: true,
    setup: AUTO,
    camera: { mode: 'results' },
    description: 'Results a few seconds later, with the cinematic orbit moving.',
  },
];
