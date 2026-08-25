import {
  CanvasTexture,
  Color,
  DataTexture,
  LinearFilter,
  NearestFilter,
  RGBAFormat,
  RepeatWrapping,
  ClampToEdgeWrapping,
  SRGBColorSpace,
  UnsignedByteType,
  type Texture,
} from 'three';
import { PALETTE } from '../../core/Palette.ts';

/**
 * Every texture in Ink Tide is generated here. Nothing is loaded from disk.
 *
 * Two rules govern the generators:
 *  1. Anything that drives *lighting* is NearestFilter. Bilinear filtering on a
 *     3-band ramp reintroduces the smooth falloff we are trying to destroy.
 *  2. Anything that drives *surface detail* (noise, ink grain) is linear and
 *     tileable, because those are sampled at arbitrary UVs.
 */

// ---------------------------------------------------------------------------
// Lighting ramps
// ---------------------------------------------------------------------------

export interface RampStop {
  /** 0..1 position of the *start* of this band along N·L. */
  at: number;
  color: Color;
}

/**
 * Build a 1D stepped lighting ramp as a WIDTHx1 texture with NearestFilter.
 *
 * The thresholds are the whole ballgame. Bands placed at even intervals read as
 * a posterisation filter; bands weighted towards the terminator (a wide lit
 * band, a narrow mid, a broad shadow) read as hand-painted cel art. Every call
 * site below uses the weighted spacing.
 */
