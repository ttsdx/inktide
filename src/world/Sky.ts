import {
  BackSide,
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  GLSL3,
  Group,
  Mesh,
  PlaneGeometry,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
  AdditiveBlending,
  type PerspectiveCamera,
} from 'three';
import { PALETTE, SUN_DIR } from '../core/Palette.ts';
import { CEL_COMMON, glslVec3 } from '../render/shaderLib.ts';
import { packedNoise } from '../render/materials/proceduralTextures.ts';

/**
 * SKY, CLOUDS AND SUN
 *
 * Three layers, all procedural:
 *   1. A banded gradient dome. The gradient is quantised into wide stops with
 *      a dithered transition, so it reads as painted paper rather than a
 *      shader gradient, and never shows 8-bit banding artefacts.
 *   2. Cel clouds: flat billboard shapes built from thresholded FBM, with a
 *      hard lit rim on the sun side and an ink-tinted underside. They drift and
 *      slowly deform, but they are never volumetric.
 *   3. A graphic sun: a hard white disc, a quantised halo, and a six-spoke
 *      star flare that stays crisp — an anime sun stamp, not a lens sim.
 */

const SUN = new Vector3(SUN_DIR.x, SUN_DIR.y, SUN_DIR.z).normalize();

export class Sky {
  readonly group = new Group();
  private domeMat: ShaderMaterial;
  private cloudMat: ShaderMaterial;
  private sunMat: ShaderMaterial;

  constructor() {
    this.group.name = 'Sky';
    // The sky follows the camera, so it must never be culled or depth-sorted
    // against the world.
    this.group.frustumCulled = false;

    // --- dome ---------------------------------------------------------------
    const domeGeo = new SphereGeometry(1, 48, 32);
    this.domeMat = new ShaderMaterial({
      name: 'SkyDome',
      glslVersion: GLSL3,
      side: BackSide,
      depthWrite: false,
      depthTest: false,
      uniforms: {
        uTime: { value: 0 },
        uSunDir: { value: SUN.clone() },
      },
      vertexShader: DOME_VERT,
      fragmentShader: DOME_FRAG,
    });
    const dome = new Mesh(domeGeo, this.domeMat);
    dome.name = 'SkyDome';
    dome.renderOrder = -100;
    dome.frustumCulled = false;
    dome.userData.noOutline = true;
    this.group.add(dome);

    // --- sun stamp ----------------------------------------------------------
    this.sunMat = new ShaderMaterial({
      name: 'SunFlare',
      glslVersion: GLSL3,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: AdditiveBlending,
      uniforms: { uTime: { value: 0 } },
      vertexShader: BILLBOARD_VERT,
      fragmentShader: SUN_FRAG,
    });
    const sun = new Mesh(new PlaneGeometry(2, 2), this.sunMat);
    sun.name = 'Sun';
    sun.renderOrder = -98;
    sun.frustumCulled = false;
    sun.userData.noOutline = true;
    sun.onBeforeRender = (_r, _s, camera) => {
      // Park the sun quad on the dome and face the camera.
      const cam = camera as PerspectiveCamera;
      sun.position.copy(SUN).multiplyScalar(0.86);
      sun.quaternion.copy(cam.quaternion);
      // Smaller billboard. The rays are bounded by the quad, so its size sets
      // how far the flare can reach across the sky and how far off-screen the
      // sun can be while still leaving marks in the frame.
      sun.scale.setScalar(0.26);
    };
    this.group.add(sun);

    // --- clouds -------------------------------------------------------------
    this.cloudMat = new ShaderMaterial({
      name: 'CelClouds',
      glslVersion: GLSL3,
      side: BackSide,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      uniforms: {
        uTime: { value: 0 },
        uNoise: { value: packedNoise() },
        uSunDir: { value: SUN.clone() },
        // Coverage is deliberately low. A busy sky competes with the water for
        // attention, and the water is the star.
        uCoverage: { value: 0.40 },
      },
      vertexShader: DOME_VERT,
      fragmentShader: CLOUD_FRAG,
    });
    const clouds = new Mesh(new SphereGeometry(0.98, 64, 40), this.cloudMat);
    clouds.name = 'Clouds';
    clouds.renderOrder = -99;
    clouds.frustumCulled = false;
    clouds.userData.noOutline = true;
    this.group.add(clouds);
  }

