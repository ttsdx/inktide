import { PALETTE, SUN_DIR } from '../core/Palette.ts';

/**
 * Shared GLSL building blocks.
 *
 * Everything in Ink Tide renders through a custom GLSL3 ShaderMaterial so that
 * (a) the cel lighting model is identical on every surface and (b) every
 * material can write the second MRT attachment the edge-detect pass reads.
 */

const f = (n: number) => (Number.isInteger(n) ? n.toFixed(1) : String(n));
export const glslVec3 = (c: { r: number; g: number; b: number }) =>
  `vec3(${f(c.r)}, ${f(c.g)}, ${f(c.b)})`;

/**
 * MRT declarations. Attachment 0 is the lit colour; attachment 1 packs the
 * view-space normal (xyz, encoded 0..1) and linear view depth (w, normalised by
 * the far plane) for the Sobel edge pass.
 */
export const MRT_OUTPUTS = /* glsl */ `
layout(location = 0) out vec4 outColor;
layout(location = 1) out vec4 outNormalDepth;

uniform float uCameraFar;
uniform float uCameraNear;

// Objects opt out of interior lines by writing a zero id in the alpha of the
// normal buffer's encoding slot; the Sobel pass treats matching ids as
// continuous surfaces so a hull does not get a line at every panel seam.
void writeNormalDepth(vec3 viewNormal, float viewDepth) {
  vec3 n = normalize(viewNormal) * 0.5 + 0.5;
  float d = clamp(viewDepth / uCameraFar, 0.0, 1.0);
  outNormalDepth = vec4(n, d);
}
`;

/** Constants shared by all cel surfaces. */
export const CEL_COMMON = /* glsl */ `
const vec3 SUN_DIR = normalize(vec3(${f(SUN_DIR.x)}, ${f(SUN_DIR.y)}, ${f(SUN_DIR.z)}));
const vec3 SUN_COLOR = ${glslVec3(PALETTE.sun)};
const vec3 SKY_COLOR = ${glslVec3(PALETTE.skyHigh)};
const vec3 HAZE_COLOR = ${glslVec3(PALETTE.skyMid)};
const vec3 HORIZON_COLOR = ${glslVec3(PALETTE.skyHorizon)};
const vec3 INK = ${glslVec3(PALETTE.ink)};

/** Hard quantisation with a *tiny* softening so 4K downsampling does not crawl. */
float bandStep(float edge, float x, float softness) {
  return smoothstep(edge - softness, edge + softness, x);
}

/** sRGB-ish luminance, used for keeping band shifts perceptually even. */
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

/** Cheap 2D hash for stipple/dither patterns. */
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
`;

/**
 * The cel lighting core.
 *
 * `celShade` returns the final surface colour for a diffuse-ish surface:
 *   1. N·L is remapped and pushed through the 3–4 band ramp texture (nearest
 *      filtered, so the bands are genuinely hard).
 *   2. A banded specular term adds one or two hard highlight *shapes* — the
 *      falloff is thresholded, never smooth.
 *   3. A matcap sample provides the fake environment reflection.
 *   4. A fresnel rim traces the silhouette with sky light so the object
 *      separates from the water behind it.
 *
 * There is deliberately no PBR term anywhere: no roughness, no metalness, no
 * IBL, no energy conservation. The output is paint, not physics.
 */
