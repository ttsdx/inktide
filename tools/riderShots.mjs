/**
 * RIDER SHOTS
 *
 * The rider was built and numerically verified — wrist-to-handlebar error,
 * head counter-roll fraction, crouch spring overshoot — but never looked at.
 * These angles exist to close that gap: they frame the character large enough
 * in frame to judge silhouette, proportion, ink weight and whether the pose
 * reads as a person driving rather than a prop bolted to a deck.
 *
 *   node tools/capture.mjs --shotfile tools/riderShots.mjs --out shots/rider-01
 */

export const SHOT_GROUPS = { rider: 'Character rig, proportions and animation' };

/** Framed relative to the boat's heading: yaw, pitch, distance, look height. */
const boat = (yaw, pitch, distance, lookHeight = 1.1) => ({
  mode: 'boat',
  index: 0,
  yaw,
  pitch,
  distance,
  lookHeight,
});

const HOLD = { throttle: 1, steer: 0 };
const TURN = { throttle: 1, steer: 1, drift: true };
const BRAKE = { throttle: 0, brake: 1, steer: 0 };

export const SHOTS = [
  {
    id: 'rider-01-three-quarter',
    group: 'rider',
    time: 9.0,
    input: HOLD,
    camera: boat(2.5, 0.16, 4.2, 1.25),
    description: 'Standard three-quarter. Silhouette, proportions, ink weight.',
  },
  {
    id: 'rider-02-profile',
    group: 'rider',
    time: 11.0,
    input: HOLD,
    camera: boat(Math.PI / 2, 0.10, 4.0, 1.2),
    description: 'Dead side-on. Torso pitch, elbow bend, hands on the bars.',
  },
  {
    id: 'rider-03-front',
    group: 'rider',
    time: 13.0,
    input: HOLD,
    camera: boat(0, 0.12, 4.4, 1.25),
    description: 'Head on. Shoulder line, helmet shape, visor read.',
  },
  {
    id: 'rider-04-lean-into-turn',
    group: 'rider',
    time: 17.0,
    input: TURN,
    camera: boat(2.2, 0.14, 4.6, 1.2),
    description: 'Hard left drift. Spine roll, head counter-roll, arm asymmetry.',
  },
  {
    id: 'rider-05-lean-from-front',
    group: 'rider',
    time: 20.0,
    input: TURN,
    camera: boat(0.15, 0.10, 4.8, 1.2),
    description: 'The lean seen head on, where a stiff rig is most obvious.',
  },
  {
    id: 'rider-06-braking',
    group: 'rider',
    time: 24.0,
    input: BRAKE,
    camera: boat(Math.PI / 2.2, 0.12, 4.2, 1.15),
    description: 'Weight thrown forward over the bars, elbows closed.',
  },
  {
    id: 'rider-07-close-helmet',
    group: 'rider',
    time: 27.0,
    input: HOLD,
    camera: boat(2.6, 0.05, 2.4, 1.45),
    description: 'Tight on the helmet. Facet density and outline weight up close.',
  },
  {
    id: 'rider-08-backlit',
    group: 'rider',
    time: 30.0,
    input: HOLD,
    // Sun points (-0.42, 0.62, 0.66); this puts it behind the rider.
    camera: boat(-1.9, 0.10, 4.6, 1.2),
    description: 'Rider against bright sky. Rim light must separate the silhouette.',
  },
  {
    id: 'rider-09-pack',
    group: 'rider',
    time: 33.0,
    input: HOLD,
    camera: boat(2.4, 0.30, 14.0, 1.0),
    description: 'All four riders at gameplay distance. Do they read at this size?',
  },
];