  /** Keep the dome centred on the camera and advance the drift. */
  update(camera: PerspectiveCamera, elapsed: number): void {
    // Sit just inside the far plane so nothing can ever poke through it.
    const r = camera.far * 0.88;
    this.group.position.copy(camera.position);
    this.group.scale.setScalar(r);
    this.domeMat.uniforms.uTime.value = elapsed;
    this.cloudMat.uniforms.uTime.value = elapsed;
    this.sunMat.uniforms.uTime.value = elapsed;
  }

  get sunDirection(): Vector3 {
    return SUN;
  }

  dispose(): void {
    this.domeMat.dispose();
    this.cloudMat.dispose();
    this.sunMat.dispose();
  }
}

// ---------------------------------------------------------------------------

const DOME_VERT = /* glsl */ `
precision highp float;
out vec3 vDir;
void main() {
  vDir = normalize(position);
  // The dome is drawn without depth, so push it to the far plane manually.
  vec4 clip = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = clip.xyww;
}
`;

const BILLBOARD_VERT = /* glsl */ `
precision highp float;
out vec2 vUv;
void main() {
  vUv = uv;
  vec4 clip = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = clip.xyww;
}
`;

/**
 * Banded sky gradient.
 *
 * Five stops from a deep cobalt zenith down through cyan to a warm sand
 * horizon. Between stops the blend is *ordered-dithered* rather than smooth:
 * at 1-2 px the dither reads as a soft transition, but the overall impression
 * is of discrete painted bands, which is exactly the anime background look.
 */
