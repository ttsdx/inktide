export const SHOT_GROUPS = { dbg: 'Ocean term isolation on the water-02 framing' };
const cam = { mode: 'free', position: [600, 5.2, 600], target: [600, 0.5, 545] };
const at = (id, mode, description) => ({
  id, group: 'dbg', time: 12.0, camera: cam,
  setup: { setOceanUniform: ['uDebug', mode] }, description,
});
export const SHOTS = [
  at('dbg-0-final', 0, 'Finished water.'),
  at('dbg-4-bands', 4, 'The four-tone body alone.'),
  at('dbg-5-prefoam', 5, 'Body plus sun plane, lift and contour, before foam.'),
];
