/**
 * WATERLINE SHOTS
 *
 * Does the course furniture actually float, or does it hover?
 *
 * The chase camera looks down on props from ten metres up, where a float
 * sitting five centimetres proud of the surface is invisible. These shots put
 * the camera nearly at sea level and a few metres away, so the contact between
 * a hull and the water fills the frame and any gap is unmissable.
 *
 * Several times per shot list, because a single sample proves nothing: a buoy
 * in a trough and a buoy on a crest are different tests, and the gate's failure
 * mode is specifically the one whose pylon is on the far side of a swell.
 */

export const SHOT_GROUPS = {
  buoy: 'Buoy waterline contact',
  gate: 'Gate collar waterline contact',
};

const buoy = (index, yaw, pitch, distance, lookHeight = 0) => ({
  mode: 'prop',
  kind: 'buoy',
  index,
  yaw,
  pitch,
  distance,
  lookHeight,
});

const gate = (index, yaw, pitch, distance, lookHeight = 0) => ({
  mode: 'prop',
  kind: 'gate',
  index,
  yaw,
  pitch,
  distance,
  lookHeight,
});

export const SHOTS = [
  // Four different buoys at four different times, so the sample covers a float
  // near a crest, a float in a trough and two in between.
  {
    id: 'float-buoy-a',
    group: 'buoy',
    time: 6.0,
    camera: buoy(8, 0.6, 0.05, 4.2, 0.35),
    description: 'Buoy at near-eye level, 4 m. The collar must cut the surface.',
  },
  {
    id: 'float-buoy-b',
    group: 'buoy',
    time: 11.0,
    camera: buoy(9, 2.1, 0.02, 3.4, 0.3),
    description: 'A second buoy, opposite side, lower still.',
  },
  {
    id: 'float-buoy-c',
    group: 'buoy',
    time: 17.0,
    camera: buoy(30, 1.2, -0.04, 3.0, 0.5),
    description: 'Below the collar looking slightly up. Exposes any hover gap.',
  },
  {
    id: 'float-buoy-d',
    group: 'buoy',
    time: 23.0,
    camera: buoy(31, 4.0, 0.1, 5.5, 0.4),
    description: 'Wider, so the buoy is read against the swell it sits in.',
  },

  // Gates: the pylon collar is the contact point, and the interesting case is
  // the pylon on the far side of a wave from the gate's centre sample.
  {
    id: 'float-gate-a',
    group: 'gate',
    time: 8.0,
    camera: gate(1, 0.9, 0.06, 9.0, 1.0),
    description: 'Gate pylon collar at 9 m, near sea level.',
  },
  {
    id: 'float-gate-b',
    group: 'gate',
    time: 14.0,
    camera: gate(4, 2.6, 0.03, 7.0, 0.8),
    description: 'A different gate, tighter, from the other side.',
  },
  {
    id: 'float-gate-c',
    group: 'gate',
    time: 21.0,
    camera: gate(7, 1.7, 0.14, 26.0, 2.0),
    description: 'Both pylons in frame. Does the span sit level in the swell?',
  },
];