const DOME_FRAG = /* glsl */ `
precision highp float;
layout(location = 0) out vec4 outColor;
layout(location = 1) out vec4 outNormalDepth;

in vec3 vDir;
uniform float uTime;
uniform vec3 uSunDir;

${CEL_COMMON}

const vec3 C0 = ${glslVec3(PALETTE.skyZenith)};
const vec3 C1 = ${glslVec3(PALETTE.skyHigh)};
const vec3 C2 = ${glslVec3(PALETTE.skyMid)};
const vec3 C3 = ${glslVec3(PALETTE.skyHaze)};
const vec3 C4 = ${glslVec3(PALETTE.skyHorizon)};

/** Cheap 3D-ish value noise on a direction, for perturbing band edges. */
float dirNoise(vec3 d, float scale) {
  vec3 p = d * scale;
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float n = 0.0;
  for (int c = 0; c < 8; c++) {
    vec3 o = vec3(float(c & 1), float((c >> 1) & 1), float((c >> 2) & 1));
    float w = mix(1.0 - f.x, f.x, o.x) * mix(1.0 - f.y, f.y, o.y) * mix(1.0 - f.z, f.z, o.z);
    n += hash21((i + o).xy + (i.z + o.z) * 37.0) * w;
  }
  return n;
}

/**
 * Pick one of five flat colours from a 0..1 param (0 = zenith, 1 = horizon).
 *
 * An earlier version dithered the band edges with a Bayer matrix. On a gradient
 * this shallow the dither zone covered a third of the screen and read as a
 * checkerboard, which is exactly the mechanical artefact we are trying to
 * avoid. What a background painter actually does is lay down flat bands with a
 * slightly wandering, hand-cut edge — so instead the boundary itself is
 * displaced by low-frequency noise, and each pixel still resolves to exactly
 * one of the five palette colours.
 */
vec3 bandedSky(float t, float wobble, vec3 low) {
  float x = clamp(t + wobble, 0.0, 1.0) * 4.0;
  float fi = clamp(floor(x), 0.0, 3.0);
  int i = int(fi);
  vec3 a = i == 0 ? C0 : i == 1 ? C1 : i == 2 ? C2 : C3;
  vec3 b = i == 0 ? C1 : i == 1 ? C2 : i == 2 ? C3 : low;
  // A 1-2 pixel smoothstep across the edge, no more: enough to stop the band
  // boundary aliasing into a staircase, far too narrow to read as a gradient.
  float e = fwidth(x) * 0.8;
  return mix(a, b, smoothstep(0.5 - e, 0.5 + e, fract(x)));
}

void main() {
  vec3 d = normalize(vDir);

  // Below the horizon the dome is only ever visible through a gap in the ocean
  // — the frame or two where a chase cam clips a wave crest, or the backfaces
  // of the disc when the camera is briefly submerged. Painting it deep water
  // blue makes those frames read as "under a wave" instead of flashing the
  // horizon's warm sand across the bottom of the screen.
  if (d.y < 0.0) {
    float depth = clamp(-d.y * 2.4, 0.0, 1.0);
    vec3 under = mix(${glslVec3(PALETTE.waterMid)}, ${glslVec3(PALETTE.waterDeep)}, floor(depth * 3.0 + 0.2) / 3.0);
    outColor = vec4(under, 1.0);
    outNormalDepth = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  // 0 at the zenith, 1 at the horizon. The pow() compresses the gradient down
  // towards the horizon, where the camera actually spends its time — the top
  // of the dome stays a single deep cobalt field.
  float t = 1.0 - pow(clamp(d.y, 0.0, 1.0), 0.52);

  // Two octaves of wobble: a long one that gives each band a lazy sweep, and a
  // shorter one that roughens the cut. Amplitude is small — the bands must
  // still read as horizontal, just not as ruled lines.
  float wobble = (dirNoise(d, 2.6) - 0.5) * 0.075 + (dirNoise(d, 7.3) - 0.5) * 0.028;

  // WHERE THE WARMTH GOES.
  //
  // The horizon's warm sand used to be applied all the way round the compass
  // at one strength, which produced an identical flat band whether the camera
  // was pointing into the sun or directly away from it. A constant stripe with
  // no relationship to the light does not read as atmosphere; every capture
  // came back with it looking like a stuck skybox seam laid across the middle
  // of the frame.
  //
  // Warmth at the horizon is scattered sunlight, so it belongs on the sun's
  // bearing and nowhere else. Away from it the horizon recedes into the same
  // pale cyan the distant water fades to, which is also what lets the two meet
  // without a visible seam.
  float sunAz = dot(normalize(d.xz + vec2(1e-5)), normalize(uSunDir.xz + vec2(1e-5)));
  float warm = smoothstep(-0.15, 0.80, sunAz);
  vec3 horizonCol = mix(C3, C4, warm);

  vec3 col = bandedSky(t, wobble, horizonCol);

  // A warm collar around the sun, quantised into two steps.
  //
  // Quantising a radial falloff draws its own step boundaries as concentric
  // rings, and the only thing that decides whether those read as light or as a
  // lens artefact is how big they are. An exponent of 30 over three steps put
  // the outer ring 15 degrees off the sun — a 340 px disc at this field of
  // view, plainly visible as a hard-edged grey circle pasted on the sky. At
  // 150 over two steps the outer edge sits about 5 degrees out, inside the
  // glare where a step belongs.
  float sd = max(dot(d, normalize(uSunDir)), 0.0);
  float tight = floor(pow(sd, 150.0) * 2.0 + 0.2) / 2.0;
  col = mix(col, ${glslVec3(PALETTE.sun)}, tight * 0.6);

  // A single hard haze band riding the horizon line, which gives the ocean
  // something to meet instead of fading into nothing.
  //
  // The wobble is given nearly four times its old authority here. At 0.16 of
  // an amplitude that is itself small, the band's height varied by about a
  // tenth of its own thickness, which is to say it was a ruled line; the
  // critic measured it as a rectangle with a perfectly straight top and bottom
  // edge running the full width of every outdoor frame. It now has to visibly
  // rise and fall along its length.
  float hy = d.y - 0.006 + wobble * 0.58;
  float band = 1.0 - smoothstep(0.0, 0.026, abs(hy));
  col = mix(col, horizonCol, band * mix(0.16, 0.68, warm));

  outColor = vec4(col, 1.0);
  // Sky writes a null normal so the Sobel pass leaves it alone.
  outNormalDepth = vec4(0.0, 0.0, 0.0, 1.0);
}
`;

