/**
 * BOAT SHOTS
 *
 * Orthographic-ish product angles on the hull. The point of these is to judge
 * the *form*: whether the bow is sharp, whether the chine reads as a hard
 * terminator down the length of the hull, whether the sponsons register in
 * silhouette, and whether the whole thing looks like a racing craft rather
 * than a box.
 *
 *   node tools/capture.mjs --shotfile tools/boatShots.mjs --out shots/boat-01
 */

export const SHOT_GROUPS = { boat: 'Hull form, livery and ink' };

const boat = (yaw, pitch, distance, lookHeight = 0.9) => ({
  mode: 'boat',
  index: 0,
  yaw,
  pitch,
  distance,
  lookHeight,
});

const CRUISE = { throttle: 1, steer: 0 };

export const SHOTS = [
  {
    id: 'boat-01-bow',
    group: 'boat',
    time: 10.0,
    input: CRUISE,
    camera: boat(0, 0.14, 9, 0.8),
    description: 'Dead ahead. Bow sharpness, beam, sponson spread.',
  },
  {
    id: 'boat-02-side',
    group: 'boat',
    time: 12.0,
    input: CRUISE,
    camera: boat(Math.PI / 2, 0.08, 10, 0.7),
    description: 'Profile. Sheer line, keel rocker, the chine as a hard edge.',
  },
  {
    id: 'boat-03-front-quarter',
    group: 'boat',
    time: 14.0,
    input: CRUISE,
    camera: boat(0.9, 0.20, 9, 0.8),
    description: 'Front three-quarter. The angle a store page would use.',
  },
  {
    id: 'boat-04-rear-quarter',
    group: 'boat',
    time: 16.0,
    input: CRUISE,
    camera: boat(2.3, 0.18, 9, 0.8),
    description: 'Rear three-quarter. Engine, transom, wake, rooster tail.',
  },
  {
    id: 'boat-05-top',
    group: 'boat',
    time: 18.0,
    input: CRUISE,
    camera: boat(0.5, 1.15, 12, 0.4),
    description: 'From above. Deck layout, cockpit well, livery placement.',
  },
  {
    id: 'boat-06-low-hero',
    group: 'boat',
    time: 20.0,
    input: CRUISE,
    camera: boat(1.2, -0.05, 7, 1.0),
    description: 'Low and close, near the waterline. The heroic angle.',
  },
];
