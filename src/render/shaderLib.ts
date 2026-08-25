import { PALETTE, SUN_DIR } from '../core/Palette.ts';
import { CEL_MATCAP_NEUTRAL, CEL_RAMP_SCALE } from './materials/proceduralTextures.ts';

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

void writeNormalDepth(vec3 viewNormal, float viewDepth) {
  vec3 n = normalize(viewNormal) * 0.5 + 0.5;
  float d = clamp(viewDepth / uCameraFar, 0.0, 1.0);
  outNormalDepth = vec4(n, d);
}

/**
 * Write "there is no surface normal here, but there IS geometry at this depth".
 *
 * A zero normal is the pass-wide opt-out flag: the Sobel pass skips such
 * pixels, and — crucially — substitutes the centre sample for any *neighbour*
 * that carries one, so a flagged region cannot generate a gradient in the
 * pixels around it either.
 *
 * The inverted-hull shells use this. When a shell wrote its own (negated,
 * far-side) normal, the 2-3 px ink band around every silhouette was itself a
 * normal *and* a depth discontinuity, so the Sobel pass drew a second line
 * immediately inside the first. On thick geometry the depth-based silhouette
 * reject hid that; on a mast or a rider's forearm the front and back surfaces
 * are millimetres apart, the reject never fired, and every thin object in the
 * frame came out with a doubled line. Flagging the ink removes the cause rather
 * than tuning around it.
 *
 * The depth is still written, because the ocean's waterline foam samples this
 * attachment and needs geometry to occlude it.
 *
 * The flag is the ENCODED zero (0.5), not a raw zero. The main target is
 * multisampled, so the resolve averages this attachment across every edge in
 * the frame — and averaging a raw zero with a neighbouring surface normal
 * yields a full-length normal pointing somewhere the geometry never faced. That
 * put a fabricated normal discontinuity around every antialiased silhouette and
 * defeated the entire flagging scheme; the line mask showed a complete second
 * outline on every curved object even with the flag in place. Averaging the
 * encoded zero only *shortens* the surface's normal, leaving its direction
 * intact, which the Sobel pass can recognise and discount.
 */
