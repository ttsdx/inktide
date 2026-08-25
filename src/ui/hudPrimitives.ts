import { CSS } from '../core/Palette.ts';

/**
 * HUD PRIMITIVES — the drawing vocabulary the whole interface is built from.
 *
 * The HUD is Canvas 2D rather than DOM because the art direction demands shapes
 * the box model cannot make cheaply: sheared parallelograms, chamfered corners,
 * segmented arcs, hard offset ink shadows and glyphs that are not a system font.
 * Doing that in DOM means a pile of `clip-path` strings and stacked pseudo
 * elements that all have to be re-measured on resize; here every panel is a
 * handful of `lineTo` calls against one immediate-mode surface.
 *
 * Two rules hold everywhere in this file:
 *
 *   1. Outlines are ink (`#0a1226`), never black, and never blurred. Depth comes
 *      from a *hard offset* copy of the silhouette, the way a printed cel gets
 *      its drop shadow — `ctx.shadowBlur` is never touched.
 *   2. Fills are flat. No `createLinearGradient` anywhere. A value that needs to
 *      read as "more" gets more *segments*, not more brightness, because stepped
 *      quantities survive being 18 px tall on a phone and gradients do not.
 */

export type Ctx2D = CanvasRenderingContext2D;

// ---------------------------------------------------------------------------
// Easing and animation helpers
// ---------------------------------------------------------------------------

export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** 0..1 remap of `v` between `a` and `b`, clamped. */
export const range01 = (a: number, b: number, v: number): number => clamp01((v - a) / (b - a || 1));

export const smoothstep = (t: number): number => {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
};

export const easeOutCubic = (t: number): number => 1 - Math.pow(1 - clamp01(t), 3);

export const easeInCubic = (t: number): number => Math.pow(clamp01(t), 3);

/** Overshoot ease used for panels sliding in — lands past the mark then settles. */
export const easeOutBack = (t: number, k = 1.7): number => {
  const x = clamp01(t) - 1;
  return 1 + (k + 1) * x * x * x + k * x * x;
};

/**
 * Frame-rate independent exponential approach.
 *
 * `current += (target - current) * rate * dt` is the usual one-liner and it is
 * wrong: at 30 fps it converges to a different place than at 144 fps. The
 * analytic form below lags by the same amount of *time* on every machine, which
 * matters because the HUD is judged next to a camera rig that already does this.
 */
export function approach(current: number, target: number, rate: number, dt: number): number {
  return target + (current - target) * Math.exp(-rate * dt);
}

/**
 * Deliberately underdamped 1-D spring.
 *
 * The speedometer uses this instead of `approach` because a needle that merely
 * lags feels like a filtered number, while one that *overshoots* a hard throttle
 * stab and settles back reads as a mechanical instrument with a mass on the end
 * of it. Zeta below 1 is the whole point; do not "fix" it to critical damping.
 *
 * Integrated in sub-steps so a 120 ms hitch cannot make the spring explode.
 */
export class Spring1 {
  value: number;
  velocity = 0;

  constructor(
    private omega: number,
    private zeta: number,
    value = 0,
  ) {
    this.value = value;
  }

  step(target: number, dt: number): number {
    const steps = Math.min(6, Math.max(1, Math.ceil(dt / 0.008)));
    const h = dt / steps;
    const w2 = this.omega * this.omega;
    const damp = 2 * this.zeta * this.omega;
    for (let i = 0; i < steps; i++) {
      const accel = -w2 * (this.value - target) - damp * this.velocity;
      this.velocity += accel * h;
      this.value += this.velocity * h;
    }
    return this.value;
  }

  snap(v: number): void {
    this.value = v;
    this.velocity = 0;
  }
}

/**
 * One-shot "punch" envelope for event feedback (position change, lap, boost full).
 *
 * A decaying cosine rather than a linear ramp-down: the sign flip means a scale
 * punch briefly goes *under* 1 before returning, which is what makes it read as
 * an impact instead of a fade.
 */
