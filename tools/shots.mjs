/**
 * SHOT LIST
 *
 * Each entry is a pure data description of a moment in the game so it can be
 * serialised across the Playwright boundary and reproduced exactly.
 *
 *   id          unique, becomes the PNG filename
 *   group       used by --shots to capture a subset while iterating
 *   time        absolute simulation time in seconds (fixed 1/60 stepping)
 *   camera      { mode: 'free'|'orbit'|'chase'|'onboard'|'heli'|'flyby' }
 *   input       scripted control state held while stepping to `time`
 *   setup       harness method calls applied before stepping
 *
 * The shot list is deliberately adversarial: it includes the angles where each
 * subsystem is most likely to look wrong (horizon line, sun glitter path,
 * grazing water, silhouettes against bright sky) rather than only the flattering
 * hero angles.
 */

export const SHOT_GROUPS = {
  water: 'Ocean surface, waves, foam, sparkle',
  sky: 'Dome, clouds, sun, horizon',
  cel: 'Cel shading, outlines, interior lines',
  boat: 'Hull, buoyancy, wake, spray',
  rider: 'Character rig and animation',
  race: 'Course, gates, AI, laps',
  hud: 'HUD, minimap, screens',
  perf: 'Stress angles for performance measurement',
};

/** Camera helpers so the list below stays readable. */
const free = (position, target) => ({ mode: 'free', position, target });
const orbit = (angle, radius, height) => ({ mode: 'orbit', angle, radius, height });

