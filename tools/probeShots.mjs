/**
 * Cel-pipeline calibration shots. Used with `?probe=1`, which swaps the race
 * for a set of primitives with known-correct normals so a shading defect can be
 * attributed to the pipeline rather than to the art.
 *
 *   node tools/capture.mjs --shotfile tools/probeShots.mjs --probe --out shots/probe-cel
 *
 * NOTE ON THE DIAG GROUP: shot setups poke live uniforms and the harness never
 * resets them, so a debug tap left on by one shot bleeds into the next. Every
 * diag shot therefore states its full state, including the taps it does *not*
 * want, and the beauty shots pin `setDebugView: 0` for the same reason. Two
 * capture rounds were thrown away to a leaked `setDebugView(2)` before this was
 * written down.
 */

const free = (position, target) => ({ mode: 'free', position, target });

export const SHOT_GROUPS = {
  probe: 'Cel pipeline calibration primitives',
  diag: 'Debug taps: packed normals, linear depth, isolated line mask',
};

export const SHOTS = [
  {
    id: 'probe-01-lineup',
    group: 'probe',
    time: 6.0,
    camera: free([2.0, 6.5, 19], [2.0, 2.4, 0]),
    setup: { setDebugView: 0 },
    description: 'All primitives. Band thresholds, hard-edge outlines, cone apex.',
  },
  {
    id: 'probe-02-distance-row',
    group: 'probe',
    time: 6.0,
    // Sighted 6 m to the side of the lane and 5 m up, so the five spheres fan
    // across the frame instead of stacking, and every one of them clears the
    // swell. Sighting straight down the lane put the near sphere over the far
    // four and made the whole measurement impossible.
    camera: free([-13.0, 7.4, 10], [-22, 2.2, -46]),
    setup: { setDebugView: 0 },
    description: 'Identical spheres at 6 m to 94 m. Outline width must be constant.',
  },
  {
    id: 'probe-03-knot-interior',
    group: 'probe',
    time: 6.0,
    camera: free([2.4, 3.4, 6.2], [2.4, 2.6, 0]),
    setup: { setDebugView: 0 },
    description: 'Torus knot close up. Sobel interior creases without double-inking.',
  },
  {
    id: 'probe-04-sphere-ramp',
    group: 'probe',
    time: 6.0,
    camera: free([-6, 2.8, 5.5], [-6, 2.4, 0]),
    setup: { setDebugView: 0 },
    description: 'Sphere filling the frame. Read the band thresholds directly.',
  },
  {
    id: 'probe-05-backlit',
    group: 'probe',
    time: 6.0,
    // Sun is at (-0.42, 0.62, 0.66); stand on the far side to backlight.
    camera: free([9, 3.2, -12], [-2, 2.4, 2]),
    setup: { setDebugView: 0 },
    description: 'Backlit. Fresnel rim must separate every silhouette from the water.',
  },
  {
    id: 'probe-06-hard-edges',
    group: 'probe',
    time: 6.0,
    camera: free([-2, 3.2, 4.4], [-2, 2.4, 0]),
    setup: { setDebugView: 0 },
    description: 'Box close up. The inverted hull must not split at the corners.',
  },
  {
    id: 'probe-07-creases',
    group: 'probe',
    time: 6.0,
    camera: free([14.5, 3.6, 6.4], [14.5, 2.6, 0]),
    setup: { setDebugView: 0 },
    description: 'Crease stack. Only the screen-space pass can line these steps.',
  },
  {
    id: 'probe-08-mast',
    group: 'probe',
    time: 6.0,
    camera: free([-11.5, 3.8, 8.0], [-11.5, 3.4, 0]),
    setup: { setDebugView: 0 },
    description: 'Thin mast. Ink must be one line wide, not two, and not solid.',
  },
  {
    id: 'probe-09-white',
    group: 'probe',
    time: 6.0,
    camera: free([10, 2.9, 5.0], [10, 2.4, 0]),
    setup: { setDebugView: 0 },
    description: 'Near-white icosahedron. Any hue here was invented by the shader.',
  },

  // ---- isolation shots -------------------------------------------------
  // Every one of these exists because a defect was visible in a beauty frame
  // and could have come from any of three systems. Turning one system off is
  // the only way to attribute it.
  {
    id: 'diag-01-normals',
    group: 'diag',
    time: 6.0,
    camera: free([-6, 2.8, 5.5], [-6, 2.4, 0]),
    setup: { setDebugView: 1 },
    description: 'MRT attachment 1, packed view normals, on the ramp sphere.',
  },
  {
    id: 'diag-02-depth',
    group: 'diag',
    time: 6.0,
    camera: free([2.0, 6.5, 19], [2.0, 2.4, 0]),
    setup: { setDebugView: 2 },
    description: 'Linear depth. Verifies the outline shell is not writing near depth.',
  },
  {
    id: 'diag-03-line-mask',
    group: 'diag',
    time: 6.0,
    camera: free([2.0, 6.5, 19], [2.0, 2.4, 0]),
    setup: { setDebugView: 3 },
    description: 'Isolated Sobel mask. Shows exactly where interior lines fire.',
  },
  {
    id: 'diag-04-line-mask-creases',
    group: 'diag',
    time: 6.0,
    camera: free([14.5, 3.6, 6.4], [14.5, 2.6, 0]),
    setup: { setDebugView: 3 },
    description: 'Isolated Sobel mask over the crease stack.',
  },
  {
    id: 'diag-05-line-mask-knot',
    group: 'diag',
    time: 6.0,
    camera: free([2.4, 3.4, 6.2], [2.4, 2.6, 0]),
    setup: { setDebugView: 3 },
    description: 'Isolated Sobel mask over the knot self-crossings.',
  },
];