/**
 * Cel clouds.
 *
 * FBM is sampled on the view direction projected to a plane above the camera,
 * then hard-thresholded twice: once for the cloud body and once, at a slightly
 * higher threshold offset along the sun direction, for the lit rim. The gap
 * between the two thresholds *is* the rim, so the rim width is uniform and
 * crisp everywhere rather than depending on a gradient's slope.
 */
const CLOUD_FRAG = /* glsl */ `
precision highp float;
layout(location = 0) out vec4 outColor;
layout(location = 1) out vec4 outNormalDepth;

in vec3 vDir;
uniform float uTime;
uniform sampler2D uNoise;
uniform vec3 uSunDir;
uniform float uCoverage;

const vec3 CLOUD_LIT = ${glslVec3(PALETTE.cloudLit)};
const vec3 CLOUD_MID = ${glslVec3(PALETTE.cloudMid)};
const vec3 CLOUD_SHADE = ${glslVec3(PALETTE.cloudShade)};
const vec3 SUN_TINT = ${glslVec3(PALETTE.sun)};

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);
  for (int i = 0; i < 5; i++) {
    v += texture(uNoise, p * 0.5).r * a;
    p = rot * p * 2.03 + 11.7;
    a *= 0.5;
  }
  return v;
}

/** Density field at a direction, offset along the sun direction for the rim. */
float cloudDensity(vec3 d, vec2 bias) {
  // Project the view ray onto a plane 1 unit above the camera. Rays near the
  // horizon stretch enormously, which is exactly the perspective a real cloud
  // deck has, and it keeps clouds out of the water.
  float y = max(d.y, 0.035);
  vec2 uv = d.xz / y * 0.115 + bias;
  uv += vec2(uTime * 0.0042, uTime * 0.0017);

  float base = fbm(uv);
  // A second, slower field warps the first so shapes evolve instead of sliding
  // rigidly across the sky.
  float warp = fbm(uv * 0.43 + vec2(uTime * 0.0021, -uTime * 0.0009));
  base = mix(base, warp, 0.36);

  // Fade the deck out towards the horizon so the tiling never becomes legible.
  float horizonFade = smoothstep(0.02, 0.30, d.y);
  // ...and out towards the zenith so we are not staring at a solid ceiling.
  float zenithFade = 1.0 - smoothstep(0.62, 0.96, d.y) * 0.65;
  return base * horizonFade * zenithFade;
}

void main() {
  vec3 d = normalize(vDir);
  if (d.y < 0.0) { outColor = vec4(0.0); outNormalDepth = vec4(0.0, 0.0, 0.0, 1.0); return; }

  float thr = 1.0 - uCoverage;

  float body = cloudDensity(d, vec2(0.0));
  float inside = step(thr, body);
  if (inside < 0.5) { outColor = vec4(0.0); outNormalDepth = vec4(0.0, 0.0, 0.0, 1.0); return; }

  // The lit rim: sample the field shifted *towards* the sun. Where the shifted
  // sample has fallen outside the cloud but this one is still inside, we are
  // standing on the sun-facing edge. The shift distance IS the rim width, so it
  // has to be small — an early version used 0.030 and lit half of every cloud.
  vec2 sunBias = normalize(uSunDir.xz) * 0.0075;
  float shifted = cloudDensity(d, sunBias);

  // Three tones plus the rim. Clouds painted with a single tone read as paper
  // cut-outs; three gives them just enough form to sit in the sky without ever
  // becoming volumetric.
  float rim = step(shifted, thr);
  float mid = step(thr + 0.045, body);
  float deep = step(thr + 0.115, body);

  vec3 col = CLOUD_LIT;
  col = mix(col, CLOUD_MID, mid);
  col = mix(col, CLOUD_SHADE, deep);
  // The rim overwrites whatever tone is underneath — it is the brightest thing
  // in the sky after the sun itself.
  col = mix(col, CLOUD_LIT, rim);

  // Clouds close to the sun pick up its warmth, on the rim only.
  float sd = max(dot(d, normalize(uSunDir)), 0.0);
  col = mix(col, SUN_TINT, rim * pow(sd, 2.5) * 0.9);

  // Soften only the outermost pixel of the silhouette so the edge is crisp but
  // not aliased into a staircase.
  float alpha = smoothstep(thr, thr + fwidth(body) * 1.5 + 0.002, body);
  // Distant clouds thin out towards the horizon haze.
  alpha *= smoothstep(0.025, 0.12, d.y);

  outColor = vec4(col, alpha * 0.97);
  outNormalDepth = vec4(0.0, 0.0, 0.0, 1.0);
}
`;