export const SHOTS = [
  // -------------------------------------------------------------------------
  // WATER — the most-iterated subsystem gets the most angles.
  // -------------------------------------------------------------------------
  {
    id: 'water-01-low-grazing',
    group: 'water',
    time: 8.0,
    camera: free([0, 1.8, 26], [0, 1.2, -40]),
    description: 'Camera just above the surface. Tests crest silhouettes and the horizon line.',
  },
  {
    id: 'water-02-mid-chase-height',
    group: 'water',
    time: 12.0,
    camera: free([0, 5.2, 22], [0, 0.5, -30]),
    description: 'The height the chase cam actually sits at. This is the shot that matters most.',
  },
  {
    id: 'water-03-high-overview',
    group: 'water',
    time: 16.0,
    camera: free([0, 42, 55], [0, 0, -20]),
    description: 'High angle. Exposes tiling repetition and radial disc artefacts.',
  },
  {
    id: 'water-04-into-sun',
    group: 'water',
    time: 20.0,
    // Sun direction is (-0.42, 0.62, 0.66), so look along -sun to face it.
    camera: free([12, 3.4, -19], [-12, 8, 19]),
    description: 'Straight into the sun. Tests the glitter path and sparkle quantisation.',
  },
  {
    id: 'water-05-away-from-sun',
    group: 'water',
    time: 24.0,
    camera: free([-12, 3.4, 19], [12, 1, -19]),
    description: 'Sun behind camera. Water must still read as banded, not flat.',
  },
  {
    id: 'water-06-crest-closeup',
    group: 'water',
    time: 28.5,
    camera: free([0, 2.4, 9], [0, 1.0, -6]),
    description: 'Close on a single crest. Foam edge quality and band hardness.',
  },
  {
    id: 'water-07-horizon-far',
    group: 'water',
    time: 33.0,
    camera: free([0, 14, 30], [0, 6, -600]),
    description: 'Long view to the horizon. Tests detail fade and haze banding.',
  },
  {
    id: 'water-08-different-locale',
    group: 'water',
    time: 40.0,
    camera: free([1400, 5.2, -900], [1400, 0.5, -970]),
    description: 'A kilometre away. Must not look like the same patch of water.',
  },

  // -------------------------------------------------------------------------
  // SKY
  // -------------------------------------------------------------------------
  {
    id: 'sky-01-zenith',
    group: 'sky',
    time: 10.0,
    camera: free([0, 6, 0], [0, 60, -14]),
    description: 'Looking up. Cloud shapes, rim lighting, gradient bands.',
  },
  {
    id: 'sky-02-sun-disc',
    group: 'sky',
    time: 14.0,
    camera: free([0, 6, 0], [-14, 20, 22]),
    description: 'Sun in frame. Flare must stay graphic, never photographic.',
  },
  {
    id: 'sky-03-horizon-band',
    group: 'sky',
    time: 18.0,
    camera: free([0, 8, 0], [0, 7.4, -120]),
    description: 'Horizon dead centre. Sky/water meeting line.',
  },

  // -------------------------------------------------------------------------
  // CEL PIPELINE — added once there is geometry to shade.
  // -------------------------------------------------------------------------
  {
    id: 'cel-01-hull-three-quarter',
    group: 'cel',
    time: 9.0,
    camera: free([7.5, 3.0, 9.5], [0, 0.8, 0]),
    description: 'Standard three-quarter product angle on the player hull.',
  },
  {
    id: 'cel-02-silhouette-vs-sky',
    group: 'cel',
    time: 11.0,
    camera: free([0, 0.9, 13], [0, 1.6, 0]),
    description: 'Boat against bright sky. Outline consistency on the silhouette.',
  },
  {
    id: 'cel-03-outline-far',
    group: 'cel',
    time: 13.0,
    camera: free([0, 8, 95], [0, 1, 0]),
    description: 'Boat at 95 m. Outline must still be visible and the same weight.',
  },
  {
    id: 'cel-04-outline-near',
    group: 'cel',
    time: 15.0,
    camera: free([2.4, 1.5, 3.2], [0, 0.9, 0]),
    description: 'Boat at 3 m. Outline must not be fat.',
  },
  {
    id: 'cel-05-interior-lines',
    group: 'cel',
    time: 17.0,
    camera: free([3.6, 2.6, 4.4], [0, 1.0, 0]),
    description: 'Close on the cockpit. Tests Sobel interior creases without doubling.',
  },

  // -------------------------------------------------------------------------
  // BOAT
  // -------------------------------------------------------------------------
  {
    id: 'boat-01-chase-cruise',
    group: 'boat',
    time: 14.0,
    camera: { mode: 'chase' },
    input: { throttle: 1, steer: 0 },
    description: 'Default play view at cruising speed.',
  },
  {
    id: 'boat-02-hard-turn',
    group: 'boat',
    time: 18.0,
    camera: { mode: 'chase' },
    input: { throttle: 1, steer: 1, drift: true },
    description: 'Powerslide. Camera swing, spray, wake spread.',
  },
  {
    id: 'boat-03-wake-behind',
    group: 'boat',
    time: 22.0,
    camera: free([0, 6.5, 34], [0, 0.6, 0]),
    input: { throttle: 1 },
    description: 'Looking back down the wake. Tests persistence and dissipation.',
  },
  {
    id: 'boat-04-onboard',
    group: 'boat',
    time: 26.0,
    camera: { mode: 'onboard' },
    input: { throttle: 1 },
    description: 'Bow camera. Hull pitch against the swell.',
  },

  // -------------------------------------------------------------------------
  // RIDER
  // -------------------------------------------------------------------------
  {
    id: 'rider-01-portrait',
    group: 'rider',
    time: 10.0,
    camera: free([2.6, 2.3, 3.0], [0, 1.5, -0.3]),
    description: 'Close on the rider. Silhouette, proportions, ink weight.',
  },
  {
    id: 'rider-02-lean',
    group: 'rider',
    time: 20.0,
    camera: free([3.4, 2.4, 1.2], [0, 1.5, -0.3]),
    input: { throttle: 1, steer: 1, drift: true },
    description: 'Rider leaning hard into a turn.',
  },

  // -------------------------------------------------------------------------
  // RACE
  // -------------------------------------------------------------------------
  {
    id: 'race-01-grid',
    group: 'race',
    time: 1.0,
    camera: { mode: 'flyby' },
    description: 'Countdown. Cinematic orbit over the grid.',
  },
  {
    id: 'race-02-pack',
    group: 'race',
    time: 30.0,
    camera: { mode: 'heli' },
    input: { throttle: 1 },
    description: 'Four boats in frame. Reads the whole pack and the racing line.',
  },
  {
    id: 'race-03-gate',
    group: 'race',
    time: 36.0,
    camera: { mode: 'chase' },
    input: { throttle: 1 },
    description: 'Approaching a checkpoint gate.',
  },

  // -------------------------------------------------------------------------
  // HUD
  // -------------------------------------------------------------------------
  {
    id: 'hud-01-race',
    group: 'hud',
    time: 32.0,
    camera: { mode: 'chase' },
    input: { throttle: 1 },
    description: 'Full HUD during a race.',
  },

  // -------------------------------------------------------------------------
  // PERF
  // -------------------------------------------------------------------------
  {
    id: 'perf-01-worst-case',
    group: 'perf',
    time: 34.0,
    camera: { mode: 'heli' },
    input: { throttle: 1, steer: 0.7, drift: true },
    description: 'Everything on screen at once: pack, wakes, spray, gates, HUD.',
  },
];
