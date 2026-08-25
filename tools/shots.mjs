/**
 * THE CANONICAL SHOT LIST
 *
 * Each entry is a pure data description of a moment so it can be serialised
 * across the Playwright boundary and reproduced exactly.
 *
 *   id          unique, becomes the PNG filename
 *   group       used by --shots to capture a subset while iterating
 *   time        absolute simulation time in seconds (fixed 1/60 stepping)
 *   camera      { mode: 'free' | 'orbit' | 'boat' | 'chase' | 'onboard' | 'heli' | 'flyby' }
 *   input       scripted control state held while stepping to `time`
 *   setup       harness method calls applied before stepping
 *   includeHud  capture through the page compositor instead of off the canvas
 *
 * The list is deliberately adversarial. It includes the angles where each
 * subsystem is most likely to look wrong — grazing water, straight into the
 * sun, a boat at 95 m, a silhouette against bright sky, the HUD over white
 * foam — rather than only the flattering hero angles.
 *
 * `boat` cameras are framed relative to the player's own heading, so a shot
 * stays composed wherever on the circuit the racer has reached by that time.
 * Fixed world-space cameras are only used where the point of the shot is the
 * water itself and the boats are irrelevant.
 */

export const SHOT_GROUPS = {
  water: 'Ocean surface, waves, foam, sparkle',
  sky: 'Dome, clouds, sun, horizon',
  cel: 'Cel shading, outlines, interior lines',
  boat: 'Hull form, livery, wake, spray',
  rider: 'Character rig and animation',
  race: 'Course, gates, AI, laps',
  hud: 'HUD, minimap, screens',
  hero: 'The frames that represent the game',
};

const free = (position, target) => ({ mode: 'free', position, target });
const boat = (yaw, pitch, distance, lookHeight = 1.0) => ({
  mode: 'boat',
  index: 0,
  yaw,
  pitch,
  distance,
  lookHeight,
});

const CRUISE = { throttle: 1, steer: 0 };
const SLIDE = { throttle: 1, steer: 1, drift: true };