export class Punch {
  private t = Infinity;
  private strength = 0;

  constructor(
    private decay = 8.5,
    private freq = 21,
  ) {}

  trigger(strength = 1): void {
    // Never let a new hit be swallowed by a louder one still ringing.
    this.strength = Math.max(strength, this.value * 0.6);
    this.t = 0;
  }

  step(dt: number): void {
    if (this.t !== Infinity) this.t += dt;
  }

  /** Signed, starts at `strength`, rings out to 0. */
  get value(): number {
    if (this.t === Infinity || this.t > 2) return 0;
    return this.strength * Math.exp(-this.t * this.decay) * Math.cos(this.t * this.freq);
  }

  get active(): boolean {
    return this.t !== Infinity && this.t < 2;
  }
}

// ---------------------------------------------------------------------------
// Vector stroke font
// ---------------------------------------------------------------------------

/**
 * A hand-authored angular stroke font.
 *
 * Every glyph is a set of polylines on a 10-unit cap-height grid (y = 0 is the
 * cap line, y = 10 the baseline) with no curve segments at all — corners are
 * chamfered by straight cuts. Stroked thick with mitred joins and square caps
 * it reads as chunky display type, and one code path then draws the ink outline,
 * the coloured body and the hard shadow by stroking the same `Path2D` three
 * times at three widths.
 *
 * Why not `ctx.font`? Because whatever the system serves up for `sans-serif`
 * drags its own personality into a frame that is otherwise entirely hand-built,
 * and a real weight-900 condensed italic cannot be relied on to exist. A stroke
 * font is also trivially outline-able, which a text fill is not.
 */
interface Glyph {
  /** Advance width in grid units, before tracking. */
  readonly w: number;
  readonly strokes: readonly number[][];
}

const g = (w: number, ...strokes: number[][]): Glyph => ({ w, strokes });

/** Cap height of the grid the glyphs are authored on. */
const GLYPH_CAP = 10;

