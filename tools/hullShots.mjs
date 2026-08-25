/**
 * HULL WATERLINE SHOTS.
 *
 * Does the boat sit IN the water, and is there anything at the join?
 *
 * The hull is authored with its origin on the design waterline and 46 cm of
 * draft below that, and the idle physics probe puts the origin 8 cm proud, so
 * at rest roughly 38 cm of keel should be under the surface. At speed the hull
 * planes and rises, which is correct for a planing boat and is also exactly
 * when it starts to read as hovering — so both states have to be looked at, and
 * looked at from water level. Every existing shot views the boat from above,
 * where a hull resting on the surface and a hull cut by it are the same picture.
 *
 * The idle frame comes first so the harness never has to seek backwards into it
 * with the throttle already open.
 */

export const SHOT_GROUPS = {
  idle: 'Boat at rest, where the waterline must be unambiguous',
  planing: 'Boat at speed, where it rises and needs foam to stay connected',
};

const boat = (yaw, pitch, distance, lookHeight) => ({
  mode: 'boat',
  index: 0,
  yaw,
  pitch,
  distance,
  lookHeight,
});

const IDLE = { throttle: 0, steer: 0 };
const CRUISE = { throttle: 1, steer: 0 };
const SLIDE = { throttle: 1, steer: 1, drift: true };

export const SHOTS = [
  {
    id: 'hull-idle-side',
    group: 'idle',
    time: 5.0,
    input: IDLE,
    camera: boat(Math.PI / 2, 0.02, 5.2, 0.15),
    description: 'At rest, side on, at water level. 38 cm of keel should be gone.',
  },
  {
    id: 'hull-idle-quarter',
    group: 'idle',
    time: 8.0,
    input: IDLE,
    camera: boat(2.3, 0.03, 4.4, 0.2),
    description: 'At rest, three-quarter. The waterline should curve round the bow.',
  },
  {
    id: 'hull-cruise-side',
    group: 'planing',
    time: 16.0,
    input: CRUISE,
    camera: boat(Math.PI / 2, 0.02, 5.2, 0.2),
    description: 'Planing, side on. How far has it risen, and is it still connected?',
  },
  {
    id: 'hull-cruise-quarter',
    group: 'planing',
    time: 20.0,
    input: CRUISE,
    camera: boat(2.3, 0.04, 4.2, 0.25),
    description: 'Planing, three-quarter, close. Bow wave and contact foam.',
  },
  {
    id: 'hull-slide-low',
    group: 'planing',
    time: 26.0,
    input: SLIDE,
    camera: boat(1.7, 0.02, 5.0, 0.25),
    description: 'Mid-drift at water level. The loaded chine should be buried.',
  },
];