export const SHOTS = [
  // -------------------------------------------------------------------------
  // WATER — the most-iterated subsystem gets the most angles. These use fixed
  // world cameras away from the grid so nothing but ocean is in frame.
  // -------------------------------------------------------------------------
  {
    id: 'water-01-low-grazing',
    group: 'water',
    time: 8.0,
    camera: free([600, 1.8, 600], [600, 1.2, 540]),
    description: 'Just above the surface. Crest silhouettes and the horizon line.',
  },
  {
    id: 'water-02-mid-chase-height',
    group: 'water',
    time: 12.0,
    camera: free([600, 5.2, 600], [600, 0.5, 545]),
    description: 'The height the chase cam sits at. The shot that matters most.',
  },
  {
    id: 'water-03-high-overview',
    group: 'water',
    time: 16.0,
    camera: free([600, 42, 640], [600, 0, 570]),
    description: 'High angle. Exposes tiling repetition and radial disc artefacts.',
  },
  {
    id: 'water-04-into-sun',
    group: 'water',
    time: 20.0,
    // Sun direction is (-0.42, 0.62, 0.66), so look back along it.
    camera: free([612, 3.4, 581], [588, 8, 619]),
    description: 'Straight into the sun. Glitter path and sparkle quantisation.',
  },
  {
    id: 'water-05-away-from-sun',
    group: 'water',
    time: 24.0,
    camera: free([588, 3.4, 619], [612, 1, 581]),
    description: 'Sun behind camera. Water must still read as banded, not flat.',
  },
  {
    id: 'water-06-crest-closeup',
    group: 'water',
    time: 28.5,
    camera: free([600, 2.4, 609], [600, 1.0, 594]),
    description: 'Close on a single crest. Foam edge quality, band hardness.',
  },
  {
    id: 'water-07-horizon-far',
    group: 'water',
    time: 33.0,
    camera: free([600, 14, 630], [600, 6, 30]),
    description: 'Long view to the horizon. Detail fade and haze banding.',
  },
  {
    id: 'water-08-different-locale',
    group: 'water',
    time: 40.0,
    camera: free([-2400, 5.2, 1900], [-2400, 0.5, 1830]),
    description: 'Three kilometres away. Must not look like the same water.',
  },

  // -------------------------------------------------------------------------
  // SKY
  // -------------------------------------------------------------------------
  {
    id: 'sky-01-zenith',
    group: 'sky',
    time: 10.0,
    camera: free([600, 6, 600], [600, 60, 586]),
    description: 'Looking up. Cloud shapes, rim lighting, gradient bands.',
  },
  {
    id: 'sky-02-sun-disc',
    group: 'sky',
    time: 14.0,
    camera: free([600, 6, 600], [586, 20, 622]),
    description: 'Sun in frame. The flare must stay graphic, never photographic.',
  },
  {
    id: 'sky-03-horizon-band',
    group: 'sky',
    time: 18.0,
    camera: free([600, 8, 600], [600, 7.4, 480]),
    description: 'Horizon dead centre. Where sky and water meet.',
  },

  // -------------------------------------------------------------------------
  // CEL PIPELINE — on real art, not primitives.
  // -------------------------------------------------------------------------
  {
    id: 'cel-01-hull-three-quarter',
    group: 'cel',
    time: 9.0,
    input: CRUISE,
    camera: boat(0.9, 0.18, 8, 0.9),
    description: 'The product angle. Band placement on a real hull.',
  },
  {
    id: 'cel-02-silhouette-vs-sky',
    group: 'cel',
    time: 11.0,
    input: CRUISE,
    camera: boat(1.6, -0.10, 9, 1.1),
    description: 'Boat against bright sky. Outline and rim on the silhouette.',
  },
  {
    id: 'cel-03-outline-far',
    group: 'cel',
    time: 13.0,
    input: CRUISE,
    camera: boat(2.4, 0.30, 95, 1.0),
    description: 'Boat at 95 m. The outline must survive and hold its weight.',
  },
  {
    id: 'cel-04-outline-near',
    group: 'cel',
    time: 15.0,
    input: CRUISE,
    camera: boat(2.2, 0.14, 3.4, 1.0),
    description: 'Boat at 3.4 m. The outline must not go fat.',
  },
  {
    id: 'cel-05-interior-lines',
    group: 'cel',
    time: 17.0,
    input: CRUISE,
    camera: boat(1.1, 0.24, 4.6, 1.0),
    description: 'Close on the cockpit. Sobel creases without doubling the hull ink.',
  },

  // -------------------------------------------------------------------------
  // BOAT
  // -------------------------------------------------------------------------
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
    id: 'boat-03-top',
    group: 'boat',
    time: 18.0,
    input: CRUISE,
    camera: boat(0.5, 1.15, 12, 0.4),
    description: 'From above. Deck layout, cockpit well, livery placement.',
  },
  {
    id: 'boat-04-wake-behind',
    group: 'boat',
    time: 26.0,
    input: CRUISE,
    camera: boat(Math.PI, 0.26, 26, 0.6),
    description: 'Looking back down the wake. Persistence, spread, dissipation.',
  },
  {
    id: 'boat-05-powerslide',
    group: 'boat',
    time: 30.0,
    input: SLIDE,
    camera: boat(2.1, 0.20, 11, 0.9),
    description: 'Mid-drift. Hull bank, spray off the loaded side, wake spread.',
  },

  // -------------------------------------------------------------------------
  // RIDER
  // -------------------------------------------------------------------------
  {
    id: 'rider-01-three-quarter',
    group: 'rider',
    time: 9.0,
    input: CRUISE,
    camera: boat(2.5, 0.16, 4.2, 1.25),
    description: 'Silhouette, proportions, ink weight on the character.',
  },
  {
    id: 'rider-02-lean',
    group: 'rider',
    time: 20.0,
    input: SLIDE,
    camera: boat(2.2, 0.14, 4.6, 1.2),
    description: 'Leaning into a drift. Spine roll and head counter-roll.',
  },
  {
    id: 'rider-03-profile',
    group: 'rider',
    time: 23.0,
    input: CRUISE,
    camera: boat(Math.PI / 2, 0.10, 4.0, 1.2),
    description: 'Side on. Torso pitch, elbow bend, hands welded to the bars.',
  },

  // -------------------------------------------------------------------------
  // RACE
  // -------------------------------------------------------------------------
  {
    id: 'race-01-grid',
    group: 'race',
    time: 1.0,
    includeHud: true,
    camera: { mode: 'flyby' },
    description: 'Countdown over the grid, cinematic camera.',
  },
  {
    id: 'race-02-pack',
    group: 'race',
    time: 30.0,
    input: CRUISE,
    camera: { mode: 'heli' },
    description: 'The whole pack and the racing line from above.',
  },
  {
    id: 'race-03-gate',
    group: 'race',
    time: 44.0,
    input: CRUISE,
    camera: { mode: 'chase' },
    description: 'Approaching a checkpoint gate.',
  },

  // -------------------------------------------------------------------------
  // HUD — the only shots captured through the page compositor.
  // -------------------------------------------------------------------------
  {
    id: 'hud-01-racing',
    group: 'hud',
    time: 22.0,
    includeHud: true,
    input: CRUISE,
    camera: { mode: 'chase' },
    description: 'Full HUD at speed. The frame the player spends the race in.',
  },
  {
    id: 'hud-02-drift-boost',
    group: 'hud',
    time: 28.0,
    includeHud: true,
    input: SLIDE,
    camera: { mode: 'chase' },
    description: 'Boost meter charging mid-powerslide.',
  },
  {
    id: 'hud-03-over-foam',
    group: 'hud',
    time: 36.0,
    includeHud: true,
    input: CRUISE,
    camera: { mode: 'onboard' },
    description: 'Cockpit view, maximum white water behind the HUD. Contrast test.',
  },

  // -------------------------------------------------------------------------
  // HERO — if the project is judged on three frames, these are the three.
  // -------------------------------------------------------------------------
  {
    id: 'hero-01-chase',
    group: 'hero',
    time: 52.0,
    includeHud: true,
    input: CRUISE,
    camera: { mode: 'chase' },
    description: 'The default play view, mid-race, HUD live.',
  },
  {
    id: 'hero-02-pack-low',
    group: 'hero',
    time: 58.0,
    input: CRUISE,
    camera: boat(2.55, 0.26, 7.0, 1.45),
    description: 'Close behind the boat. The hero product angle in motion.',
  },
  {
    id: 'hero-03-slide',
    group: 'hero',
    time: 64.0,
    input: SLIDE,
    camera: boat(1.55, 0.28, 6.6, 1.4),
    description: 'Committed powerslide with spray and a spreading wake.',
  },
];