/**
 * Sun stamp: hard disc + quantised halo + six-spoke star. Every element is
 * thresholded, so at any resolution it stays a drawn shape.
 */
const SUN_FRAG = /* glsl */ `
precision highp float;
layout(location = 0) out vec4 outColor;
layout(location = 1) out vec4 outNormalDepth;

in vec2 vUv;
uniform float uTime;

const vec3 CORE = ${glslVec3(PALETTE.sunCore)};
const vec3 GLOW = ${glslVec3(PALETTE.sun)};

/**
 * One set of hard-edged, radially tapering rays.
 *
 * Built as angular wedges whose half-width shrinks quadratically towards the
 * tip, then hard-stepped. A pow(cos(ang*n), k) star — the obvious approach —
 * produces fat rounded lobes that read as a pinwheel, because the falloff is in
 * the wrong domain: it narrows the ray with angle, not with radius. Tapering
 * the wedge with radius is what makes a ray look drawn with a brush.
 */
float rays(float ang, float r, float count, float phase, float len, float halfWidth) {
  float seg = 6.2831853 / count;
  float a = mod(ang + phase + seg * 0.5, seg) - seg * 0.5;
  float radial = clamp(1.0 - r / len, 0.0, 1.0);
  float w = halfWidth * radial * radial;
  return step(abs(a), w);
}

void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  float ang = atan(p.y, p.x);

  // A solid core that runs straight into its warm collar with no gap. An
  // earlier build separated the disc from its ring, which read as an eyeball.
  float core = 1.0 - smoothstep(0.138, 0.148, r);
  float collar = 1.0 - smoothstep(0.186, 0.196, r);

  // There is deliberately no halo disc on this quad. Quantising a radial
  // falloff into steps produced concentric hard-edged rings that read as a UI
  // element pasted over the sky. The atmospheric glow around the sun is
  // handled by the dome shader instead, where it can be occluded by cloud and
  // wobbles with the same noise as the sky bands, plus the bloom pass.

  // Four long rays and four short ones offset by 45 degrees. The asymmetry is
  // what stops it reading as a lens artefact.
  //
  // Lengths cut hard from 0.88/0.42. The billboard is large — it has to be, to
  // hold a sun that reads at distance — and a ray reaching 88% of its radius
  // therefore reached most of the way across the sky. Worse, when the sun sat
  // just outside the frustum the quad's edge was still on screen, so frames
  // with no sun in them picked up an unexplained white scratch at the top: it
  // appeared in four separate captures before anyone worked out what it was.
  // Keeping every ray well inside the quad means the flare cannot outlive its
  // own source.
  float breathe = 0.94 + 0.06 * sin(uTime * 0.8);
  float longRays = rays(ang, r, 4.0, 0.0, 0.46 * breathe, 0.075);
  float shortRays = rays(ang, r, 4.0, 0.7853982, 0.30 * breathe, 0.10);
  // Fade the outer third of every ray so it tapers out instead of being cut
  // off by the wedge's own length test, which leaves a visible squared tip.
  float rayFade = 1.0 - smoothstep(0.30, 0.48, r);
  float star = max(longRays, shortRays) * step(0.10, r) * rayFade;

  float a = clamp(core + collar * 0.92 + star * 0.62, 0.0, 1.0);
  vec3 col = mix(GLOW, CORE, clamp(core + collar * 0.5 + star * 0.25, 0.0, 1.0));

  outColor = vec4(col * a, a);
  outNormalDepth = vec4(0.0, 0.0, 0.0, 1.0);
}
`;