const GLYPHS: Readonly<Record<string, Glyph>> = {
  ' ': g(3.4),
  A: g(6, [0, 10, 2.15, 0, 3.85, 0, 6, 10], [1.35, 6.6, 4.65, 6.6]),
  B: g(
    6,
    [0, 0, 4.6, 0, 6, 1.4, 6, 3.3, 4.7, 4.7, 0, 4.7],
    [0, 4.7, 4.9, 4.7, 6, 5.9, 6, 8.6, 4.6, 10, 0, 10, 0, 0],
  ),
  C: g(6, [6, 1.7, 4.3, 0, 1.7, 0, 0, 1.7, 0, 8.3, 1.7, 10, 4.3, 10, 6, 8.3]),
  D: g(6, [0, 0, 4.1, 0, 6, 1.9, 6, 8.1, 4.1, 10, 0, 10, 0, 0]),
  E: g(5.6, [5.6, 0, 0, 0, 0, 10, 5.6, 10], [0, 4.9, 4.3, 4.9]),
  F: g(5.4, [5.4, 0, 0, 0, 0, 10], [0, 4.9, 4.2, 4.9]),
  G: g(6, [6, 1.7, 4.3, 0, 1.7, 0, 0, 1.7, 0, 8.3, 1.7, 10, 4.3, 10, 6, 8.3, 6, 5.4, 3.1, 5.4]),
  H: g(6, [0, 0, 0, 10], [6, 0, 6, 10], [0, 5, 6, 5]),
  I: g(4.2, [0.4, 0, 3.8, 0], [2.1, 0, 2.1, 10], [0.4, 10, 3.8, 10]),
  J: g(6, [6, 0, 6, 8.3, 4.3, 10, 1.7, 10, 0, 8.3, 0, 6.5]),
  K: g(6, [0, 0, 0, 10], [6, 0, 0.7, 5.5], [2.2, 4.2, 6, 10]),
  L: g(5.4, [0, 0, 0, 10, 5.4, 10]),
  M: g(6.8, [0, 10, 0, 0, 3.4, 4.6, 6.8, 0, 6.8, 10]),
  N: g(6, [0, 10, 0, 0, 6, 10, 6, 0]),
  O: g(6, [1.7, 0, 4.3, 0, 6, 1.7, 6, 8.3, 4.3, 10, 1.7, 10, 0, 8.3, 0, 1.7, 1.7, 0]),
  P: g(6, [0, 10, 0, 0, 4.6, 0, 6, 1.5, 6, 4.1, 4.6, 5.6, 0, 5.6]),
  Q: g(
    6,
    [1.7, 0, 4.3, 0, 6, 1.7, 6, 8.3, 4.3, 10, 1.7, 10, 0, 8.3, 0, 1.7, 1.7, 0],
    [3.4, 6.6, 6, 10.4],
  ),
  R: g(6, [0, 10, 0, 0, 4.6, 0, 6, 1.5, 6, 4.1, 4.6, 5.6, 0, 5.6], [2.7, 5.6, 6, 10]),
  S: g(6, [
    6, 1.5, 4.3, 0, 1.6, 0, 0, 1.5, 0, 3.3, 1.4, 4.7, 4.6, 4.7, 6, 6.1, 6, 8.5, 4.4, 10, 1.7, 10,
    0, 8.5,
  ]),
  T: g(5.8, [0, 0, 5.8, 0], [2.9, 0, 2.9, 10]),
  U: g(6, [0, 0, 0, 8.3, 1.7, 10, 4.3, 10, 6, 8.3, 6, 0]),
  V: g(6, [0, 0, 3, 10, 6, 0]),
  W: g(7.2, [0, 0, 1.55, 10, 3.6, 4.4, 5.65, 10, 7.2, 0]),
  X: g(6, [0, 0, 6, 10], [6, 0, 0, 10]),
  Y: g(6, [0, 0, 3, 5.2, 6, 0], [3, 5.2, 3, 10]),
  Z: g(6, [0, 0, 6, 0, 0, 10, 6, 10]),

  // Digits share the letter grid so mixed strings ("LAP 2/3") sit on one rhythm.
  // Zero carries a slash: at speedometer size an unslashed O/0 pair is ambiguous.
  '0': g(
    6,
    [1.5, 0, 4.5, 0, 6, 1.5, 6, 8.5, 4.5, 10, 1.5, 10, 0, 8.5, 0, 1.5, 1.5, 0],
    [1.1, 8.4, 4.9, 1.6],
  ),
  '1': g(4.8, [0.2, 2.4, 2.6, 0, 2.6, 10], [0.2, 10, 4.8, 10]),
  '2': g(6, [0, 1.6, 1.6, 0, 4.4, 0, 6, 1.6, 6, 3.3, 0.2, 10, 6, 10]),
  '3': g(6, [0, 0, 6, 0, 2.9, 4.3], [2.9, 4.3, 4.7, 4.3, 6, 5.6, 6, 8.6, 4.5, 10, 1.4, 10, 0, 8.6]),
  '4': g(6, [4.4, 0, 0, 6.7, 6, 6.7], [4.4, 0, 4.4, 10]),
  '5': g(6, [6, 0, 0, 0, 0, 4.4, 4.6, 4.4, 6, 5.8, 6, 8.6, 4.5, 10, 1.4, 10, 0, 8.6]),
  '6': g(6, [6, 1.4, 4.5, 0, 1.5, 0, 0, 1.6, 0, 8.5, 1.5, 10, 4.5, 10, 6, 8.5, 6, 6.4, 4.6, 5, 0, 5]),
  '7': g(6, [0, 0, 6, 0, 2.3, 10]),
  '8': g(
    6,
    [1.5, 0, 4.5, 0, 6, 1.5, 6, 8.5, 4.5, 10, 1.5, 10, 0, 8.5, 0, 1.5, 1.5, 0],
    [0.4, 4.9, 5.6, 4.9],
  ),
  '9': g(6, [0, 8.6, 1.5, 10, 4.5, 10, 6, 8.4, 6, 1.6, 4.5, 0, 1.5, 0, 0, 1.6, 0, 3.6, 1.4, 5, 6, 5]),

  // Punctuation. Dots are zero-ish length strokes squared off by the line cap.
  '.': g(2.6, [1.3, 9.6, 1.3, 10]),
  ',': g(2.6, [1.4, 9.3, 0.6, 11.2]),
  ':': g(2.6, [1.3, 3.1, 1.3, 3.9], [1.3, 7.1, 1.3, 7.9]),
  '-': g(5, [0.4, 5, 4.6, 5]),
  '+': g(6, [3, 1.8, 3, 8.2], [0.2, 5, 5.8, 5]),
  '=': g(5.4, [0.3, 3.6, 5.1, 3.6], [0.3, 6.4, 5.1, 6.4]),
  '/': g(5.4, [0, 10, 5.4, 0]),
  '!': g(2.8, [1.4, 0, 1.4, 6.6], [1.4, 9.2, 1.4, 10]),
  '?': g(6, [0, 1.6, 1.6, 0, 4.4, 0, 6, 1.6, 6, 3.2, 3, 5, 3, 6.6], [3, 9.2, 3, 10]),
  "'": g(2.6, [1.3, 0, 1.3, 2.4]),
  '(': g(4, [3.6, 0, 1, 2.4, 1, 7.6, 3.6, 10]),
  ')': g(4, [0.4, 0, 3, 2.4, 3, 7.6, 0.4, 10]),
  '<': g(5, [4, 2, 0.6, 5, 4, 8]),
  '>': g(5, [1, 2, 4.4, 5, 1, 8]),
  '*': g(5, [2.5, 1, 2.5, 6], [0.3, 2.2, 4.7, 5.2], [4.7, 2.2, 0.3, 5.2]),
};