export const CEL_LIGHTING = /* glsl */ `
uniform sampler2D uRamp;
uniform sampler2D uMatcap;
uniform vec3 uBaseColor;
uniform vec3 uRimColor;
uniform float uRimPower;
uniform float uRimStrength;
uniform float uSpecStrength;
uniform float uSpecSize;
uniform float uMatcapStrength;
uniform float uShadeSoftness;
uniform float uAmbientWrap;

struct CelInput {
  vec3 normal;      // world-space unit normal
  vec3 viewDir;     // world-space unit vector from surface towards the camera
  vec3 baseColor;
  float ao;         // 0..1 baked occlusion / crevice darkening
  float shadow;     // 0..1, 1 = fully lit
};

vec3 celShade(CelInput s) {
  vec3 N = normalize(s.normal);
  vec3 V = normalize(s.viewDir);
  vec3 L = SUN_DIR;

  // --- 1. banded diffuse -------------------------------------------------
  // Half-lambert wrap lifts the terminator off the geometric horizon, which is
  // what stops the dark band from swallowing whole curved surfaces.
  float ndl = dot(N, L);
  float wrapped = mix(ndl, ndl * 0.5 + 0.5, uAmbientWrap);
  wrapped *= s.shadow;
  wrapped *= mix(0.72, 1.0, s.ao);

  vec3 ramp = texture(uRamp, vec2(clamp(wrapped, 0.001, 0.999), 0.5)).rgb;

  // The ramp carries the band *shape* and its colour temperature shift; the
  // surface's own paint colour is multiplied back in so one ramp serves every
  // object in the game.
  vec3 diffuse = s.baseColor * ramp * 1.72;

  // --- 2. banded specular ------------------------------------------------
  // A Blinn term thresholded into one hard shape, plus a second smaller shape
  // just inside it. Two discs read as drawn highlights; a smooth lobe reads as
  // plastic.
  vec3 H = normalize(L + V);
  float spec = pow(max(dot(N, H), 0.0), mix(220.0, 26.0, uSpecSize));
  float specA = bandStep(0.30, spec, uShadeSoftness * 0.6);
  float specB = bandStep(0.72, spec, uShadeSoftness * 0.4);
  vec3 specular = SUN_COLOR * (specA * 0.55 + specB * 0.65) * uSpecStrength * s.shadow;

  // --- 3. matcap fake reflection ----------------------------------------
  // View-space normal -> matcap UV. No probe, no cubemap: a painted disc.
  vec3 vn = normalize((viewMatrix * vec4(N, 0.0)).xyz);
  vec2 muv = vn.xy * 0.48 + 0.5;
  vec3 matcap = texture(uMatcap, muv).rgb;
  // Quantise the matcap too, otherwise it smuggles smooth shading back in.
  matcap = floor(matcap * 4.0 + 0.5) / 4.0;
  vec3 env = matcap * s.baseColor * uMatcapStrength;

  // --- 4. fresnel rim ----------------------------------------------------
  float fres = pow(1.0 - max(dot(N, V), 0.0), uRimPower);
  // Bias the rim towards the up/sky side so it reads as sky light catching the
  // edge rather than a uniform glow.
  float skyBias = mix(0.45, 1.0, clamp(N.y * 0.5 + 0.5, 0.0, 1.0));
  float rim = bandStep(0.52, fres, uShadeSoftness * 1.2) * skyBias;
  vec3 rimLight = uRimColor * rim * uRimStrength;

  return diffuse + specular + env + rimLight;
}
`;

/**
 * Stylised distance haze. Not exponential fog — a two-stop blend into the sky
 * band that keeps distant geometry graphic instead of grey.
 */
export const CEL_FOG = /* glsl */ `
uniform float uFogNear;
uniform float uFogFar;

vec3 applyCelHaze(vec3 color, float dist, vec3 viewDirWorld) {
  float t = clamp((dist - uFogNear) / max(uFogFar - uFogNear, 1.0), 0.0, 1.0);
  // Quantise the haze into 5 steps so distant objects sit on discrete planes,
  // like painted background layers.
  t = floor(t * 5.0 + 0.35) / 5.0;
  // Haze picks up horizon warmth low down and sky blue higher up.
  float h = clamp(viewDirWorld.y * 2.2 + 0.35, 0.0, 1.0);
  vec3 haze = mix(HORIZON_COLOR, HAZE_COLOR, h);
  return mix(color, haze, t * 0.92);
}
`;

/** Uniform block every cel material shares, as a plain object factory. */
export function celUniformDefaults() {
  return {
    uRimColor: { value: PALETTE.skyHaze.clone() },
    uRimPower: { value: 2.6 },
    uRimStrength: { value: 0.55 },
    uSpecStrength: { value: 0.9 },
    uSpecSize: { value: 0.42 },
    uMatcapStrength: { value: 0.28 },
    uShadeSoftness: { value: 0.02 },
    uAmbientWrap: { value: 0.62 },
    uFogNear: { value: 260 },
    uFogFar: { value: 1500 },
    uCameraNear: { value: 0.1 },
    uCameraFar: { value: 4000 },
  };
}
