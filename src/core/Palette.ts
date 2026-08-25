import { Color } from 'three';

/**
 * INK TIDE — the one committed palette.
 *
 * Every surface in the game pulls its colour from here: water bands, sky bands,
 * hull paint, ink lines, foam, UI. Nothing is allowed to invent a colour locally.
 * The set is deliberately small and high-saturation so the frame reads as printed
 * anime cel art rather than a lit 3D scene.
 *
 * Hues are grouped in three families so any two colours in the frame are either
 * harmonious (same family) or a deliberate clash (accent against water):
 *   - OCEAN family : indigo -> cyan, carries most of the screen
 *   - SKY family   : cobalt -> warm sand, sits behind everything
 *   - ACCENT family: green racing line + four racer paints, used sparingly
 */

const hex = (h: number) => new Color().setHex(h, 'srgb');

export const PALETTE = {
  /** Deep-toned ink used for every outline. Never pure black — pure black kills the palette. */
  ink: hex(0x0a1226),
  inkSoft: hex(0x16294a),

  // ---- Ocean bands (hard steps, no gradient between them) ----
  waterDeep: hex(0x0a2f63),
  waterMid: hex(0x1470c4),
  waterShallow: hex(0x39a9de),
  waterCrest: hex(0x6fe0ef),
  foam: hex(0xeefaff),
  foamShade: hex(0xb7e6f7),
  /**
   * What distant water fades into. Distinct from `skyHorizon`: hazing the
   * ocean towards the sky's warm sand turns the whole band above the waterline
   * into a desert strip, which is the single most damaging thing that can
   * happen to a frame that is 60% water. Water recedes into pale cyan.
   */
  waterHaze: hex(0x8fd2ea),

  // ---- Sky ----
  skyZenith: hex(0x0f4fae),
  skyHigh: hex(0x2f8fd8),
  skyMid: hex(0x7fd0ee),
  skyHorizon: hex(0xffd98a),
  skyHaze: hex(0xffeec4),
  sun: hex(0xfff8d4),
  sunCore: hex(0xffffff),
  cloudLit: hex(0xffffff),
  cloudMid: hex(0xd9ecfb),
  cloudShade: hex(0x9dc6e8),

  // ---- Accents ----
  racingLine: hex(0x39ff9c),
  racingLineDim: hex(0x11916a),
  gateGlow: hex(0x4dffd0),
  warn: hex(0xff4d4d),

  // ---- Racer paints (index 0 is the player) ----
  racer: [hex(0xff2e63), hex(0xff9d1c), hex(0x8b5cff), hex(0xc4f52e)],
  racerDark: [hex(0x8f1436), hex(0x8f4f06), hex(0x452a99), hex(0x6c8a12)],

  // ---- Rider palette ----
  //
  // The suit tones are deliberately much lighter than a "navy racing suit"
  // instinct suggests. The cel ramp multiplies the base colour by 0.34 in its
  // shadow band, so a genuinely dark base lands below the point where the bands
  // are distinguishable and the rider renders as a black blob against the
  // water. Captured frames settled these at a mid slate: dark enough to read as
  // a suit, light enough that all four bands are visible on a 1.7 m character
  // that is only a couple of hundred pixels tall.
  skin: hex(0xffd2a8),
  skinShade: hex(0xd99a68),
  suit: hex(0x4a6ba3),
  suitLit: hex(0x82a8dc),
  visor: hex(0x59f0ff),

  // ---- UI ----
  uiInk: hex(0x0a1226),
  uiFoam: hex(0xeefaff),
  uiCyan: hex(0x8ff4ff),
  uiAmber: hex(0xffc94d),
  uiDanger: hex(0xff4d6d),
} as const;

/** CSS strings for the DOM/canvas HUD so UI and 3D never drift apart. */
export const CSS = {
  ink: '#0a1226',
  inkSoft: '#16294a',
  foam: '#eefaff',
  cyan: '#8ff4ff',
  amber: '#ffc94d',
  green: '#39ff9c',
  danger: '#ff4d6d',
  racer: ['#ff2e63', '#ff9d1c', '#8b5cff', '#c4f52e'],
  waterMid: '#1470c4',
  waterDeep: '#0a2f63',
} as const;

/** Global fog/haze tint used to fade distant geometry into the sky band. */
export const HAZE = PALETTE.skyMid;

/** Key light direction (points *from* the sun *towards* the scene origin). */
export const SUN_DIR = { x: -0.42, y: 0.62, z: 0.66 };