export interface TextStyle {
  /** Cap height in device-independent pixels. */
  size: number;
  /** Colour of the glyph body. */
  fill: string;
  /** Outline colour. Defaults to ink. Pass `'none'` to skip the outline pass. */
  ink?: string;
  /** Body stroke width as a fraction of cap height. */
  weight?: number;
  /** Half-width of the ink outline added around the body, as a fraction of cap height. */
  outline?: number;
  align?: 'left' | 'center' | 'right';
  /** `cap` puts y at the cap line (the default), `middle` centres, `baseline` sits on it. */
  baseline?: 'cap' | 'middle' | 'baseline';
  /** Shear in grid units per cap height. Positive leans the top to the right. */
  slant?: number;
  /** Extra advance between glyphs, in grid units. */
  tracking?: number;
  /** Hard offset ink shadow distance in pixels. 0 disables. */
  shadow?: number;
  alpha?: number;
}

const DEFAULT_SLANT = 0.2;
const DEFAULT_TRACKING = 1.15;

/** Advance width of `text` in pixels at `size`. */
export function measureText(text: string, size: number, tracking = DEFAULT_TRACKING): number {
  const u = size / GLYPH_CAP;
  let adv = 0;
  const s = text.toUpperCase();
  for (let i = 0; i < s.length; i++) {
    const glyph = GLYPHS[s[i]] ?? GLYPHS[' '];
    adv += glyph.w + tracking;
  }
  return Math.max(0, adv - tracking) * u;
}

/**
 * Build the polyline path for a string.
 *
 * The shear is taken about mid cap height rather than the baseline so that the
 * glyph's horizontal centre of mass does not move with `slant` — otherwise every
 * centred label would drift sideways whenever the slant was tuned.
 */
