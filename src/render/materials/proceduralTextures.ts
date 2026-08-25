import {
  CanvasTexture,
  Color,
  DataTexture,
  LinearFilter,
  NearestFilter,
  NoColorSpace,
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
 * Headroom factor for ramp textures.
 *
 * The lit band has to be *brighter* than the paint colour or a sunlit plane can
 * never be lighter than the same plane in ambient, and an 8-bit unorm texture
 * cannot store a value above 1. So the whole ramp is divided by this on the way
 * into the texture and multiplied by it again in `celShade`.
 *
 * This exists because the first shipped version simply wrote `1.14 * 255` into
 * a `Uint8Array`, which silently wraps at 256 and turned the *brightest* band
 * of every ramp in the game into rgb(31,30,22). Every surface's sun-facing side
 * came out near-black, which is what the "muddy maroon mass" defect actually
 * was — not a threshold problem at all.
 */
export const CEL_RAMP_SCALE = 1.25;

/**
 * Build a 1D stepped lighting ramp as a WIDTHx1 texture with NearestFilter.
 *
 * The thresholds are the whole ballgame. Bands placed at even intervals read as
 * a posterisation filter; bands weighted towards the terminator (a wide lit
 * band, a narrow mid, a broad shadow) read as hand-painted cel art. Every call
 * site below uses the weighted spacing.
 *
 * The ramp is stored with NO colour space. It is a multiplier, not a colour: an
 * sRGB-tagged texture is decoded on sample, so a nominal 0.34 shadow arrives in
 * the shader as 0.09 and every shadow in the game is four times too dark.
 */
export function makeRampTexture(stops: RampStop[], width = 64): DataTexture {
  const data = new Uint8Array(width * 4);
  const sorted = [...stops].sort((a, b) => a.at - b.at);
  // Clamp, not truncate. See CEL_RAMP_SCALE.
  const byte = (v: number) => Math.max(0, Math.min(255, Math.round((v / CEL_RAMP_SCALE) * 255)));

  for (let i = 0; i < width; i++) {
    const u = (i + 0.5) / width;
    let c = sorted[0].color;
    for (let s = 0; s < sorted.length; s++) {
      if (u >= sorted[s].at) c = sorted[s].color;
    }
    data[i * 4 + 0] = byte(c.r);
    data[i * 4 + 1] = byte(c.g);
    data[i * 4 + 2] = byte(c.b);
    data[i * 4 + 3] = 255;
  }

  const tex = new DataTexture(data, width, 1, RGBAFormat, UnsignedByteType);
  tex.magFilter = NearestFilter;
  tex.minFilter = NearestFilter;
  tex.generateMipmaps = false;
  tex.wrapS = ClampToEdgeWrapping;
  tex.wrapT = ClampToEdgeWrapping;
  tex.colorSpace = NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * The default 4-band ramp used by hulls, riders and props.
 *
 * The thresholds are in *wrapped* N·L, i.e. `ndl * (1 - uAmbientWrap/2) +
 * uAmbientWrap/2`. With the shipped `uAmbientWrap = 0.55` they land at
 * N·L = -0.16, 0.26 and 0.73, which for the shipped sun direction covers these
 * fractions of a sphere's *screen* area — the only measure that matters, since
 * that is what a critic actually looks at:
 *
 *   LIT     30%  N·L > 0.73    the carved sun-facing shape
 *   BASE    38%  0.26 .. 0.73  the paint colour, deliberately the largest band
 *   SHADOW  22%  -0.16 .. 0.26 the crescent that gives the form its weight
 *   CORE    10%  N·L < -0.16   a sliver at the far edge, an accent not a mass
 *
 * The previous set put 46% of the surface in the core band, which is why the
 * red sphere read as one dark mass with a lit sliver instead of a lit form with
 * a shadow. The rule of thumb that came out of the capture rounds: the paint
 * colour and the lit band together must own at least two thirds of a convex
 * object, or the object stops reading as its own colour.
 */
export const CEL_BANDS = [0.0, 0.17, 0.46, 0.8] as const;

/**
 * Multipliers applied to a surface's base colour at each band, in linear light.
 *
 * The core is 0.3 rather than the 0.1-ish the old sRGB-tagged ramp effectively
 * produced: below about 0.25 a saturated paint loses its hue entirely and every
 * object's shadow converges on the same near-black, which kills the palette.
 * The lit band is above 1 on purpose — see CEL_RAMP_SCALE.
 */
export const CEL_BAND_SHADE = [0.3, 0.52, 0.82, 1.18] as const;

/** Per-band pull towards the sky (cool fill) and the sun (warm key). */
const CEL_BAND_COOL = [0.2, 0.12, 0.03, 0.0] as const;
const CEL_BAND_WARM = [0.0, 0.0, 0.03, 0.1] as const;

export function makeCelRamp(tint: Color = new Color(1, 1, 1)): DataTexture {
  // Shadows carry sky colour and lights carry sun colour. A flat multiply down
  // the value axis is what makes cel shading look like a posterise filter; the
  // temperature split is what makes it look painted.
  const cool = PALETTE.skyHigh;
  const warm = PALETTE.sun;
  const stops: RampStop[] = CEL_BANDS.map((at, i) => {
    const c = tint.clone().multiplyScalar(CEL_BAND_SHADE[i]);
    c.lerp(cool, CEL_BAND_COOL[i]);
    c.lerp(warm, CEL_BAND_WARM[i]);
    return { at, color: c };
  });
  return makeRampTexture(stops, 64);
}

// ---------------------------------------------------------------------------
// Matcap — the fake environment reflection. Never a cubemap probe.
// ---------------------------------------------------------------------------

/**
 * Paint the fake environment reflection on a 2D canvas: hard-edged value steps
 * from a bright sky above to a dark water bounce below, plus one crisp
 * highlight wedge. Quantised into flat regions rather than rendered as a smooth
 * sphere, so it stays graphic when applied to a curved hull.
 *
 * This is deliberately **almost achromatic**. The first version painted the
 * actual sky and water palette entries at full chroma and multiplied the result
 * by the surface colour, which put a different hue on every face of a faceted
 * object: a near-white icosahedron came out with brown and navy facets, because
 * each facet's normal landed in a different band of a strongly coloured disc.
 * A matcap's job here is to add *value structure* — where a surface catches the
 * sky and where it catches the water — and value structure is exactly what
 * survives being desaturated. The residual 18% chroma is enough to keep the
 * upper hemisphere reading cool and the lower reading warm.
 */
export function makeCelMatcap(size = 256): CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const g = cv.getContext('2d')!;
  const r = size / 2;

  // Outside the disc is mid-grey, not black: `vn.xy * 0.48` can land a fragment
  // in the last texel before the edge, and a black fringe there reads as a
  // second, wrong-coloured outline just inside the ink.
  g.fillStyle = '#6a6a6a';
  g.fillRect(0, 0, size, size);

  g.save();
  g.beginPath();
  g.arc(r, r, r, 0, Math.PI * 2);
  g.clip();

  // Value steps. The numbers are luminances, tinted only slightly.
  const bands: Array<[number, Color, number]> = [
    [0.0, PALETTE.skyHigh, 1.0],
    [0.3, PALETTE.skyMid, 0.82],
    [0.48, PALETTE.skyHaze, 0.66],
    [0.55, PALETTE.waterShallow, 0.5],
    [0.74, PALETTE.waterMid, 0.36],
    [1.0, PALETTE.waterDeep, 0.26],
  ];
  for (let i = 0; i < bands.length; i++) {
    const y0 = bands[i][0] * size;
    const y1 = (i + 1 < bands.length ? bands[i + 1][0] : 1) * size;
    g.fillStyle = css(desaturate(bands[i][1], 0.18, bands[i][2]));
    g.fillRect(0, y0, size, y1 - y0 + 1);
  }

  // The highlight. A wedge rather than a disc: a circle inside a circle reads
  // as a soft dot the moment the object curves, a chord-cut shape keeps a
  // drawn edge. Positioned up-left to agree with the sun.
  g.fillStyle = '#ffffff';
  g.beginPath();
  g.ellipse(size * 0.33, size * 0.26, size * 0.155, size * 0.1, -0.5, 0, Math.PI * 2);
  g.fill();
  // The anime satellite highlight, offset rather than concentric.
  g.beginPath();
  g.ellipse(size * 0.56, size * 0.13, size * 0.055, size * 0.035, -0.35, 0, Math.PI * 2);
  g.fill();

  // Rim band at the silhouette edge — a fresnel baked into the reflection, so
  // even surfaces with the shader rim turned off still catch their own edge.
  g.strokeStyle = css(desaturate(PALETTE.skyHaze, 0.18, 0.95));
  g.lineWidth = size * 0.05;
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

/** Pull a palette colour towards its own luminance and rescale its value. */
function desaturate(c: Color, keepChroma: number, value: number): Color {
  const l = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  return new Color(l, l, l).lerp(c, keepChroma).multiplyScalar(value / Math.max(l, 1e-4));
}
