/**
 * ARCH BLACK-BAND DIAGNOSIS.
 *
 * A gate arch seen against the sky has a band of pure (0,0,0) running along it,
 * between its correctly-lit amber top face and its correctly-shaded amber
 * underside. Pure black is not a value any part of the pipeline is supposed to
 * produce: the cel ramp's darkest band is 0.24 times the paint, and the ink
 * colour is a dark navy, never zero. So this is not a shading problem and
 * retuning the ramp will not touch it.
 *
 * Four frames of the identical moment and camera, differing only in what the
 * post chain is asked to output, which between them say who is drawing it:
 *
 *   beauty  what it looks like now
 *   normals the packed view normals; a real surface has one, a hole does not
 *   depth   linear depth; the same test from the other attachment
 *   lines   the isolated edge-pass mask; if the band is here, the Sobel owns it
 */

export const SHOT_GROUPS = { arch: 'Gate arch against sky, one moment, four outputs' };

const cam = { mode: 'prop', kind: 'gate', index: 1, yaw: 0.75, pitch: 0.16, distance: 42, lookHeight: 7.5 };

const view = (id, mode, description) => ({
  id,
  group: 'arch',
  time: 12.0,
  camera: cam,
  setup: { setDebugView: mode },
  description,
});

export const SHOTS = [
  view('arch-0-beauty', 0, 'Normal output.'),
  view('arch-1-normals', 1, 'Packed view normals.'),
  view('arch-2-depth', 2, 'Linear depth.'),
  view('arch-3-lines', 3, 'Isolated edge mask.'),
];