export function textPath(text: string, x: number, y: number, st: TextStyle): Path2D {
  const size = st.size;
  const u = size / GLYPH_CAP;
  const tracking = st.tracking ?? DEFAULT_TRACKING;
  const slant = st.slant ?? DEFAULT_SLANT;
  const width = measureText(text, size, tracking);

  let ox = x;
  if (st.align === 'center') ox = x - width / 2;
  else if (st.align === 'right') ox = x - width;

  let oy = y;
  if (st.baseline === 'middle') oy = y - size / 2;
  else if (st.baseline === 'baseline') oy = y - size;

  const path = new Path2D();
  const s = text.toUpperCase();
  let adv = 0;
  for (let i = 0; i < s.length; i++) {
    const glyph = GLYPHS[s[i]] ?? GLYPHS[' '];
    for (const stroke of glyph.strokes) {
      for (let k = 0; k < stroke.length; k += 2) {
        const gx = stroke[k];
        const gy = stroke[k + 1];
        const px = ox + (adv + gx + slant * (GLYPH_CAP * 0.5 - gy)) * u;
        const py = oy + gy * u;
        if (k === 0) path.moveTo(px, py);
        else path.lineTo(px, py);
      }
    }
    adv += glyph.w + tracking;
  }
  return path;
}

/** Draw a string: hard ink shadow, then ink outline, then coloured body. */
export function drawText(c: Ctx2D, text: string, x: number, y: number, st: TextStyle): void {
  if (!text) return;
  const path = textPath(text, x, y, st);
  const body = st.size * (st.weight ?? 0.17);
  const outline = st.size * (st.outline ?? 0.1);
  const ink = st.ink ?? CSS.ink;

  c.save();
  if (st.alpha !== undefined) c.globalAlpha *= clamp01(st.alpha);
  c.lineJoin = 'miter';
  c.miterLimit = 2.4;
  c.lineCap = 'square';

  const shadow = st.shadow ?? 0;
  if (shadow > 0) {
    c.save();
    c.translate(shadow, shadow);
    c.strokeStyle = ink;
    c.lineWidth = body + outline * 2;
    c.stroke(path);
    c.restore();
  }
  if (ink !== 'none' && outline > 0) {
    c.strokeStyle = ink;
    c.lineWidth = body + outline * 2;
    c.stroke(path);
  }
  c.strokeStyle = st.fill;
  c.lineWidth = body;
  c.stroke(path);
  c.restore();
}

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

export interface PanelStyle {
  /** Flat fill. Omit for an outline-only frame. */
  fill?: string;
  ink?: string;
  /** Outline width in px. 0 disables the outline. */
  line?: number;
  /** Horizontal lean of the top edge, in px. Positive leans right. */
  slant?: number;
  /** Chamfer length in px, cut from the top-left and bottom-right corners. */
  cut?: number;
  /** Hard offset ink shadow distance in px. */
  shadow?: number;
  alpha?: number;
  /** Accent bar along the leading (left) edge — the cluster's colour code. */
  stripe?: string;
  stripeWidth?: number;
}

/**
 * Sheared, corner-cut panel silhouette.
 *
 * Cutting only two *opposite* corners (rather than all four) is what keeps the
 * shape from reading as a rounded-rect: the panel gains a direction, and a row
 * of them reads as motion in that direction.
 */
export function panelPath(
  x: number,
  y: number,
  w: number,
  h: number,
  slant = 0,
  cut = 0,
): Path2D {
  const p = new Path2D();
  const k = Math.min(cut, w * 0.45, h * 0.45);
  p.moveTo(x + slant + k, y);
  p.lineTo(x + slant + w, y);
  if (k > 0) {
    p.lineTo(x + w, y + h - k);
    p.lineTo(x + w - k, y + h);
  } else {
    p.lineTo(x + w, y + h);
  }
  p.lineTo(x, y + h);
  p.lineTo(x + slant * (1 - k / h), y + k);
  p.closePath();
  return p;
}

