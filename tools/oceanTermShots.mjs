/**
 * OCEAN TERM ISOLATION.
 *
 * Follows the water's colour along the shading chain, and then along the POST
 * chain, to find where its deep tone rotates 24 degrees off waterDeep.
 *
 * The band body should draw mix(uDeep, uMid, 0.1), which through the grade is
 * rgb(0,46,97). It draws rgb(9,85,101): the value is right, the blue is right,
 * and the green is nearly double. An analytic model of the grade reproduces the
 * finished frame from an assumed input but cannot reproduce this one from the
 * known palette input, so a step in the real pipeline is missing from the
 * model. Bloom is the only term the model omits, hence the last two shots.
 */
export const SHOT_GROUPS = { dbg: 'Ocean term isolation on the water-02 framing' };
const cam = { mode: 'free', position: [600, 5.2, 600], target: [600, 0.5, 545] };
const at = (id, setup, description) => ({
  id, group: 'dbg', time: 12.0, camera: cam, setup, description,
});
export const SHOTS = [
  at('dbg-0-final',   { setOceanUniform: ['uDebug', 0] }, 'Finished water.'),
  at('dbg-4-bands',   { setOceanUniform: ['uDebug', 4] }, 'The four-tone body alone.'),
  at('dbg-5-prefoam', { setOceanUniform: ['uDebug', 5] }, 'Body plus sun plane, lift, contour.'),
  at('dbg-4-nobloom', { setOceanUniform: ['uDebug', 4],
                        setPassUniform: ['composite', 'uBloomStrength', 0] },
     'The body again with bloom off. If the green excess goes, bloom owns it.'),
];
