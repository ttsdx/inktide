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
      sun.scale.setScalar(0.4);
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
        uCoverage: { value: 0.52 },
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

// 4x4 Bayer matrix, used to break band edges without softening them.
float bayer(vec2 p) {
  int x = int(mod(p.x, 4.0));
  int y = int(mod(p.y, 4.0));
  int i = y * 4 + x;
  float m[16] = float[16](
     0.0,  8.0,  2.0, 10.0,
    12.0,  4.0, 14.0,  6.0,
     3.0, 11.0,  1.0,  9.0,
    15.0,  7.0, 13.0,  5.0);
  return m[i] / 16.0 - 0.5;
}

/**
 * Pick one of five flat colours from a 0..1 param (0 = zenith, 1 = horizon).
 *
 * The band edge is displaced by the dither value rather than blended across,
 * so each pixel still lands on exactly one of the five palette colours. At
 * viewing distance the scattered edge reads as a soft transition while the
 * frame remains genuinely flat-shaded — no interpolated in-between tones.
 */
vec3 bandedSky(float t, float dither) {
  float x = clamp(t, 0.0, 1.0) * 4.0 + dither * 0.85;
  int i = int(clamp(floor(x), 0.0, 3.0));
  vec3 a = i == 0 ? C0 : i == 1 ? C1 : i == 2 ? C2 : C3;
  vec3 b = i == 0 ? C1 : i == 1 ? C2 : i == 2 ? C3 : C4;
  return fract(clamp(x, 0.0, 4.0)) > 0.5 ? b : a;
}

void main() {
  vec3 d = normalize(vDir);
  float h = clamp(d.y, -0.25, 1.0);

  // 0 at the zenith, 1 at the horizon. The pow() compresses the gradient down
  // towards the horizon, where the camera actually spends its time — the top
  // of the dome stays a single deep cobalt field.
  float t = 1.0 - pow(clamp(h, 0.0, 1.0), 0.52);

  float dith = bayer(gl_FragCoord.xy);
  vec3 col = bandedSky(t, dith);

  // Warm glow packed around the sun, quantised into three steps so it stays a
  // graphic shape instead of a soft photographic bloom.
  float sd = max(dot(d, normalize(uSunDir)), 0.0);
  float glow = pow(sd, 12.0);
  glow = floor(glow * 3.0 + dith * 0.3) / 3.0;
  col = mix(col, ${glslVec3(PALETTE.sun)}, glow * 0.5);

  // A single hard haze band riding the horizon line, which gives the ocean
  // something to meet instead of fading into nothing.
  float band = 1.0 - smoothstep(0.0, 0.042, abs(d.y - 0.008));
  col = mix(col, C4, band * 0.55);

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
  // The lit rim: sample the field shifted *towards* the sun. Where the shifted
  // sample is outside the cloud but the base sample is inside, we are on the
  // sun-facing edge.
  vec2 sunBias = normalize(uSunDir.xz) * 0.030;
  float shifted = cloudDensity(d, sunBias);

  float inside = step(thr, body);
  if (inside < 0.5) { outColor = vec4(0.0); outNormalDepth = vec4(0.0, 0.0, 0.0, 1.0); return; }

  float rim = step(shifted, thr);                 // sun-facing hard rim
  float core = step(thr + 0.085, body);           // dense interior
  float deep = step(thr + 0.155, body);           // shadowed underbelly

  vec3 col = CLOUD_MID;
  col = mix(col, CLOUD_SHADE, core * (1.0 - rim));
  col = mix(col, CLOUD_SHADE * 0.88, deep * (1.0 - rim));
  col = mix(col, CLOUD_LIT, rim);

  // Clouds close to the sun pick up its warmth on the rim only.
  float sd = max(dot(d, normalize(uSunDir)), 0.0);
  col = mix(col, SUN_TINT, rim * pow(sd, 3.0) * 0.85);

  // Soften only the outermost pixel of the silhouette so the edge is crisp but
  // not aliased into a staircase.
  float alpha = smoothstep(thr, thr + 0.012, body);
  // Distant clouds thin out towards the horizon haze.
  alpha *= smoothstep(0.03, 0.13, d.y);

  outColor = vec4(col, alpha * 0.96);
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

void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  float ang = atan(p.y, p.x);

  // Hard core disc with a single crisp ring just outside it.
  float disc = 1.0 - smoothstep(0.155, 0.175, r);
  float ring = (1.0 - smoothstep(0.235, 0.252, r)) * smoothstep(0.205, 0.222, r);

  // Quantised halo: four discrete steps rather than a smooth falloff.
  float halo = 1.0 - smoothstep(0.16, 0.95, r);
  halo = floor(halo * 4.0) / 4.0;

  // Six-spoke star. The spokes breathe very slightly so the sun feels alive
  // without ever becoming a photographic anamorphic streak.
  float spokes = pow(abs(cos(ang * 3.0)), 26.0);
  float breathe = 0.86 + 0.14 * sin(uTime * 0.9);
  float star = spokes * (1.0 - smoothstep(0.1, 0.92 * breathe, r));
  star = floor(star * 3.0 + 0.2) / 3.0;

  float a = clamp(disc + ring * 0.85 + halo * 0.30 + star * 0.42, 0.0, 1.0);
  vec3 col = mix(GLOW, CORE, clamp(disc + star * 0.4, 0.0, 1.0));

  outColor = vec4(col * a, a);
  outNormalDepth = vec4(0.0, 0.0, 0.0, 1.0);
}
`;