export function panel(c: Ctx2D, x: number, y: number, w: number, h: number, st: PanelStyle): void {
  const slant = st.slant ?? 0;
  const cut = st.cut ?? Math.min(h * 0.34, 16);
  const path = panelPath(x, y, w, h, slant, cut);
  const ink = st.ink ?? CSS.ink;
  const line = st.line ?? 3;

  c.save();
  if (st.alpha !== undefined) c.globalAlpha *= clamp01(st.alpha);
  if (st.shadow) {
    c.save();
    c.translate(st.shadow, st.shadow);
    c.fillStyle = ink;
    c.fill(path);
    c.restore();
  }
  if (st.fill) {
    c.fillStyle = st.fill;
    c.fill(path);
  }
  if (st.stripe) {
    // Clip to the silhouette so the stripe inherits the shear and the chamfer
    // instead of poking out of the corner cuts.
    c.save();
    c.clip(path);
    const sw = st.stripeWidth ?? 6;
    c.fillStyle = st.stripe;
    c.fill(panelPath(x, y, sw + Math.abs(slant), h, slant, 0));
    c.restore();
  }
  if (line > 0) {
    c.lineJoin = 'miter';
    c.miterLimit = 3;
    c.lineWidth = line;
    c.strokeStyle = ink;
    c.stroke(path);
  }
  c.restore();
}

/** Thin diagonal hatch, used to make "empty" regions of a bar read as inert. */
export function hatch(
  c: Ctx2D,
  clipPath: Path2D,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string,
  spacing = 9,
  width = 2,
): void {
  c.save();
  c.clip(clipPath);
  c.strokeStyle = color;
  c.lineWidth = width;
  c.beginPath();
  for (let i = -h; i < w + h; i += spacing) {
    c.moveTo(x + i, y + h);
    c.lineTo(x + i + h, y);
  }
  c.stroke();
  c.restore();
}

// ---------------------------------------------------------------------------
// Bars and gauges
// ---------------------------------------------------------------------------

export interface BarStyle {
  /** 0..1 */
  value: number;
  segments: number;
  /** Lit segment colour. */
  fill: string;
  /** Unlit segment colour. */
  empty?: string;
  ink?: string;
  /** Lean of each segment, px. */
  slant?: number;
  /** Gap between segments, px. */
  gap?: number;
  /** 0..1 white-hot overlay on lit segments (used for the full-boost flash). */
  flash?: number;
  /** Colour for segments beyond `hotFrom` — the top of the range. */
  hot?: string;
  /** 0..1 fraction of the bar after which `hot` replaces `fill`. */
  hotFrom?: number;
  line?: number;
  /** Draw the leading partial segment at proportional alpha for a smooth read. */
  partial?: boolean;
}

/**
 * Segmented horizontal bar.
 *
 * Quantised on purpose: a continuous fill has to be *compared* against its track
 * to be read, while counting lit blocks is pre-attentive. The boost meter is a
 * core mechanic the player checks with peripheral vision mid-corner, so it gets
 * chunky low-count segments rather than a smooth ramp.
 */
export function segmentedBar(
  c: Ctx2D,
  x: number,
  y: number,
  w: number,
  h: number,
  st: BarStyle,
): void {
  const n = Math.max(1, Math.floor(st.segments));
  const gap = st.gap ?? 3;
  const slant = st.slant ?? h * 0.34;
  const segW = (w - gap * (n - 1) - Math.abs(slant)) / n;
  const ink = st.ink ?? CSS.ink;
  const empty = st.empty ?? CSS.inkSoft;
  const value = clamp01(st.value);
  const hotFrom = st.hotFrom ?? 1.1;

  c.save();
  c.lineJoin = 'miter';
  c.miterLimit = 3;
  for (let i = 0; i < n; i++) {
    const t0 = i / n;
    const t1 = (i + 1) / n;
    const sx = x + i * (segW + gap);
    const path = panelPath(sx, y, segW, h, slant, 0);
    let lit = value >= t1 ? 1 : value > t0 ? (value - t0) / (t1 - t0) : 0;
    if (!st.partial) lit = lit > 0.34 ? 1 : 0;

    c.fillStyle = empty;
    c.fill(path);
    if (lit > 0) {
      c.save();
      c.globalAlpha *= lit < 1 ? 0.35 + lit * 0.65 : 1;
      c.fillStyle = t0 >= hotFrom ? (st.hot ?? st.fill) : st.fill;
      c.fill(path);
      if (st.flash) {
        c.globalAlpha *= clamp01(st.flash);
        c.fillStyle = CSS.foam;
        c.fill(path);
      }
      c.restore();
    }
    if ((st.line ?? 2) > 0) {
      c.lineWidth = st.line ?? 2;
      c.strokeStyle = ink;
      c.stroke(path);
    }
  }
  c.restore();
}