export function makeRampTexture(stops: RampStop[], width = 64): DataTexture {
  const data = new Uint8Array(width * 4);
  const sorted = [...stops].sort((a, b) => a.at - b.at);

  for (let i = 0; i < width; i++) {
    const u = (i + 0.5) / width;
    let c = sorted[0].color;
    for (let s = 0; s < sorted.length; s++) {
      if (u >= sorted[s].at) c = sorted[s].color;
    }
    data[i * 4 + 0] = Math.round(c.r * 255);
    data[i * 4 + 1] = Math.round(c.g * 255);
    data[i * 4 + 2] = Math.round(c.b * 255);
    data[i * 4 + 3] = 255;
  }

  const tex = new DataTexture(data, width, 1, RGBAFormat, UnsignedByteType);
  tex.magFilter = NearestFilter;
  tex.minFilter = NearestFilter;
  tex.generateMipmaps = false;
  tex.wrapS = ClampToEdgeWrapping;
  tex.wrapT = ClampToEdgeWrapping;
  tex.colorSpace = SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * The default 4-band ramp used by hulls, riders and props.
 *
 * Thresholds tuned by eye against captured frames:
 *   0.00 -> deep core shadow  (25% of the range: reads as solid ink-adjacent)
 *   0.26 -> shadow            (20%: the bounce-lit side)
 *   0.46 -> base              (26%: the paint colour, the largest readable band)
 *   0.72 -> lit               (28%: the sun-facing plane)
 * The terminator therefore lands at 0.46, biased into the shadow side, which is
 * what makes the lit shapes feel carved rather than blurred.
 */
export const CEL_BANDS = [0.0, 0.26, 0.46, 0.72] as const;

/** Multipliers applied to a surface's base colour at each band. */
export const CEL_BAND_SHADE = [0.34, 0.55, 0.86, 1.14] as const;

export function makeCelRamp(tint: Color = new Color(1, 1, 1)): DataTexture {
  // A slight hue shift towards the sky colour in shadow and towards the sun in
  // light — flat multiplication looks muddy, this keeps shadows alive.
  const cool = PALETTE.skyHigh;
  const warm = PALETTE.sun;
  const stops: RampStop[] = CEL_BANDS.map((at, i) => {
    const m = CEL_BAND_SHADE[i];
    const c = tint.clone().multiplyScalar(m);
    const t = i / (CEL_BANDS.length - 1);
    c.lerp(cool, (1 - t) * 0.22);
    c.lerp(warm, t * 0.1);
    return { at, color: c };
  });
  return makeRampTexture(stops, 64);
}

// ---------------------------------------------------------------------------
// Matcap — the fake environment reflection. Never a cubemap probe.
// ---------------------------------------------------------------------------

/**
 * Paint a matcap on a 2D canvas: a hard-edged sky wash in the upper hemisphere,
 * a warm bounce from the water below, and one crisp specular disc. Because it
 * is quantised into flat regions rather than a smooth sphere render, it stays
 * graphic when applied to curved hulls.
 */
export function makeCelMatcap(size = 256): CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const g = cv.getContext('2d')!;
  const r = size / 2;

  g.fillStyle = '#000000';
  g.fillRect(0, 0, size, size);

  // Base disc: horizon-split sky/water, hard edge between them.
  g.save();
  g.beginPath();
  g.arc(r, r, r, 0, Math.PI * 2);
  g.clip();

  const bands: Array<[number, string]> = [
    [0.0, css(PALETTE.skyHigh, 1.05)],
    [0.34, css(PALETTE.skyMid, 1.0)],
    [0.52, css(PALETTE.skyHaze, 0.95)],
    [0.58, css(PALETTE.waterShallow, 0.8)],
    [0.76, css(PALETTE.waterMid, 0.7)],
    [1.0, css(PALETTE.waterDeep, 0.6)],
  ];
  for (let i = 0; i < bands.length; i++) {
    const y0 = bands[i][0] * size;
    const y1 = (i + 1 < bands.length ? bands[i + 1][0] : 1) * size;
    g.fillStyle = bands[i][1];
    g.fillRect(0, y0, size, y1 - y0 + 1);
  }

  // Hard specular disc, upper-left, matching the sun direction.
  g.fillStyle = '#ffffff';
  g.beginPath();
  g.arc(size * 0.33, size * 0.27, size * 0.115, 0, Math.PI * 2);
  g.fill();
  // A second, smaller sparkle for that anime double-highlight.
  g.beginPath();
  g.arc(size * 0.52, size * 0.16, size * 0.045, 0, Math.PI * 2);
  g.fill();

  // Rim band at the silhouette edge — the fresnel baked into the matcap.
  g.strokeStyle = css(PALETTE.skyHaze, 1.0);
  g.lineWidth = size * 0.055;
  g.beginPath();
  g.arc(r, r, r - g.lineWidth * 0.5, 0, Math.PI * 2);
  g.stroke();

  g.restore();

  const tex = new CanvasTexture(cv);
  tex.colorSpace = SRGBColorSpace;
  tex.minFilter = LinearFilter;
  tex.magFilter = LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------
// Value noise — tileable, used for foam breakup and cloud shapes
// ---------------------------------------------------------------------------

function hash2(x: number, y: number, seed: number): number {
  let h = x * 374761393 + y * 668265263 + seed * 2147483647;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function smootherstep(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Tileable value noise sampled on a `period`-cell lattice. */
function valueNoise(x: number, y: number, period: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const wrap = (v: number) => ((v % period) + period) % period;
  const x0 = wrap(xi);
  const y0 = wrap(yi);
  const x1 = wrap(xi + 1);
  const y1 = wrap(yi + 1);
  const u = smootherstep(xf);
  const v = smootherstep(yf);
  const a = hash2(x0, y0, seed);
  const b = hash2(x1, y0, seed);
  const c = hash2(x0, y1, seed);
  const d = hash2(x1, y1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** Tileable fractal value noise as a single-channel-in-RGBA texture. */
export function makeNoiseTexture(size = 256, octaves = 5, basePeriod = 8, seed = 1): DataTexture {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let amp = 1;
      let sum = 0;
      let norm = 0;
      let period = basePeriod;
      for (let o = 0; o < octaves; o++) {
        const u = (x / size) * period;
        const v = (y / size) * period;
        sum += valueNoise(u, v, period, seed + o * 17) * amp;
        norm += amp;
        amp *= 0.5;
        period *= 2;
      }
      const n = Math.round((sum / norm) * 255);
      const i = (y * size + x) * 4;
      data[i] = n;
      data[i + 1] = n;
      data[i + 2] = n;
      data[i + 3] = 255;
    }
  }
  const tex = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType);
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.minFilter = LinearFilter;
  tex.magFilter = LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Four independent noise fields packed into RGBA. Sampling one texture instead
 * of four keeps the water fragment shader inside its texture-unit budget.
 *   R: broad foam breakup      G: fine foam speckle
 *   B: sparkle field           A: wake dissipation grain
 */
export function makePackedNoise(size = 256): DataTexture {
  const layers = [
    makeNoiseTexture(size, 4, 6, 11),
    makeNoiseTexture(size, 5, 16, 29),
    makeNoiseTexture(size, 3, 24, 53),
    makeNoiseTexture(size, 4, 10, 71),
  ];
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    data[i * 4 + 0] = (layers[0].image.data as Uint8Array)[i * 4];
    data[i * 4 + 1] = (layers[1].image.data as Uint8Array)[i * 4];
    data[i * 4 + 2] = (layers[2].image.data as Uint8Array)[i * 4];
    data[i * 4 + 3] = (layers[3].image.data as Uint8Array)[i * 4];
  }
  layers.forEach((l) => l.dispose());
  const tex = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType);
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.minFilter = LinearFilter;
  tex.magFilter = LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------
// Shared singletons
// ---------------------------------------------------------------------------

let _matcap: Texture | null = null;
export function celMatcap(): Texture {
  if (!_matcap) _matcap = makeCelMatcap(256);
  return _matcap;
}

let _packedNoise: Texture | null = null;
export function packedNoise(): Texture {
  if (!_packedNoise) _packedNoise = makePackedNoise(256);
  return _packedNoise;
}

let _defaultRamp: Texture | null = null;
export function defaultCelRamp(): Texture {
  if (!_defaultRamp) _defaultRamp = makeCelRamp();
  return _defaultRamp;
}

// ---------------------------------------------------------------------------

function css(c: Color, mul = 1): string {
  const r = Math.min(255, Math.round(c.r * 255 * mul));
  const g = Math.min(255, Math.round(c.g * 255 * mul));
  const b = Math.min(255, Math.round(c.b * 255 * mul));
  return `rgb(${r},${g},${b})`;
}
