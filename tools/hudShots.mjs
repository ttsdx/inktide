/**
 * HUD SHOTS
 *
 * These are the only shots captured through the page compositor rather than
 * straight off the WebGL canvas, because the HUD is a separate 2D canvas and a
 * DOM overlay sitting on top. `includeHud: true` switches the harness over.
 *
 * The interesting question here is not whether the HUD draws — it was verified
 * in isolation — but whether it survives contact with the actual game: does the
 * ink-on-foam contrast hold when the water behind it is near-white, do the
 * corner chevrons register, does the minimap match the real circuit.
 *
 *   node tools/capture.mjs --shotfile tools/hudShots.mjs --out shots/hud-01
 */

export const SHOT_GROUPS = { hud: 'HUD, minimap and screens over the live game' };

export const SHOTS = [
  {
    id: 'hud-01-countdown',
    group: 'hud',
    time: 1.2,
    includeHud: true,
    camera: { mode: 'chase' },
    description: 'Grid, countdown digits, HUD clusters sliding in.',
  },
  {
    id: 'hud-02-racing',
    group: 'hud',
    time: 20.0,
    includeHud: true,
    input: { throttle: 1 },
    camera: { mode: 'chase' },
    description: 'Full HUD at speed. The frame the player spends the race in.',
  },
  {
    id: 'hud-03-drift-boost',
    group: 'hud',
    time: 26.0,
    includeHud: true,
    input: { throttle: 1, steer: 1, drift: true },
    camera: { mode: 'chase' },
    description: 'Mid-powerslide: boost meter charging, drift bar live.',
  },
  {
    id: 'hud-04-over-foam',
    group: 'hud',
    time: 34.0,
    includeHud: true,
    input: { throttle: 1 },
    camera: { mode: 'onboard' },
    description: 'Bow camera, maximum white water behind the HUD. Contrast test.',
  },
  {
    id: 'hud-05-minimap-pack',
    group: 'hud',
    time: 48.0,
    includeHud: true,
    input: { throttle: 1 },
    camera: { mode: 'heli' },
    description: 'Minimap against a view where all four racers are placeable.',
  },
];