export interface ArcStyle {
  /** 0..1 */
  value: number;
  segments: number;
  fill: string;
  empty?: string;
  ink?: string;
  /** Colour used past `hotFrom`. */
  hot?: string;
  hotFrom?: number;
  /** 0..1 white overlay on lit ticks. */
  flash?: number;
  line?: number;
  /** Angular gap between ticks as a fraction of a tick's slice. */
  gapFrac?: number;
}

/**
 * Segmented arc gauge — the speedometer's ring of ticks.
 *
 * Each tick is a flat quad between two radii, not an arc segment, so the ring is
 * visibly faceted. That faceting is the point: it matches the hard-edged
 * geometry everywhere else in the frame, where a smooth swept arc would look
 * like a browser progress ring.
 */
export function segmentedArc(
  c: Ctx2D,
  cx: number,
  cy: number,
  rInner: number,
  rOuter: number,
  a0: number,
  a1: number,
  st: ArcStyle,
): void {
  const n = Math.max(1, Math.floor(st.segments));
  const span = a1 - a0;
  const slice = span / n;
  const gap = slice * (st.gapFrac ?? 0.22);
  const ink = st.ink ?? CSS.ink;
  const empty = st.empty ?? CSS.inkSoft;
  const value = clamp01(st.value);
  const hotFrom = st.hotFrom ?? 1.1;

  c.save();
  c.lineJoin = 'miter';
  c.miterLimit = 3;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    const b0 = a0 + slice * i + gap * 0.5;
    const b1 = a0 + slice * (i + 1) - gap * 0.5;
    // Longer ticks towards the top of the range gives the gauge a read even in
    // greyscale, which matters when the racer colour is close to the water blue.
    const ro = rOuter + (rOuter - rInner) * 0.42 * Math.pow(t, 2.2);
    const p = new Path2D();
    p.moveTo(cx + Math.cos(b0) * rInner, cy + Math.sin(b0) * rInner);
    p.lineTo(cx + Math.cos(b0) * ro, cy + Math.sin(b0) * ro);
    p.lineTo(cx + Math.cos(b1) * ro, cy + Math.sin(b1) * ro);
    p.lineTo(cx + Math.cos(b1) * rInner, cy + Math.sin(b1) * rInner);
    p.closePath();

    const lit = value > t + 0.5 / n;
    c.fillStyle = lit ? (t >= hotFrom ? (st.hot ?? st.fill) : st.fill) : empty;
    c.fill(p);
    if (lit && st.flash) {
      c.save();
      c.globalAlpha *= clamp01(st.flash);
      c.fillStyle = CSS.foam;
      c.fill(p);
      c.restore();
    }
    if ((st.line ?? 2) > 0) {
      c.lineWidth = st.line ?? 2;
      c.strokeStyle = ink;
      c.stroke(p);
    }
  }
  c.restore();
}

/** Chunky ink-outlined needle for the speedometer. */
export function needle(
  c: Ctx2D,
  cx: number,
  cy: number,
  angle: number,
  length: number,
  width: number,
  fill: string,
  ink = CSS.ink,
): void {
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  // Perpendicular, for the tapered body.
  const px = -sa;
  const py = ca;
  const p = new Path2D();
  p.moveTo(cx + ca * length, cy + sa * length);
  p.lineTo(cx + ca * length * 0.34 + px * width * 0.5, cy + sa * length * 0.34 + py * width * 0.5);
  p.lineTo(cx - ca * width * 0.9 + px * width * 0.34, cy - sa * width * 0.9 + py * width * 0.34);
  p.lineTo(cx - ca * width * 0.9 - px * width * 0.34, cy - sa * width * 0.9 - py * width * 0.34);
  p.lineTo(cx + ca * length * 0.34 - px * width * 0.5, cy + sa * length * 0.34 - py * width * 0.5);
  p.closePath();
  c.save();
  c.lineJoin = 'miter';
  c.miterLimit = 4;
  c.fillStyle = fill;
  c.fill(p);
  c.lineWidth = Math.max(1.5, width * 0.28);
  c.strokeStyle = ink;
  c.stroke(p);
  c.restore();
}

