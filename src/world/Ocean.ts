import {
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  GLSL3,
  Mesh,
  ShaderMaterial,
  Uint32BufferAttribute,
  Vector2,
  Vector3,
  Vector4,
  type PerspectiveCamera,
  type Texture,
} from 'three';
import { PALETTE } from '../core/Palette.ts';
import { CEL_COMMON, glslVec3 } from '../render/shaderLib.ts';
import { GERSTNER_GLSL, oceanParams } from './gerstner.ts';
import { packedNoise } from '../render/materials/proceduralTextures.ts';
import { LAYER_OCEAN } from '../render/layers.ts';

/**
 * THE OCEAN
 *
 * Geometry — an exponentially-spaced radial disc locked to the camera's XZ.
 *
 *   Why a radial disc rather than a tiled grid: the disc has *one* piece of
 *   topology that never changes, so there is no LOD transition to pop and no
 *   tile boundary to crack. Vertex density falls off with distance on a smooth
 *   exponential curve, which matches the perspective foreshortening closely
 *   enough that triangles stay roughly pixel-uniform from 2 m to 3 km.
 *
 *   Why it is locked to the camera rather than snapped to a grid: sliding the
 *   mesh continuously under a world-space wave field means vertices never jump,
 *   so there is no popping whatsoever. The cost is a little shimmer at the far
 *   rings, which we kill by damping the short chop with distance (see
 *   `detailFade` in the vertex shader).
 *
 * Shading — banded by height, by view angle and by scene depth, with three
 * independent foam systems (crest, wake field, hull contact) composited on top.
 */

export interface OceanOptions {
  /** Radius of the disc in metres. Should reach the camera far plane. */
  radius?: number;
  /** Angular subdivisions. Drives horizon smoothness. */
  segments?: number;
  /** Radial rings. Drives near-field detail. */
  rings?: number;
}

/** Boat-shaped foam emitters uploaded to the water shader each frame. */
export interface HullContact {
  /** World position of the hull centre. */
  position: Vector3;
  /** Radius of the contact ring. */
  radius: number;
  /** 0..1 intensity — scales with speed and with how hard the hull is buried. */
  strength: number;
  /** Forward direction, used to stretch the ring into a bow wave. */
  forwardX: number;
  forwardZ: number;
}

const MAX_CONTACTS = 6;

export class Ocean {
  readonly mesh: Mesh;
  readonly material: ShaderMaterial;
  private readonly radius: number;

  /** Packed contact data: xyz = position, w = radius. */
  private contactA: Vector4[] = [];
  /** Packed contact data: x = strength, yz = forward, w = unused. */
  private contactB: Vector4[] = [];

  constructor(opts: OceanOptions = {}) {
    this.radius = opts.radius ?? 3200;
    const segments = opts.segments ?? 384;
    const rings = opts.rings ?? 116;

    const geometry = buildRadialDisc(this.radius, segments, rings);

    for (let i = 0; i < MAX_CONTACTS; i++) {
      this.contactA.push(new Vector4(0, -999, 0, 1));
      this.contactB.push(new Vector4(0, 0, 1, 0));
    }

    this.material = new ShaderMaterial({
      name: 'Ocean',
      glslVersion: GLSL3,
      uniforms: {
        uTime: { value: 0 },
        uAmplitude: { value: oceanParams.amplitude },
        uChoppiness: { value: oceanParams.choppiness },
        uCameraXZ: { value: new Vector2() },
        uNoise: { value: packedNoise() },
        uWakeField: { value: null as Texture | null },
        // xy = world centre of the wake field, z = its half-extent, w = enabled
        uWakeParams: { value: new Vector4(0, 0, 260, 0) },
        uSceneDepth: { value: null as Texture | null },
        uResolution: { value: new Vector2(1, 1) },
        uCameraNear: { value: 0.35 },
        uCameraFar: { value: 4000 },
        uContactA: { value: this.contactA },
        uContactB: { value: this.contactB },
        uContactCount: { value: 0 },

        // --- art-direction knobs, all tuned against captured frames ---
        uDeep: { value: PALETTE.waterDeep.clone() },
        uMid: { value: PALETTE.waterMid.clone() },
        uShallow: { value: PALETTE.waterShallow.clone() },
        uCrest: { value: PALETTE.waterCrest.clone() },
        uFoam: { value: PALETTE.foam.clone() },
        uFoamShade: { value: PALETTE.foamShade.clone() },
        uSunTint: { value: PALETTE.sun.clone() },
        uSkyTint: { value: PALETTE.skyMid.clone() },
        uHorizon: { value: PALETTE.skyHorizon.clone() },

        uBandSoftness: { value: 0.012 },
        uCrestFoamThreshold: { value: 0.63 },
        uFoamBreakup: { value: 0.62 },
        uSparkleAmount: { value: 0.85 },
        uSparkleDensity: { value: 1.0 },
        uFogNear: { value: 420 },
        uFogFar: { value: 2600 },
        uDetailFadeStart: { value: 90 },
        uDetailFadeEnd: { value: 700 },
      },
      vertexShader: OCEAN_VERT,
      fragmentShader: OCEAN_FRAG,
    });

    this.mesh = new Mesh(geometry, this.material);
    this.mesh.name = 'Ocean';
    this.mesh.frustumCulled = false; // it is always around the camera
    this.mesh.userData.noOutline = true;
    this.mesh.renderOrder = 0;
    this.mesh.layers.set(LAYER_OCEAN);
  }

