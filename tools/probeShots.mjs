/**
 * Cel-pipeline calibration shots. Used with `?probe=1`, which swaps the race
 * for a set of primitives with known-correct normals so a shading defect can be
 * attributed to the pipeline rather than to the art.
 *
 *   node tools/capture.mjs --shotfile tools/probeShots.mjs --out shots/probe-cel
 */

const free = (position, target) => ({ mode: 'free', position, target });

export const SHOT_GROUPS = { probe: 'Cel pipeline calibration primitives' };

export const SHOTS = [
  {
    id: 'probe-01-lineup',
    group: 'probe',
    time: 6.0,
    camera: free([1.5, 6.5, 17], [1.5, 2.4, 0]),
    description: 'All primitives. Band thresholds, hard-edge outlines, cone apex.',
  },
  {
    id: 'probe-02-distance-row',
    group: 'probe',
    time: 6.0,
    camera: free([-9, 5.5, 14], [-8, 2.2, -60]),
    description: 'Identical spheres at 6 m to 94 m. Outline width must be constant.',
  },
  {
    id: 'probe-03-knot-interior',
    group: 'probe',
    time: 6.0,
    camera: free([2.4, 3.4, 6.2], [2.4, 2.6, 0]),
    description: 'Torus knot close up. Sobel interior creases without double-inking.',
  },
  {
    id: 'probe-04-sphere-ramp',
    group: 'probe',
    time: 6.0,
    camera: free([-6, 2.8, 5.5], [-6, 2.4, 0]),
    description: 'Sphere filling the frame. Read the band thresholds directly.',
  },
  {
    id: 'probe-05-backlit',
    group: 'probe',
    time: 6.0,
    // Sun is at (-0.42, 0.62, 0.66); stand on the far side to backlight.
    camera: free([9, 3.2, -12], [-2, 2.4, 2]),
    description: 'Backlit. Fresnel rim must separate every silhouette from the water.',
  },
  {
    id: 'probe-06-hard-edges',
    group: 'probe',
    time: 6.0,
    camera: free([-2, 3.2, 4.4], [-2, 2.4, 0]),
    description: 'Box close up. The inverted hull must not split at the corners.',
  },
];
