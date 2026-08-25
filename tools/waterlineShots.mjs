/**
 * WATERLINE CALIBRATION SHOTS — run with `--waterline`.
 *
 * One frame per station of `src/dev/WaterlineRig.ts`. Each frames a graduated
 * staff and an amber reference plate, both placed at exactly the height the CPU
 * sampler reports for their world XZ, from eye level with that water.
 *
 * HOW TO READ ONE
 *
 *   The red band on the staff sits immediately BELOW the sampled height, so the
 *   top edge of the red band is zero. If the shader and the sampler agree, the
 *   waterline crosses the staff exactly at the top of the red band, and the
 *   amber plate is cut in half along its length.
 *
 *   Water below the top of the red band  -> the sampler is reporting HIGHER
 *   than the shader draws, and everything placed from it hovers.
 *   Water above it -> the reverse, and everything placed from it sinks.
 *
 *   Count bands to get the error. One band is worth:
 *     station 0 (6 m)    0.10 m
 *     station 1 (18 m)   0.10 m
 *     station 2 (45 m)   0.25 m
 *     station 3 (120 m)  0.50 m
 *     station 4 (320 m)  1.00 m
 *     station 5 (700 m)  2.00 m
 *
 * Two times per station, because the error is expected to depend on where in
 * the wave cycle the station happens to be: a fault that only shows on a crest
 * looks like a pass if you sample a trough.
 */

export const SHOT_GROUPS = {
  near: 'Stations inside the detail-fade radius',
  far: 'Stations past it',
  fade: 'Same station with the vertex detail fade on and off',
};

const station = (index, back = 4, lift = 0.6) => ({ mode: 'station', index, back, lift });

const at = (id, group, index, time, description, back, lift, setup) => ({
  id,
  group,
  time,
  camera: station(index, back, lift),
  description,
  ...(setup ? { setup } : {}),
});

/**
 * The vertex shader rolls the wave amplitude down towards 55% between
 * uDetailFadeStart and uDetailFadeEnd, to stop far-field chop from shimmering.
 * The CPU sampler has no such term — it cannot, because buoyancy must not
 * depend on where the camera is looking. Pushing the fade start beyond the
 * horizon disables it, so the pair of frames below differ ONLY by that term and
 * the difference in where the water crosses the staff is exactly the error it
 * introduces.
 */
const FADE_OFF = { setOceanUniform: ['uDetailFadeStart', 1e9] };
const FADE_ON = { setOceanUniform: ['uDetailFadeStart', 150] };

export const SHOTS = [
  at('wl-0-6m-t7', 'near', 0, 7.0, '6 m. One band = 10 cm.', 3.2, 0.35),
  at('wl-1-18m-t7', 'near', 1, 7.0, '18 m. One band = 10 cm.', 3.4, 0.4),
  at('wl-2-45m-t7', 'near', 2, 7.0, '45 m. One band = 25 cm.', 3.4, 0.4),
  at('wl-3-120m-t7', 'far', 3, 7.0, '120 m, just past the fade start. One band = 50 cm.', 3.2, 0.4),
  at('wl-4-320m-t7', 'far', 4, 7.0, '320 m, mid-fade. One band = 1 m.', 3.0, 0.4),
  at('wl-5-700m-t7', 'far', 5, 7.0, '700 m, fully faded. One band = 2 m.', 3.0, 0.4),

  // Second pass at a different phase of the swell.
  at('wl-0-6m-t19', 'near', 0, 19.0, '6 m at a different wave phase.', 3.2, 0.35),
  at('wl-1-18m-t19', 'near', 1, 19.0, '18 m at a different wave phase.', 3.4, 0.4),
  at('wl-3-120m-t19', 'far', 3, 19.0, '120 m at a different wave phase.', 3.2, 0.4),
  at('wl-4-320m-t19', 'far', 4, 19.0, '320 m at a different wave phase.', 3.0, 0.4),

  // Differential pairs. Same station, same instant, fade on then off.
  at('fade-3-120m-on', 'fade', 3, 26.0, '120 m, detail fade active.', 3.2, 0.4, FADE_ON),
  at('fade-3-120m-off', 'fade', 3, 26.0, '120 m, detail fade disabled.', 3.2, 0.4, FADE_OFF),
  at('fade-4-320m-on', 'fade', 4, 27.0, '320 m, detail fade active.', 3.0, 0.4, FADE_ON),
  at('fade-4-320m-off', 'fade', 4, 27.0, '320 m, detail fade disabled.', 3.0, 0.4, FADE_OFF),
  at('fade-5-700m-on', 'fade', 5, 28.0, '700 m, detail fade active.', 3.0, 0.4, FADE_ON),
  at('fade-5-700m-off', 'fade', 5, 28.0, '700 m, detail fade disabled.', 3.0, 0.4, FADE_OFF),
];