  /** Point the wake foam field at a render target texture. */
  setWakeField(texture: Texture | null, centerX: number, centerZ: number, halfExtent: number): void {
    this.material.uniforms.uWakeField.value = texture;
    (this.material.uniforms.uWakeParams.value as Vector4).set(
      centerX,
      centerZ,
      halfExtent,
      texture ? 1 : 0,
    );
  }

  setSceneDepth(texture: Texture | null, width: number, height: number): void {
    this.material.uniforms.uSceneDepth.value = texture;
    (this.material.uniforms.uResolution.value as Vector2).set(width, height);
  }

  /** Upload the per-frame list of hull contact rings. */
  setContacts(contacts: HullContact[]): void {
    const n = Math.min(contacts.length, MAX_CONTACTS);
    for (let i = 0; i < MAX_CONTACTS; i++) {
      if (i < n) {
        const c = contacts[i];
        this.contactA[i].set(c.position.x, c.position.y, c.position.z, c.radius);
        this.contactB[i].set(c.strength, c.forwardX, c.forwardZ, 0);
      } else {
        this.contactA[i].set(0, -9999, 0, 1);
        this.contactB[i].set(0, 0, 1, 0);
      }
    }
    this.material.uniforms.uContactCount.value = n;
  }

  update(camera: PerspectiveCamera, elapsed: number): void {
    const u = this.material.uniforms;
    u.uTime.value = elapsed * oceanParams.timeScale;
    u.uAmplitude.value = oceanParams.amplitude;
    u.uChoppiness.value = oceanParams.choppiness;
    (u.uCameraXZ.value as Vector2).set(camera.position.x, camera.position.z);
    u.uCameraNear.value = camera.near;
    u.uCameraFar.value = camera.far;
    // The disc rides with the camera; the wave field stays in world space.
    this.mesh.position.set(camera.position.x, 0, camera.position.z);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}

/**
 * Exponentially-spaced radial disc.
 *
 * r(t) = R * (exp(k*t) - 1) / (exp(k) - 1),  t in [0,1]
 *
 * With k ~ 7 the innermost rings are ~0.3 m apart and the outermost span
 * hundreds of metres, which tracks 1/z almost exactly. A duplicated outer ring
 * is pushed far below the horizon as a skirt so the disc edge can never be seen
 * even when the camera pitches up on a wave crest.
 */
function buildRadialDisc(radius: number, segments: number, rings: number): BufferGeometry {
  const k = 7.0;
  const denom = Math.exp(k) - 1;

  const positions: number[] = [];
  const ringIndexAttr: number[] = [];

  // Centre vertex.
  positions.push(0, 0, 0);
  ringIndexAttr.push(0);

  for (let ri = 1; ri <= rings; ri++) {
    const t = ri / rings;
    const r = (radius * (Math.exp(k * t) - 1)) / denom;
    for (let si = 0; si < segments; si++) {
      const a = (si / segments) * Math.PI * 2;
      positions.push(Math.cos(a) * r, 0, Math.sin(a) * r);
      ringIndexAttr.push(t);
    }
  }

  // Skirt: one more ring at the same radius but dropped, so the silhouette
  // against the sky is always water, never the disc's cut edge.
  const skirtStart = positions.length / 3;
  for (let si = 0; si < segments; si++) {
    const a = (si / segments) * Math.PI * 2;
    positions.push(Math.cos(a) * radius * 1.4, -140, Math.sin(a) * radius * 1.4);
    ringIndexAttr.push(1);
  }

  const indices: number[] = [];

  // Fan from the centre to ring 1.
  for (let si = 0; si < segments; si++) {
    const a = 1 + si;
    const b = 1 + ((si + 1) % segments);
    indices.push(0, b, a);
  }

  // Quad strips between successive rings.
  for (let ri = 1; ri < rings; ri++) {
    const base = 1 + (ri - 1) * segments;
    const next = 1 + ri * segments;
    for (let si = 0; si < segments; si++) {
      const s0 = si;
      const s1 = (si + 1) % segments;
      const a = base + s0;
      const b = base + s1;
      const c = next + s0;
      const d = next + s1;
      indices.push(a, b, c);
      indices.push(b, d, c);
    }
  }

  // Skirt strip.
  const lastRing = 1 + (rings - 1) * segments;
  for (let si = 0; si < segments; si++) {
    const s0 = si;
    const s1 = (si + 1) % segments;
    const a = lastRing + s0;
    const b = lastRing + s1;
    const c = skirtStart + s0;
    const d = skirtStart + s1;
    indices.push(a, b, c);
    indices.push(b, d, c);
  }

  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geo.setAttribute('ringT', new Float32BufferAttribute(ringIndexAttr, 1));
  geo.setIndex(
    positions.length / 3 > 65535
      ? new Uint32BufferAttribute(indices, 1)
      : new Uint32BufferAttribute(indices, 1),
  );
  geo.boundingSphere = null;
  return geo;
}

// ---------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------

const OCEAN_VERT = /* glsl */ `
precision highp float;

${GERSTNER_GLSL}

uniform float uTime;
uniform float uAmplitude;
uniform float uChoppiness;
uniform vec2 uCameraXZ;
uniform float uDetailFadeStart;
uniform float uDetailFadeEnd;

in float ringT;

out vec3 vWorldPos;
out vec3 vNormal;
out float vJacobian;
out float vCrest;
out float vSlope;
out float vViewDist;
out float vDetail;
out vec4 vClipPos;

void main() {
  // the position attribute is already centred on the camera by the mesh transform, so the
  // model matrix gives us the true world XZ the wave field is defined in.
  vec4 world = modelMatrix * vec4(position, 1.0);
  vec2 xz = world.xz;

  float dist = length(xz - uCameraXZ);

  // Detail fade: past ~90 m the short chop is smaller than a pixel and only
  // produces shimmer, so we roll the amplitude of the whole field down towards
  // the long swell. detail also drives foam/sparkle density in the fragment
  // shader so distant water settles into flat painted bands.
  float detail = 1.0 - smoothstep(uDetailFadeStart, uDetailFadeEnd, dist);
  vDetail = detail;

  float amp = uAmplitude * mix(0.55, 1.0, detail);
  float chop = uChoppiness * mix(0.35, 1.0, detail);

  GerstnerResult g = gerstnerEval(xz, uTime, amp, chop);

  // The skirt ring stays pinned below the horizon.
  vec3 finalPos = position.y < -50.0 ? world.xyz : g.position;

  vWorldPos = finalPos;
  vNormal = g.normal;
  vJacobian = g.jacobian;
  vCrest = g.crest;
  vSlope = g.slope;
  vViewDist = dist;

  vec4 viewPos = viewMatrix * vec4(finalPos, 1.0);
  vClipPos = projectionMatrix * viewPos;
  gl_Position = vClipPos;
}
`;

const OCEAN_FRAG = /* glsl */ `
precision highp float;

layout(location = 0) out vec4 outColor;
layout(location = 1) out vec4 outNormalDepth;

${CEL_COMMON}

uniform float uTime;
uniform sampler2D uNoise;
uniform sampler2D uWakeField;
uniform vec4 uWakeParams;
uniform sampler2D uSceneDepth;
uniform vec2 uResolution;
uniform float uCameraNear;
uniform float uCameraFar;

uniform vec4 uContactA[${MAX_CONTACTS}];
uniform vec4 uContactB[${MAX_CONTACTS}];
uniform int uContactCount;

uniform vec3 uDeep;
uniform vec3 uMid;
uniform vec3 uShallow;
uniform vec3 uCrest;
uniform vec3 uFoam;
uniform vec3 uFoamShade;
uniform vec3 uSunTint;
uniform vec3 uSkyTint;
uniform vec3 uHorizon;

uniform float uBandSoftness;
uniform float uCrestFoamThreshold;
uniform float uFoamBreakup;
uniform float uSparkleAmount;
uniform float uSparkleDensity;
uniform float uFogNear;
uniform float uFogFar;

in vec3 vWorldPos;
in vec3 vNormal;
in float vJacobian;
in float vCrest;
in float vSlope;
in float vViewDist;
in float vDetail;
in vec4 vClipPos;

float noiseR(vec2 uv) { return texture(uNoise, uv).r; }
float noiseG(vec2 uv) { return texture(uNoise, uv).g; }
float noiseB(vec2 uv) { return texture(uNoise, uv).b; }
float noiseA(vec2 uv) { return texture(uNoise, uv).a; }

/**
 * Two-octave scrolling foam breakup.
 *
 * Foam that is a plain noise threshold reads as television static. The fix is
 * to break it up at two very different scales moving in different directions:
 * a large slow field that decides *where* clumps of foam live, and a small
 * faster field that decides the ragged edge of each clump.
 */
float foamNoise(vec2 p, float t) {
  float big = noiseR(p * 0.026 + vec2(t * 0.010, -t * 0.006));
  float small = noiseG(p * 0.115 - vec2(t * 0.031, t * 0.019));
  float fine = noiseA(p * 0.34 + vec2(-t * 0.05, t * 0.041));
  return big * 0.52 + small * 0.33 + fine * 0.15;
}

void main() {
  vec3 N = normalize(vNormal);
  vec3 V = normalize(cameraPosition - vWorldPos);
  float ndv = clamp(dot(N, V), 0.0, 1.0);
  vec2 p = vWorldPos.xz;

  // -----------------------------------------------------------------------
  // 1. BANDED BASE COLOUR
  //
  // The band coordinate mixes three things: how high the point is on the wave,
  // how steeply the face is tilted, and how obliquely we are looking at it.
  // Height alone gives horizontal stripes; adding slope makes the bands follow
  // the *form* of each wave, which is what a background artist would paint.
  // -----------------------------------------------------------------------
  float heightTerm = clamp(vWorldPos.y * 0.30 + 0.5, 0.0, 1.0);
  float slopeTerm = clamp(vSlope * 2.1, 0.0, 1.0);
  float facing = 1.0 - ndv;   // grazing angles read as "deeper"

  float band = heightTerm * 0.62 + slopeTerm * 0.24 - facing * 0.30 + 0.16;
  band = clamp(band, 0.0, 1.0);

  // Hard steps. uBandSoftness is a couple of thousandths — just enough to
  // stop the edges crawling under temporal downsampling, not enough to read as
  // a gradient.
  float s = uBandSoftness;
  float b1 = bandStep(0.30, band, s);
  float b2 = bandStep(0.52, band, s);
  float b3 = bandStep(0.74, band, s);

  vec3 col = uDeep;
  col = mix(col, uMid, b1);
  col = mix(col, uShallow, b2);
  col = mix(col, uCrest, b3);

  // Sun-facing wave faces get a warm lift, still banded.
  float sunFace = bandStep(0.34, dot(N, SUN_DIR), s * 2.0);
  col = mix(col, col * 1.16 + uSunTint * 0.10, sunFace * 0.8);

  // Sky reflection: a hard fresnel step rather than a Schlick curve.
  float fres = pow(1.0 - ndv, 4.0);
  float fresBand = bandStep(0.16, fres, s * 3.0);
  vec3 skyRefl = mix(uSkyTint, uHorizon, clamp(1.0 - N.y * 1.4, 0.0, 1.0));
  col = mix(col, skyRefl, fresBand * 0.34 * (0.4 + 0.6 * vDetail));

  // -----------------------------------------------------------------------
  // 2. CREST FOAM
  //
  // Driven by two signals ANDed together:
  //   - crest proximity from the swell height, so foam sits on wave tops
  //   - the Gerstner jacobian, which dips below 1 exactly where the surface
  //     pinches. Pinching is what physically throws foam, so this puts foam on
  //     the sharp side of each crest rather than symmetrically on top of it.
  // -----------------------------------------------------------------------
  float pinch = clamp((1.0 - vJacobian) * 1.9, 0.0, 1.0);
  float crestSignal = vCrest * 0.62 + pinch * 0.58 + slopeTerm * 0.22;

  float fn = foamNoise(p, uTime);
  // Subtracting noise from the *signal* before thresholding (rather than
  // multiplying it in afterwards) is what gives foam a torn, papery edge
  // instead of a soft dissolve.
  float crestFoam = step(uCrestFoamThreshold, crestSignal - fn * uFoamBreakup + 0.30);

  // A second, tighter threshold makes a bright core inside each foam patch, so
  // the foam has two tones and reads as drawn.
  float crestFoamCore = step(uCrestFoamThreshold + 0.14, crestSignal - fn * uFoamBreakup * 0.8 + 0.30);

  // -----------------------------------------------------------------------
  // 3. WAKE FIELD
  //
  // A world-space foam texture maintained by WakeField.ts: boats stamp into it,
  // it decays and blurs every frame. Sampling it here means the wake is a real
  // persistent field on the water, not a ribbon of geometry dragged behind a
  // boat, so it survives the boat turning, spreads outwards, and dissipates.
  // -----------------------------------------------------------------------
  float wake = 0.0;
  if (uWakeParams.w > 0.5) {
    vec2 wuv = (p - uWakeParams.xy) / (uWakeParams.z * 2.0) + 0.5;
    if (all(greaterThan(wuv, vec2(0.0))) && all(lessThan(wuv, vec2(1.0)))) {
      wake = texture(uWakeField, wuv).r;
    }
  }
  // Break the wake's edge with the same noise so it matches the crest foam's
  // handwriting rather than looking like a painted decal.
  float wakeEdge = step(0.30, wake - fn * 0.34 + 0.12);
  float wakeCore = step(0.62, wake - fn * 0.20 + 0.08);

  // -----------------------------------------------------------------------
  // 4. HULL CONTACT RINGS
  //
  // Analytic distance rings around each hull, stretched forward into a bow
  // wave. These are combined with a screen-space depth-difference term below;
  // the analytic part guarantees a ring even when the hull is fully above the
  // waterline mid-jump, which a pure depth test cannot do.
  // -----------------------------------------------------------------------
  float contact = 0.0;
  for (int i = 0; i < ${MAX_CONTACTS}; i++) {
    if (i >= uContactCount) break;
    vec4 A = uContactA[i];
    vec4 B = uContactB[i];
    vec2 d = p - A.xz;
    // Stretch the ring backwards along the hull's forward axis so the shape is
    // a teardrop: tight at the bow, long at the stern.
    vec2 fwd = normalize(B.yz + vec2(1e-5, 0.0));
    float along = dot(d, fwd);
    float across = dot(d, vec2(-fwd.y, fwd.x));
    float stretch = along > 0.0 ? 1.0 : 0.42;
    vec2 e = vec2(along * stretch, across * 1.35);
    float r = length(e) / max(A.w, 0.1);

    // Vertical falloff: a boat 4 m in the air should not foam the water.
    float vertical = 1.0 - smoothstep(0.6, 3.2, abs(A.y - vWorldPos.y));

    float ring = (1.0 - smoothstep(0.55, 1.15, r)) * B.x * vertical;
    contact = max(contact, ring);
  }
  float contactFoam = step(0.30, contact - fn * 0.42 + 0.16);

  // -----------------------------------------------------------------------
  // 5. DEPTH-DIFFERENCE FOAM
  //
  // Where an opaque surface (a hull, a gate float, a buoy) sits just behind the
  // water surface in screen space, the difference between its linear depth and
  // ours is small — that is the waterline. This is what puts foam exactly on
  // the intersection curve, following the hull's silhouette as it rolls.
  // -----------------------------------------------------------------------
  float depthFoam = 0.0;
  {
    vec2 suv = (vClipPos.xy / vClipPos.w) * 0.5 + 0.5;
    float sceneDepth = texture(uSceneDepth, suv).w * uCameraFar;
    float ourDepth = -(viewMatrix * vec4(vWorldPos, 1.0)).z;
    // sceneDepth of 0 means nothing was drawn there (open sky/water).
    if (sceneDepth > 0.001 && sceneDepth < ourDepth) {
      float diff = ourDepth - sceneDepth;
      float band = 1.0 - smoothstep(0.0, 1.15, diff);
      depthFoam = step(0.34, band - fn * 0.40 + 0.20);
    }
  }

  // -----------------------------------------------------------------------
  // 6. COMPOSITE FOAM
  // -----------------------------------------------------------------------
  float foamMask = max(max(crestFoam, wakeEdge), max(contactFoam, depthFoam));
  float foamCore = max(crestFoamCore, wakeCore);
  // Distant water loses its foam detail rather than boiling into noise.
  foamMask *= mix(0.35, 1.0, vDetail);
  foamCore *= vDetail;

  vec3 foamCol = mix(uFoamShade, uFoam, clamp(foamCore + 0.35, 0.0, 1.0));
  col = mix(col, foamCol, foamMask);

  // -----------------------------------------------------------------------
  // 7. SPARKLE
  //
  // Quantised specular glitter. The field is a hard-thresholded noise lattice
  // that flickers on a per-cell phase, so individual sparkles pop on and off as
  // discrete shapes — anime light-glitter — instead of a shimmering specular
  // lobe. Only appears where the surface actually faces the sun.
  // -----------------------------------------------------------------------
  vec3 H = normalize(SUN_DIR + V);
  float specRaw = pow(max(dot(N, H), 0.0), 90.0);
  float specGate = bandStep(0.06, specRaw, 0.02);

  vec2 sp = p * (0.62 * uSparkleDensity);
  float cellPhase = hash21(floor(sp)) * 6.2831;
  float twinkle = sin(uTime * 3.1 + cellPhase) * 0.5 + 0.5;
  float sparkleField = noiseB(sp * 0.25 + vec2(uTime * 0.004, -uTime * 0.003));
  float sparkle = step(0.80, sparkleField * 0.55 + twinkle * 0.55) * specGate;
  // A second, rarer, larger sparkle for punctuation.
  float bigSparkle = step(0.94, sparkleField * 0.5 + twinkle * 0.6) * specGate;

  col += (sparkle * 0.55 + bigSparkle * 0.9) * uSunTint * uSparkleAmount * vDetail * (1.0 - foamMask);

  // Broad hard sun glitter path on the water towards the sun, banded.
  float glitterPath = bandStep(0.55, specRaw * 6.0, 0.05);
  col = mix(col, uFoam, glitterPath * 0.18 * vDetail * (1.0 - foamMask));

  // -----------------------------------------------------------------------
  // 8. HAZE
  // -----------------------------------------------------------------------
  float fogT = clamp((vViewDist - uFogNear) / max(uFogFar - uFogNear, 1.0), 0.0, 1.0);
  fogT = floor(fogT * 6.0 + 0.4) / 6.0;
  col = mix(col, uHorizon, fogT * 0.86);

  outColor = vec4(col, 1.0);

  // The ocean writes into the edge buffer with a flattened normal: we want the
  // Sobel pass to find the waterline against boats, but not to trace every
  // wave crest, which would fill the frame with lines.
  vec3 viewN = normalize((viewMatrix * vec4(mix(vec3(0.0, 1.0, 0.0), N, 0.25), 0.0)).xyz);
  float viewDepth = -(viewMatrix * vec4(vWorldPos, 1.0)).z;
  outNormalDepth = vec4(viewN * 0.5 + 0.5, clamp(viewDepth / uCameraFar, 0.0, 1.0));
}
`;