void writeInkNormalDepth(float viewDepth) {
  outNormalDepth = vec4(0.5, 0.5, 0.5, clamp(viewDepth / uCameraFar, 0.0, 1.0));
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

/**
 * Fixed-softness band edge. Prefer bandStepAA below in any fragment shader —
 * this one exists for vertex shaders and for quantities with no meaningful
 * screen-space derivative, where fwidth() is either illegal or zero.
 */
float bandStep(float edge, float x, float softness) {
  return smoothstep(edge - softness, edge + softness, x);
}

/**
 * A band edge that is hard to the eye and exactly one pixel wide on screen.
 *
 * A fixed softness cannot do this, because the width of the transition in PIXELS
 * is the softness divided by however fast the underlying quantity happens to be
 * changing — and that varies by orders of magnitude across one frame. On a
 * close-up sphere the wrapped N·L changes so slowly that a fixed 0.016 was
 * effectively a pure step(), and a step() whose boundary runs near-vertical
 * produces a staircase with steps as tall as the boundary's inverse slope. The
 * calibration sphere's terminator came out of round 9 as an 8-px-tall zigzag,
 * which no amount of MSAA touches: the edge is in the shading, not the geometry.
 *
 * Scaling the transition by the screen-space derivative makes it one pixel
 * everywhere, which is as hard as an edge can be and still not alias. The
 * uShadeSoftness floor is kept so a surface that is genuinely flat in this
 * quantity — a face whose whole area sits on one side of the edge — does not
 * divide by a derivative of zero.
 */
float bandStepAA(float edge, float x, float softness) {
  float w = max(fwidth(x) * 0.6, softness * 0.2);
  return smoothstep(edge - w, edge + w, x);
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
uniform float uRimWidth;
uniform float uKeyRimStrength;
uniform float uSpecStrength;
uniform float uSpecSize;
uniform float uMatcapStrength;
uniform float uShadeSoftness;
uniform float uAmbientWrap;
uniform float uSkyFill;
uniform float uKeyFill;

/** See CEL_RAMP_SCALE: the ramp's lit band is stored above 1 and rescaled here. */
const float RAMP_SCALE = ${f(CEL_RAMP_SCALE)};

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
  float ndl = dot(N, L);
  float ndv = max(dot(N, V), 0.0);

  // --- 1. banded diffuse -------------------------------------------------
  // Half-lambert wrap lifts the terminator off the geometric horizon. The
  // shipped band thresholds in CEL_BANDS are chosen for uAmbientWrap = 0.55;
  // moving the wrap slides all four bands at once, which is the intended way to
  // soften a whole object without authoring it a second ramp.
  float wrapped = mix(ndl, ndl * 0.5 + 0.5, uAmbientWrap);
  wrapped *= s.shadow;
  wrapped *= mix(0.72, 1.0, s.ao);

  // THREE TAPS, spread along the screen-space gradient of the wrapped N.L.
  //
  // The ramp is a NearestFilter texture on purpose — the bands have to be hard —
  // but a nearest fetch of a quantity that varies across the screen is an
  // aliased step, and the band edges came out of round 9 as visible staircases
  // wherever a terminator ran close to vertical or horizontal. Sampling the ramp
  // at the pixel's footprint instead of at its centre resolves the edge to about
  // one pixel with three intermediate levels, which reads as a clean drawn line
  // and not as a gradient. Supersampling the *lookup* is the only place this can
  // be fixed: softening the ramp texture itself would soften every band edge by
  // a fixed amount in N·L, which is a gradient on a close surface and still a
  // staircase on a distant one.
  float rampW = clamp(fwidth(wrapped) * 0.5, 0.0, 0.06);
  vec3 ramp = (
      texture(uRamp, vec2(clamp(wrapped - rampW, 0.001, 0.999), 0.5)).rgb * 0.25
    + texture(uRamp, vec2(clamp(wrapped,         0.001, 0.999), 0.5)).rgb * 0.5
    + texture(uRamp, vec2(clamp(wrapped + rampW, 0.001, 0.999), 0.5)).rgb * 0.25
  ) * RAMP_SCALE;

  // The ramp carries the band *shape* and its colour temperature shift; the
  // surface's own paint colour is multiplied back in so one ramp serves every
  // object in the game.
  vec3 diffuse = s.baseColor * ramp;

  // ADDITIVE FILL. This exists because a ramp can only ever multiply, and a
  // multiply cannot introduce a hue the paint does not already contain. On the
  // racing red (linear 1.0, 0.027, 0.125) the red channel is already at its
  // ceiling, so the lit and base bands differ only in channels that are near
  // zero: three of the four bands came back from the captures reading as the
  // same red, and the sphere's form flattened out completely.
  //
  // Adding sky colour where the ramp is darkest and sun colour where it is
  // brightest gives a saturated paint a shadow that is a different COLOUR and a
  // light that is a different COLOUR, which is what a painter does and what no
  // amount of threshold tuning can substitute for. Both terms are deliberately
  // concentrated at the extremes so the base band stays pure paint.
  //
  // Both terms scale with the paint's own brightness. A near-white surface can
  // absorb a lot of sky in its shadow and still read as white — and *must*, or
  // it renders as neutral grey, which is how the calibration icosahedron came
  // back looking like brushed metal for three rounds. A dark paint cannot: the
  // same absolute amount of blue would be most of its shadow value and the
  // object would change colour rather than gain a light source. Scaling by
  // albedo is also what actually happens on a real surface, which is a rare case
  // of the physical answer and the painter's answer agreeing.
  float rampL = clamp(luma(ramp) / RAMP_SCALE, 0.0, 1.0);
  float albedoL = luma(s.baseColor);
  float shadowFill = 1.0 - smoothstep(0.10, 0.70, rampL);
  float keyFill = smoothstep(0.78, 1.0, rampL);
  diffuse += SKY_COLOR * shadowFill * uSkyFill * (0.55 + 1.25 * albedoL)
           + SUN_COLOR * keyFill * uKeyFill * (0.45 + 1.1 * albedoL);

  // --- 2. banded specular ------------------------------------------------
  // Two independent highlight SHAPES, not one lobe with a hard edge.
  //
  // The broad shape uses a deliberately low exponent and then cuts it with a
  // threshold: a wide lobe plus a hard cut is a blob with a drawn contour, which
  // is what an animator paints. A high exponent plus a hard cut — what this was
  // before — is a dot, and a dot is what reads as a plastic sphere.
  vec3 H = normalize(L + V);
  float broad = pow(max(dot(N, H), 0.0), mix(52.0, 8.0, uSpecSize));
  float shapeA = bandStepAA(0.40, broad, uShadeSoftness);

  // ...and then CLIPPED BY THE TOP RAMP BAND. A thresholded Blinn lobe on a
  // sphere is a circle, and a hard-edged circle of pale paint is a photograph of
  // a snooker ball — the captured calibration sphere read as glossy plastic even
  // after the edge was made hard, because the *contour* was still a lens flare's
  // contour and not a drawn one. Intersecting the lobe with the lit band cuts it
  // along the terminator, so the highlight inherits the form's own silhouette:
  // a lens on a sphere, a wedge on a cone, a facet-aligned slab on a hard-edged
  // hull. That is the difference between a highlight that is lit and one that is
  // drawn, and it costs one step. rampL is the band index, computed above.
  shapeA *= bandStepAA(0.62, rampL, uShadeSoftness);

  // The satellite. Its half-vector is built from the key rotated about world up
  // and tipped down, so the second shape lands BESIDE the first. Two concentric
  // discs are still just one dot however hard their edges are; the offset pair
  // is the thing that reads as anime specular.
  // It has to stay SMALL. Measured across the sphere it was 17 px wide at 25%
  // saturation, i.e. a second pale blob nearly as large as the main highlight,
  // which reads as two glossy reflections rather than one drawn mark plus its
  // accent. The exponent is up and its neutral share is down accordingly.
  vec3 Lsat = normalize(L + cross(L, vec3(0.0, 1.0, 0.0)) * 0.68 - vec3(0.0, 0.30, 0.0));
  float tight = pow(max(dot(N, normalize(Lsat + V)), 0.0), mix(620.0, 150.0, uSpecSize));
  float shapeB = bandStepAA(0.45, tight, uShadeSoftness * 0.7);

  // The broad shape is THE PAINT DRIVEN UP THE RAMP, not a light added over it.
  // Adding a sun-tinted light to the racing red — whose red channel is already
  // at 1.0 — can only move green and blue, and every capture came back with a
  // pale salmon disc on a crimson ball: the highlight had less chroma than the
  // surface it sat on, which is the single loudest "physically based" tell in
  // the frame. Scaling the paint instead keeps the hue exactly and lets the
  // tonemap decide how bright it lands, so a red hull gets a red-hot highlight.
  vec3 hiPaint = s.baseColor * 2.4 + 0.08;

  // Only the small satellite carries any neutral. One tiny near-white mark is
  // how an animator says "lacquered" without spending the surface's chroma.
  // Light paints get less of it. A pale surface has almost no headroom above its
  // own lit band, so a highlight at full strength lands on white and the object
  // stops being paint and starts being lacquered sheet metal — the near-white
  // calibration slabs came back from round 9 looking like polished panels. A
  // dark paint has the whole range above it to play with and needs the full
  // amount to register at all.
  float specGate = smoothstep(-0.02, 0.16, ndl) * s.shadow * mix(1.0, 0.42, albedoL);
  vec3 specular = (hiPaint * shapeA * 0.55
                + (hiPaint * 0.7 + SUN_COLOR * 0.5) * shapeB * 0.85)
                * uSpecStrength * specGate;

  // --- 3. matcap fake reflection ----------------------------------------
  // View-space normal -> matcap UV. No probe, no cubemap: a painted disc.
  vec3 vn = normalize((viewMatrix * vec4(N, 0.0)).xyz);
  vec2 muv = vn.xy * 0.48 + 0.5;
  // The matcap is consumed as a pure VALUE field. Its remaining chroma is a hue
  // the surface never asked for; on a light paint it is the only thing visible,
  // which is what put brown and navy on the near-white calibration icosahedron.
  float env = luma(texture(uMatcap, muv).rgb);
  // Quantise the SCALAR, after luma — not the three channels before it. Banding
  // RGB gives each channel its own step position, and the luma of that is a
  // hundred-step staircase over a smooth gradient, which is indistinguishable
  // from no banding at all. This was the actual source of the soft gradient that
  // survived on the upper half of the calibration sphere and down the cone's lit
  // face through four rounds of "the matcap is quantised" being true on paper.
  env = floor(env * 3.0 + 0.5) / 3.0;
  float envSigned = env - ${f(CEL_MATCAP_NEUTRAL)};

  // Applied as a *multiplier* on the shaded paint, not screened or added over
  // it. Both of those mix a neutral into the surface and cost saturation, and
  // saturation is the one thing this art direction cannot spend: screening a
  // 45%-bright environment over the violet knot moved its darkest channel from
  // 0.11 to 0.37 and turned a saturated violet into lavender. A multiply
  // preserves hue and chroma exactly and still delivers the value structure
  // that makes the reflection read.
  diffuse *= 1.0 + envSigned * uMatcapStrength;

  // One small additive sheen, squared so it only exists in the matcap's
  // brightest region — the painted highlight wedge. This is the part that reads
  // as an actual reflection rather than as extra ambient, and it is tinted
  // towards the paint so it cannot wash a coloured hull towards white.
  float sheen = max(envSigned, 0.0);
  sheen *= sheen;
  diffuse += sheen * uMatcapStrength * 1.6 * mix(vec3(1.0), s.baseColor + 0.4, 0.65);

  // --- 4. fresnel rim ----------------------------------------------------
  // Two rims, because one term cannot do both jobs.
  float fres = pow(1.0 - ndv, uRimPower);

  // CURVATURE GATE. A fresnel term is constant across a flat face, so on a box
  // it does not draw an edge — it repaints the whole face. The backlit probe
  // showed the calibration box's right-hand face rendered as a single flat slab
  // of cream at a higher value than the face pointing at the camera, which reads
  // as a lighting bug and nothing else. Rim light belongs on curvature: where
  // the shading normal turns within the pixel there is a contour, and where it
  // does not there is a face. A flat face keeps a small fraction rather than
  // zero, because a faceted object — the calibration icosahedron, and any
  // low-poly hull panel — does still want its silhouette facets lit.
  float turn = length(fwidth(N));
  float curved = mix(0.22, 1.0, smoothstep(0.004, 0.05, turn));

  // The key rim traces the sun-side edge in warm light. This is the term that
  // makes a shape feel drawn rather than lit, and it is the one that was
  // missing: the old single rim was gated on N.y, so a shape lit from the side
  // got a rim on its top edge and nothing along the contour facing the sun.
  float keyRim = bandStepAA(uRimWidth, fres, uShadeSoftness * 0.9)
               * smoothstep(-0.30, 0.30, ndl);

  // The sky rim traces the shadow-side edge in cool light. Its job is purely
  // separation: without it a dark hull silhouetted against dark water loses its
  // contour the moment the ink line is thinner than a pixel. It is the WIDER of
  // the two — separation is the job that has to survive at distance.
  float skyRim = bandStepAA(uRimWidth * 0.82, fres, uShadeSoftness)
               * (1.0 - smoothstep(-0.20, 0.45, ndl))
               * mix(0.40, 1.0, clamp(N.y * 0.5 + 0.5, 0.0, 1.0));

  // The key rim is tinted towards the paint for the same reason the specular is:
  // a pure sun-coloured rim at any useful strength renders as a white glow, the
  // bright extract picks it up, and the bloom turns every silhouette into a
  // halo. The paint's weight here is high on purpose — a scan across the
  // calibration sphere measured the previous tint at 40% saturation against a
  // 100%-saturated surface, so the rim was *less* coloured than the paint it was
  // meant to be lighting and read as an airbrushed glow.
  vec3 keyRimTint = SUN_COLOR * (0.18 + 1.5 * s.baseColor);

  // The sky rim is tinted the same way, for a reason that is easy to miss: an
  // untinted cobalt rim on a crimson sphere measured rgb(205,150,165) — a
  // neutral mauve at 30% saturation sitting on a surface at 100%. It read as a
  // grey wash, not as light. Multiplying the sky colour through the paint keeps
  // the bounce cool while making it the paint's OWN cool: violet on red, teal on
  // green, and still a straight blue on anything near-white.
  vec3 skyRimTint = uRimColor * (0.35 + 1.2 * s.baseColor);
  vec3 rimLight = (keyRimTint * keyRim * uKeyRimStrength
                + skyRimTint * skyRim * uRimStrength) * curved;

  return diffuse + specular + rimLight;
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

/**
 * Uniform block every cel material shares, as a plain object factory.
 *
 * Anything CEL_LIGHTING declares must appear here, because the other systems
 * that reuse the lighting core (the instanced buoy material, for one) build
 * their uniform block by spreading this and would otherwise ship with an
 * undeclared sampler or scalar and fail to link.
 */
export function celUniformDefaults() {
  return {
    // COOL. skyHaze is the warm sand at the horizon, and using it here put a
    // khaki band around the shadow side of a crimson sphere — measured at
    // rgb(205,163,142) on a surface whose darkest band was rgb(152,0,40). The
    // shadow-side rim is bounced *sky*, and the sky above the horizon is cobalt.
    uRimColor: { value: PALETTE.skyHigh.clone() },
    // Rim geometry: fres = (1 - N·V)^uRimPower, thresholded at uRimWidth.
    //
    // THE RIM MUST BE WIDER THAN THE INK. At the shipped 0.5 the band fired only
    // where N·V < 0.29, i.e. beyond 73 degrees off the normal — the outer 4% of
    // a sphere's radius, about 2 px on the calibration sphere. The inverted-hull
    // ink band is 2 px. The rim was therefore drawn entirely *underneath* the
    // outline on every object in every capture, which is why probe-05-backlit
    // showed four backlit shapes and not one rim: the term was working and
    // invisible.
    //
    // 0.30 fixed that and overshot: the band measured 16 px on the calibration
    // sphere, which at that radius is a sixth of the visible surface and reads
    // as an airbrushed glow rather than a stroke. 0.44 puts the inner edge at 55
    // degrees — the outer 6% of a radius, 8 px on the same sphere — which is
    // four times the ink's width and still unmistakably an edge.
    // Power 2.6 rather than 2.0 narrows the band without moving its outer edge,
    // which matters at close range: a sphere three radii from the camera shows
    // far more of its own limb than a distant one, and at power 2 the rim was
    // covering roughly a fifth of the visible surface in the close-up probe.
    uRimPower: { value: 2.6 },
    uRimWidth: { value: 0.44 },
    /** Cool sky rim on the shadow side: separation from the water behind. */
    uRimStrength: { value: 0.8 },
    /** Warm key rim on the sun side: the term that makes a shape read as drawn. */
    uKeyRimStrength: { value: 0.55 },
    uSpecStrength: { value: 0.9 },
    uSpecSize: { value: 0.5 },
    /** Depth of the matcap's value modulation, centred so 0.5 grey is neutral. */
    uMatcapStrength: { value: 0.55 },
    // Softness is *one band-step of an 8-bit ramp*, no more. It exists only so
    // a 2x capture downsampled to 1x does not crawl along the band edges; any
    // larger and the hard cut this whole pipeline is built around comes back as
    // a gradient.
    uShadeSoftness: { value: 0.016 },
    uAmbientWrap: { value: 0.55 },
    /** Sky colour added into the shadow bands. See the fill note in celShade. */
    uSkyFill: { value: 0.1 },
    /** Sun colour added into the lit band. */
    uKeyFill: { value: 0.15 },
    uFogNear: { value: 260 },
    uFogFar: { value: 1500 },
    uCameraNear: { value: 0.1 },
    uCameraFar: { value: 4000 },
  };
}
