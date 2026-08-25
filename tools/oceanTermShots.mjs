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

// Does the floor respond at all? 0.06 measured byte-identical to no floor,
// which a 40% cut to the spill cannot be, so either the bloom values are far
// larger than assumed or the term is not doing what it reads as.
for (const f of [0.15, 0.5, 2.0]) {
  SHOTS.push({
    id: `dbg-floor-${String(f).replace('.', 'p')}`,
    group: 'dbg',
    time: 12.0,
    camera: cam,
    setup: { setOceanUniform: ['uDebug', 4], setPassUniform: ['composite', 'uBloomFloor', f] },
    description: `Band body with the bloom floor at ${f}.`,
  });
}
