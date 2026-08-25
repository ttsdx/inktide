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
  //
  // `lookHeight` is kept near zero on purpose: the contact between the float
  // and the water is the subject, and framing it from even three metres up
  // hides the exact thing the shot exists to show.
  {
    id: 'float-buoy-a',
    group: 'buoy',
    time: 6.0,
    camera: buoy(8, 0.6, 0.03, 2.6, 0.18),
    description: 'Buoy at eye level, 2.6 m. The collar must cut the surface.',
  },
  {
    id: 'float-buoy-b',
    group: 'buoy',
    time: 11.0,
    camera: buoy(9, 2.1, 0.0, 2.2, 0.12),
    description: 'A second buoy, opposite side, dead level with the water.',
  },
  {
    id: 'float-buoy-c',
    group: 'buoy',
    time: 17.0,
    camera: buoy(30, 1.2, -0.05, 2.4, 0.1),
    description: 'From just below the collar. Any hover gap is unmissable here.',
  },
  {
    id: 'float-buoy-d',
    group: 'buoy',
    time: 23.0,
    camera: buoy(31, 4.0, 0.06, 4.0, 0.25),
    description: 'Wider, so the buoy is read against the swell it sits in.',
  },

  // Gates: the pylon collar is the contact point, and the interesting case is
  // the pylon on the far side of a wave from the gate's centre sample.
  {
    id: 'float-gate-a',
    group: 'gate',
    time: 8.0,
    camera: gate(1, 0.9, 0.03, 6.5, 0.4),
    description: 'Gate pylon collar at 6.5 m, near sea level.',
  },
  {
    id: 'float-gate-b',
    group: 'gate',
    time: 14.0,
    camera: gate(4, 2.6, 0.0, 5.0, 0.3),
    description: 'A different gate, tighter, from the other side.',
  },
  {
    id: 'float-gate-under',
    group: 'gate',
    time: 17.0,
    camera: gate(2, 1.4, 0.55, 16.0, 2.0),
    description: 'Looking up at the arch from under it. The black-slab test.',
  },
  {
    id: 'float-gate-c',
    group: 'gate',
    time: 21.0,
    camera: gate(7, 1.7, 0.14, 26.0, 2.0),
    description: 'Both pylons in frame. Does the span sit level in the swell?',
  },
];