/** Solid ink-outlined chevron. `dir` is -1 for left, 1 for right. */
export function chevron(
  c: Ctx2D,
  cx: number,
  cy: number,
  size: number,
  dir: number,
  fill: string,
  alpha = 1,
  ink = CSS.ink,
): void {
  const t = size * 0.46;
  const p = new Path2D();
  p.moveTo(cx - dir * size * 0.5, cy - size);
  p.lineTo(cx + dir * size * 0.5, cy);
  p.lineTo(cx - dir * size * 0.5, cy + size);
  p.lineTo(cx - dir * size * 0.5 + dir * t, cy + size);
  p.lineTo(cx + dir * (size * 0.5 + t), cy);
  p.lineTo(cx - dir * size * 0.5 + dir * t, cy - size);
  p.closePath();
  c.save();
  c.globalAlpha *= clamp01(alpha);
  c.lineJoin = 'miter';
  c.miterLimit = 4;
  c.fillStyle = fill;
  c.fill(p);
  c.lineWidth = Math.max(2, size * 0.14);
  c.strokeStyle = ink;
  c.stroke(p);
  c.restore();
}

/** Small filled triangle — minimap heading arrow, gate direction marks. */
export function triangle(
  c: Ctx2D,
  cx: number,
  cy: number,
  angle: number,
  size: number,
  fill: string,
  ink?: string,
  line = 2,
): void {
  const p = new Path2D();
  for (let i = 0; i < 3; i++) {
    const a = angle + (i * Math.PI * 2) / 3;
    const r = i === 0 ? size : size * 0.72;
    const px = cx + Math.cos(a) * r;
    const py = cy + Math.sin(a) * r;
    if (i === 0) p.moveTo(px, py);
    else p.lineTo(px, py);
  }
  p.closePath();
  c.save();
  c.fillStyle = fill;
  c.fill(p);
  if (ink) {
    c.lineJoin = 'miter';
    c.lineWidth = line;
    c.strokeStyle = ink;
    c.stroke(p);
  }
  c.restore();
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** `83.412` -> `1:23.41`. Times under a minute drop the minute field. */
export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '--.--';
  const total = Math.floor(seconds * 100);
  const cs = total % 100;
  const s = Math.floor(total / 100) % 60;
  const m = Math.floor(total / 6000);
  const cc = cs < 10 ? `0${cs}` : `${cs}`;
  if (m > 0) return `${m}:${s < 10 ? '0' : ''}${s}.${cc}`;
  return `${s}.${cc}`;
}

/** Signed lap delta, always with an explicit sign so the eye finds it fast. */
export function formatDelta(seconds: number): string {
  const sign = seconds >= 0 ? '+' : '-';
  const a = Math.abs(seconds);
  const total = Math.floor(a * 100);
  const cs = total % 100;
  const s = Math.floor(total / 100);
  return `${sign}${s}.${cs < 10 ? '0' : ''}${cs}`;
}

const ORDINALS = ['TH', 'ST', 'ND', 'RD'];

/** Suffix only — the numeral is drawn separately at a much larger size. */
export function ordinalSuffix(n: number): string {
  const v = Math.abs(Math.floor(n));
  if (v % 100 >= 11 && v % 100 <= 13) return 'TH';
  return ORDINALS[v % 10] ?? 'TH';
}

/** Racer colour with a safe fallback — AI count is not this module's business. */
export function racerColor(index: number): string {
  return CSS.racer[((index % CSS.racer.length) + CSS.racer.length) % CSS.racer.length];
}
