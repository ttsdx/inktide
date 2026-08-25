import {
  BufferGeometry,
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
import { CEL_COMMON } from '../render/shaderLib.ts';
import { GERSTNER_GLSL, MAX_WAVE_HEIGHT, oceanParams } from './gerstner.ts';
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
 * Shading — the frame is composited as separate painted layers rather than one
 * lighting equation, because that is how the reference art is actually made:
 *
 *   1. a four-tone body, banded on a *view-independent* coordinate
 *   2. a hard sun-facing plane on top of it
 *   3. a drawn contour line along every crest ridge
 *   4. a quantised horizon/fresnel lift
 *   5. four independent foam systems, each with a bright core, a shaded body
 *      and a torn edge
 *   6. quantised star glints
 *   7. a stepped haze that resolves the far field into flat painted bands
 *
 * Keeping those separate is the whole reason the water survives every camera
 * angle in the shot list: no single term is load-bearing, so no single term can
 * collapse and take the frame with it.
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

export type OceanQuality = 'low' | 'medium' | 'high' | 'ultra';

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
    const rings = opts.rings ?? 132;

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
        /** Crest height of the full wave sum — normalises the height band. */
        uWaveScale: { value: MAX_WAVE_HEIGHT * oceanParams.amplitude },
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

        /** Floor on band-edge width, in band units. Anti-aliasing does the rest. */
        uBandSoftness: { value: 0.004 },
        /** Band thresholds along the shading coordinate. */
        uBands: { value: new Vector3(0.27, 0.5, 0.73) },
        /** Weights: x = N·L form, y = swell height, z = total height. */
        uBandMix: { value: new Vector3(0.5, 0.32, 0.18) },
        /** Fold (1 - jacobian) at which foam starts. */
        uFoamFold: { value: 0.34 },
        /** Fold window for the drawn crest contour, just below the foam. */
        uRimFold: { value: new Vector2(0.2, 0.3) },
        uFoamBreakup: { value: 0.34 },
        uSparkleAmount: { value: 1.0 },
        uSparkleDensity: { value: 0.62 },
        uDetailStrength: { value: 1.0 },
        uFogNear: { value: 240 },
        uFogFar: { value: 1900 },
        uDetailFadeStart: { value: 110 },
        uDetailFadeEnd: { value: 760 },
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

  /**
   * The per-pixel ripple and the sparkle lattice are the only parts of the
   * water that scale with fill rate rather than vertex count, so they are what
   * the quality tiers move. The band structure never changes — dropping tiers
   * must not change the art direction, only the density of the detail on it.
   */
  setQuality(tier: OceanQuality): void {
    const u = this.material.uniforms;
    switch (tier) {
      case 'low':
        u.uDetailStrength.value = 0.0;
        u.uSparkleAmount.value = 0.55;
        u.uDetailFadeStart.value = 55;
        u.uDetailFadeEnd.value = 340;
        break;
      case 'medium':
        u.uDetailStrength.value = 0.6;
        u.uSparkleAmount.value = 0.85;
        u.uDetailFadeStart.value = 80;
        u.uDetailFadeEnd.value = 520;
        break;
      case 'high':
        u.uDetailStrength.value = 1.0;
        u.uSparkleAmount.value = 1.0;
        u.uDetailFadeStart.value = 110;
        u.uDetailFadeEnd.value = 760;
        break;
      case 'ultra':
        u.uDetailStrength.value = 1.0;
        u.uSparkleAmount.value = 1.0;
        u.uDetailFadeStart.value = 150;
        u.uDetailFadeEnd.value = 900;
        break;
    }
  }

  update(camera: PerspectiveCamera, elapsed: number): void {
    const u = this.material.uniforms;
    u.uTime.value = elapsed * oceanParams.timeScale;
    u.uAmplitude.value = oceanParams.amplitude;
    u.uChoppiness.value = oceanParams.choppiness;
    u.uWaveScale.value = MAX_WAVE_HEIGHT * oceanParams.amplitude;
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
 * k is the whole tuning story. At k = 7 the curve spends so many rings inside
 * the first ten metres that the 100–700 m range — which is most of the pixels
 * in any horizon shot — gets triangles two hundred metres across, and a
 * triangle wider than the 112 m swell aliases into the horizontal stripes that
 * the first capture shows across the whole mid-distance. k = 6.1 keeps the
 * innermost ring at ~0.35 m (still finer than a pixel at the near plane) while
 * roughly halving the mid-field spacing.
 *
 * A duplicated outer ring is pushed far below the horizon as a skirt so the
 * disc edge can never be seen even when the camera pitches up on a wave crest.
 */
function buildRadialDisc(radius: number, segments: number, rings: number): BufferGeometry {
  const k = 6.1;
  const denom = Math.exp(k) - 1;

  const positions: number[] = [];
  const ringIndexAttr: number[] = [];

  // Centre vertex.
  positions.push(0, 0, 0);
  ringIndexAttr.push(0);

  for (let ri = 1; ri <= rings; ri++) {
    const t = ri / rings;
    const r = (radius * (Math.exp(k * t) - 1)) / denom;
    // Twist each ring by a fixed irrational fraction of a segment. Without it
    // every ring's vertices line up on the same `segments` radial lines and the
    // triangle diagonals form continuous spokes running out from the camera,
    // which catch the light as faint radial streaks at high camera angles.
    const twist = ri * 0.381966 * ((Math.PI * 2) / segments);
    for (let si = 0; si < segments; si++) {
      const a = (si / segments) * Math.PI * 2 + twist;
      positions.push(Math.cos(a) * r, 0, Math.sin(a) * r);
      ringIndexAttr.push(t);
    }
  }

  // Skirt: one more ring at the same radius but dropped, so the silhouette
  // against the sky is always water, never the disc's cut edge.
  const skirtStart = positions.length / 3;
  const skirtTwist = (rings + 1) * 0.381966 * ((Math.PI * 2) / segments);
  for (let si = 0; si < segments; si++) {
    const a = (si / segments) * Math.PI * 2 + skirtTwist;
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
      // Alternate the diagonal so the quad grid does not develop a preferred
      // shear direction — a uniform diagonal is visible as a herringbone at
      // grazing angles once the waves stretch the triangles.
      if ((ri + si) % 2 === 0) {
        indices.push(a, b, c);
        indices.push(b, d, c);
      } else {
        indices.push(a, d, c);
        indices.push(a, b, d);
      }
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
  geo.setIndex(new Uint32BufferAttribute(indices, 1));
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
uniform float uWaveScale;
uniform vec2 uCameraXZ;
uniform float uDetailFadeStart;
uniform float uDetailFadeEnd;

in float ringT;

out vec3 vWorldPos;
out vec3 vNormal;
out float vFold;
out float vSwell;
out float vHeight;
out float vViewDist;
out float vDetail;
out vec4 vClipPos;

void main() {
  // the position attribute is already centred on the camera by the mesh transform, so the
  // model matrix gives us the true world XZ the wave field is defined in.
  vec4 world = modelMatrix * vec4(position, 1.0);
  vec2 xz = world.xz;

  float dist = length(xz - uCameraXZ);

  // Detail fade: past ~110 m the short chop is smaller than a pixel and only
  // produces shimmer, so we roll the amplitude of the whole field down towards
  // the long swell. detail also drives foam/sparkle density in the fragment
  // shader so distant water settles into flat painted bands.
  float detail = 1.0 - smoothstep(uDetailFadeStart, uDetailFadeEnd, dist);
  vDetail = detail;

  float amp = uAmplitude * mix(0.55, 1.0, detail);
  // Choppiness falls off harder than amplitude. The horizontal pinch is what
  // sharpens a crest into a single bright pixel, and a single bright pixel at
  // 600 m is a firefly that crawls across the frame every time the camera moves.
  float chop = uChoppiness * mix(0.22, 1.0, detail * detail);

  GerstnerResult g = gerstnerEval(xz, uTime, amp, chop);

  // The skirt ring stays pinned below the horizon.
  vec3 finalPos = position.y < -50.0 ? world.xyz : g.position;

  vWorldPos = finalPos;
  vNormal = g.normal;
  // The jacobian dips below 1 exactly where the horizontal displacement folds,
  // i.e. on the sharp side of a crest. Carry it as "fold" (0 = flat, ~0.5 at a
  // hard crest) because every foam and contour threshold downstream is written
  // in those terms and reads better than "one minus a determinant".
  vFold = clamp(1.0 - g.jacobian, 0.0, 1.0);
  vSwell = g.crest;
  // Normalised total height. Divided by the theoretical crest so the band
  // coordinate is invariant to the global amplitude knob — retuning the swell
  // must not retune the colour.
  vHeight = clamp(g.position.y / max(uWaveScale, 0.001) * 0.5 + 0.5, 0.0, 1.0);
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
uniform vec3 uBands;
uniform vec3 uBandMix;
uniform float uFoamFold;
uniform vec2 uRimFold;
uniform float uFoamBreakup;
uniform float uSparkleAmount;
uniform float uSparkleDensity;
uniform float uDetailStrength;
uniform float uFogNear;
uniform float uFogFar;

in vec3 vWorldPos;
in vec3 vNormal;
in float vFold;
in float vSwell;
in float vHeight;
in float vViewDist;
in float vDetail;
in vec4 vClipPos;

float noiseR(vec2 uv) { return texture(uNoise, uv).r; }
float noiseG(vec2 uv) { return texture(uNoise, uv).g; }
float noiseB(vec2 uv) { return texture(uNoise, uv).b; }
float noiseA(vec2 uv) { return texture(uNoise, uv).a; }

/**
 * SCREEN-AWARE HARD STEP — the single most important function in this shader.
 *
 * A fixed-width smoothstep cannot be a cel band at every distance. Near the
 * camera the shading coordinate crawls across hundreds of pixels, so a width
 * of a few thousandths smears into a soft gradient — which is exactly why the
 * first capture's mid-distance bands read as mushy drybrush. Far away the same
 * coordinate swings by half a band between adjacent pixels, so a genuinely
 * hard step aliases into crawling stripes.
 *
 * fwidth gives us the coordinate's rate of change *in this pixel*, so we can
 * ask for an edge that is always about one pixel wide: infinitely hard where
 * the surface is flat on screen, and just soft enough to resolve where it is
 * not. A quantising floor is the enemy here: this stays a hard step wherever
 * the geometry lets it be one.
 */
float hardStep(float edge, float x) {
  float w = max(fwidth(x) * 0.62, uBandSoftness);
  return smoothstep(edge - w, edge + w, x);
}

/** Same idea with an explicit width, for use inside divergent branches. */
float fixedStep(float edge, float x, float w) {
  return smoothstep(edge - w, edge + w, x);
}

/**
 * ONE RIPPLE OCTAVE, BAND-LIMITED TO THE PIXEL.
 *
 * px is the world-space width of the pixel being shaded. An octave whose
 * wavelength is only a few pixels across carries no shape a viewer can read,
 * it only aliases, so it is faded out entirely rather than left to crawl. This
 * is a mip chain computed analytically, and it is the reason one ripple field
 * can serve both a two-metre close-up and a forty-metre overview: the close-up
 * gets all five octaves, the overview automatically gets the coarse two.
 *
 * Steepness rather than amplitude is the input, because steepness (a*k) is
 * what the normal actually sees and it is the quantity that has to stay
 * bounded across octaves.
 *
 * Returns (gradient.x, gradient.z, height).
 */
vec3 rippleOctave(
  vec2 p, float t, vec2 dir, float wavelength, float steep, float speed, float phase, float px
) {
  float w = 1.0 - smoothstep(wavelength * 0.11, wavelength * 0.34, px);
  if (w <= 0.001) return vec3(0.0);
  float k = 6.28318 / wavelength;
  float ph = k * dot(dir, p) - sqrt(9.81 * k) * speed * t + phase;
  return vec3(dir * (steep * w) * cos(ph), (steep / k) * w * sin(ph));
}

/**
 * PER-PIXEL DETAIL RIPPLE
 *
 * The disc has plenty of vertices inside ten metres, but the shading
 * coordinate is a *smooth* function of them, so the near field resolves into a
 * handful of enormous lozenges — the worst defect in the first two captures.
 * This field is evaluated per pixel to add the form the vertex shader cannot
 * afford to carry.
 *
 * It is deliberately NOT part of the Gerstner sum: gerstner.ts is the shared
 * contract with buoyancy, and a fourth octave of chop in the vertex shader
 * would alias at range for no gain.
 *
 * Two things stop it reading as a pattern. Progressive domain warping — every
 * finer octave is evaluated in a space dragged sideways by the coarser one's
 * slope — because a handful of pure sinusoids at fixed directions tiles, and
 * the third capture came back covered in a regular fish-scale lattice. And a
 * very low frequency gust gate, because a real sea is not uniformly rippled:
 * chop arrives in drifting cat's-paws, and gating on that is both truer and
 * the cheapest possible decorrelator.
 *
 * Returns (gradient.x, gradient.z, height). The height feeds the shading
 * coordinate as well as the gradient, so the ripple contributes its own form
 * to the band shapes rather than only re-lighting the swell's.
 */
vec3 detailWave(vec2 p, float t, float px) {
  float gust = 0.35 + 0.95 * noiseR(p * 0.0062 + vec2(t * 0.0035, -t * 0.0027));

  vec3 a = rippleOctave(p, t, vec2( 0.8607,  0.5091), 11.30, 0.170, 1.00, 0.0, px);
  vec2 q = p + a.xy * 2.6;
  vec3 b = rippleOctave(q, t, vec2(-0.3894,  0.9211),  6.70, 0.145, 1.28, 2.1, px);
  q += b.xy * 1.7;
  vec3 c = rippleOctave(q, t, vec2( 0.6402, -0.7682),  3.90, 0.120, 1.55, 4.3, px);
  q += c.xy * 1.1;
  vec3 d = rippleOctave(q, t, vec2(-0.9563, -0.2924),  2.30, 0.098, 1.82, 1.2, px);
  q += d.xy * 0.7;
  vec3 e = rippleOctave(q, t, vec2( 0.2079,  0.9781),  1.31, 0.072, 2.10, 5.6, px);
  // The last two octaves exist for the close-up shot alone: at three metres a
  // 1.3 m ripple is still the size of a dinner plate on screen, and the water
  // came back as flat cyan continents. Everywhere else px has already faded
  // them to nothing, so they cost only the two smoothsteps that reject them.
  q += e.xy * 0.5;
  vec3 f = rippleOctave(q, t, vec2(-0.6820, 0.7314), 0.78, 0.055, 2.42, 3.0, px);
  q += f.xy * 0.35;
  vec3 g = rippleOctave(q, t, vec2( 0.9911, -0.1332), 0.44, 0.042, 2.75, 0.6, px);

  return (a + b + c + d + e + f + g) * gust;
}

/**
 * Three-octave scrolling foam breakup, centred on zero.
 *
 * Foam that is a plain noise threshold reads as television static. The fix is
 * to break it up at three very different scales moving in different
 * directions: a large slow field that decides *where* clumps of foam live, a
 * mid field that gives each clump its silhouette, and a fine field that tears
 * the edge. Centring on zero matters — the noise is subtracted from the foam
 * *signal* before thresholding, and a noise with a non-zero mean would drag
 * every threshold in this file off its tuned value.
 */
float foamNoise(vec2 p, float t) {
  // Squash the sampling frame along the primary swell's direction of travel.
  // Foam is torn off a crest and dragged down the face, so its grain runs
  // *along* the crest line, not isotropically: an unsquashed noise gives round
  // blobs of foam, which is the difference between spume and cotton wool. The
  // direction is the first entry of the WAVES table, normalised.
  vec2 dir = vec2(0.9550, 0.2965);
  vec2 s = vec2(dot(p, dir) * 2.05, dot(p, vec2(-dir.y, dir.x)) * 0.48);

  float big = noiseR(s * 0.021 + vec2(t * 0.009, -t * 0.005));
  float mid = noiseG(s * 0.098 - vec2(t * 0.028, t * 0.017));
  float fine = noiseA(s * 0.29 + vec2(-t * 0.046, t * 0.038));
  return (big * 0.46 + mid * 0.34 + fine * 0.20) - 0.5;
}

/**
 * ANIME LIGHT-GLITTER
 *
 * A jittered lattice where each cell owns exactly one glint. The cell picks its
 * own position, phase, period and size from a hash, and is only lit for a short
 * window of its cycle, so glints pop on and off as discrete shapes instead of a
 * specular lobe breathing. The shape is a four-point star (an L1 distance
 * pinched along both axes), not a disc, because a disc at this size is
 * indistinguishable from noise once the bloom pass gets hold of it.
 *
 * Returns the glint mask; the out parameter receives the rarer, larger
 * punctuation glints.
 */
float glitter(vec2 p, float t, float density, out float big) {
  vec2 sp = p * density;
  vec2 cell = floor(sp);
  vec2 f = fract(sp);

  float h0 = hash21(cell);
  float h1 = hash21(cell + vec2(37.7, 11.3));
  float h2 = hash21(cell + vec2(-19.1, 61.9));

  // Each glint lives somewhere inside its cell, never on the lattice.
  vec2 d = f - vec2(h0, h1);

  // Short on-window: 1 - |2*phase - 1| peaks at 1 once per cycle. Thresholding
  // it high means the cell is dark most of the time, which is what stops the
  // whole surface from twinkling at once like a Christmas tree.
  float phase = fract(t * (0.42 + h2 * 0.55) + h0 * 7.13);
  float pulse = 1.0 - abs(phase * 2.0 - 1.0);
  float on = step(0.74, pulse);
  float onBig = step(0.93, pulse);

  // Four-point star: L1 distance, then pushed in hard along whichever axis is
  // closer to zero so the shape grows arms.
  float star = abs(d.x) + abs(d.y) + min(abs(d.x), abs(d.y)) * 2.6;

  // Two discrete sizes rather than a continuum — the same reason the opacity
  // of a drawn highlight is one of two values, never a ramp.
  float size = mix(0.09, 0.16, step(0.62, h2));

  big = step(star, size * 1.9) * onBig;
  return step(star, size) * on;
}

void main() {
  vec2 p = vWorldPos.xz;

  // -----------------------------------------------------------------------
  // 0. SURFACE NORMAL
  // -----------------------------------------------------------------------
  // World-space width of this pixel. Every scale-dependent decision below is
  // made against it rather than against distance, because distance is the
  // wrong variable: a pixel forty metres away in a top-down shot and a pixel
  // forty metres away in a grazing shot cover wildly different amounts of
  // water, and it is the amount of water that decides what can be resolved.
  float px = max(length(fwidth(p)), 1e-4);

  /**
   * THE PRE-FILTER.
   *
   * How much of the band structure this pixel can actually hold. Not optional,
   * and the single least obvious thing in this file.
   *
   * At a grazing angle the disc's rings fall below a pixel, so multisampling
   * resolves several triangles into every pixel and the frame's own resolve
   * averages the bands for us — and the average of a navy trough, a mid blue,
   * a cyan crest and white foam is slate grey. Measured on the crest close-up:
   * rgb(65,89,101) with 4x MSAA against rgb(57,186,201) for the same water
   * with it off. Nothing in the shading was wrong; there was simply more
   * contrast in the pixel than the pixel could carry.
   *
   * So we do the averaging ourselves, towards a colour we chose. Distant and
   * grazing water settles into a flat, saturated painted band instead of dirt,
   * which is what the reference art does anyway — a background painter does not
   * render every wave at the horizon, they paint one flat shape.
   */
  float resolve = 1.0 - smoothstep(0.35, 2.2, px);
  float detail = min(vDetail, resolve);

  float detailAmt = uDetailStrength * detail;
  vec3 dw = detailWave(p, uTime, px) * detailAmt;
  vec3 N = normalize(vec3(vNormal.x - dw.x, vNormal.y, vNormal.z - dw.y));
  vec3 V = normalize(cameraPosition - vWorldPos);
  float ndv = clamp(dot(N, V), 0.0, 1.0);
  float ndl = dot(N, SUN_DIR);

  // -----------------------------------------------------------------------
  // 1. THE SHADING COORDINATE — view-INDEPENDENT, by design
  //
  // The previous implementation folded (1 - N·V) into this, which collapses
  // the entire near field into a single band: at chase-cam height every pixel
  // within twenty metres is seen at a grazing angle, so every one of them got
  // the same bias and the bottom third of the frame turned into one flat
  // wash. A background painter chooses the tone of a wave from its *form* and
  // its *height*, never from where the viewer is standing. So do we.
  //
  //   formT   N·L. The classic cel diffuse — makes the bands wrap the wave
  //           shape, and stays fully expressive at every view angle. Remapped
  //           from the range flat-ish water actually produces (the sun sits at
  //           y = 0.62, so a level surface reads 0.62, not 1.0) rather than
  //           from [-1,1], which would waste three quarters of the ramp.
  //   swellT  position on the long rollers: the big painted shapes that read
  //           from across the frame.
  //   heightT total displaced height, which puts the chop back in near camera.
  // -----------------------------------------------------------------------
  float formT = clamp((ndl - 0.16) / 0.78, 0.0, 1.0);

  // Past the detail-fade window the surface normal is carried by triangles
  // tens of metres wide, so N·L stops describing a wave and starts describing
  // the tessellation — which is what put the scratchy dark streaks through the
  // 50–150 m band of the second capture. Roll the coordinate's weight over to
  // the swell, which is smooth at any triangle size, as detail dies. Total
  // weight is conserved so the band thresholds do not have to move with it.
  float formMix = mix(0.40, 1.0, detail);
  float swellW = uBandMix.y + uBandMix.x * (1.0 - formMix);
  float bandBase = vSwell * swellW + vHeight * uBandMix.z;
  float band = formT * uBandMix.x * formMix + bandBase + dw.z * 0.19;

  // The same coordinate with the per-pixel ripple removed. A painted shadow
  // shape is large and simple — the detail lives in the light. Cutting the
  // darkest tone against the full ripple instead produced the swarm of little
  // dark commas that covers the foreground of the third capture, so the deep
  // band is cut almost entirely against the broad surface and each successive
  // band picks up more of the detail.
  float formBroad = clamp((dot(normalize(vNormal), SUN_DIR) - 0.16) / 0.78, 0.0, 1.0);
  float bandBroad = formBroad * uBandMix.x * formMix + bandBase;

  float b1 = hardStep(uBands.x, mix(band, bandBroad, 0.62));
  float b2 = hardStep(uBands.y, mix(band, bandBroad, 0.35));
  float b3 = hardStep(uBands.z, band);

  // The deepest tone is lifted a fifth of the way towards the mid blue. Raw
  // waterDeep does not survive the composite: the grade pushes saturation to
  // 1.14, which drives its already tiny red channel negative and clips it, so
  // the trough measured as rgb(0,1,89) — an almost-black hole punched in the
  // surface rather than the bottom band of an ocean. The lift is still made of
  // palette colours; it only stops the pipeline from eating one of them.
  vec3 col = mix(uDeep, uMid, 0.2);
  col = mix(col, uMid, b1);
  col = mix(col, uShallow, b2);
  col = mix(col, uCrest, b3);

  // -----------------------------------------------------------------------
  // 2. THE SUN PLANE
  //
  // One extra hard-edged tone on faces turned into the key light. It is a
  // *separate layer* over the band ramp rather than another threshold on the
  // same coordinate, so it can cross band boundaries — which is what makes a
  // wave face read as one lit plane instead of a stack of stripes.
  //
  // It has to be an absolute colour, not a tint of whatever is underneath.
  // Mixing warm cream into the deep navy band and scaling up — the obvious
  // thing, and what the previous pass did — produced the olive-khaki crest
  // tops in the close-up capture, because desaturating a blue towards a cream
  // passes straight through grey-green on the way.
  // -----------------------------------------------------------------------
  float sunPlane = hardStep(0.86, formT);
  col = mix(col, mix(uCrest, uSunTint, 0.28), sunPlane * 0.82);

  // -----------------------------------------------------------------------
  // 3. HORIZON / FRESNEL LIFT
  //
  // Water seen edge-on returns the sky, which is why a real ocean gets paler
  // towards the horizon. The first implementation did this by mixing a third
  // of the pale sky colour into the deep navy, which desaturated the whole
  // near field into the grey-mauve wash the capture shows.
  //
  // Two fixes. The lift now targets uCrest — a colour from the *ocean* family,
  // so it can never grey the water out — and it is quantised into three steps
  // so it lands as flat painted planes rather than a gradient. The sky colour
  // is folded in only in the last step, and only far away, where it is a
  // horizon effect rather than a wash over the boat's own water.
  // -----------------------------------------------------------------------
  float fres = pow(1.0 - ndv, 4.5);
  float distLift = smoothstep(90.0, 900.0, vViewDist);
  float lift = clamp(fres * 0.75 + distLift * 0.75, 0.0, 1.0);
  lift = floor(lift * 3.0 + 0.25) / 3.0;
  vec3 liftCol = mix(uCrest, uSkyTint, distLift * 0.55);
  col = mix(col, liftCol, lift * 0.42);

  // -----------------------------------------------------------------------
  // 4. CREST CONTOUR
  //
  // A drawn line along every crest ridge, just below where the foam starts.
  // The fold measure peaks exactly on the ridge, so thresholding a narrow
  // *window* of fold values traces a contour along it — the cyan ink line an
  // animator puts on top of a wave before painting the white.
  // -----------------------------------------------------------------------
  float rimLo = hardStep(uRimFold.x, vFold);
  float rimHi = hardStep(uRimFold.y, vFold);
  float crestGate = smoothstep(0.34, 0.72, vSwell);
  // Gated on the swell as well as the fold, or the contour appears on every
  // ripple in the trough too and the surface fills with cyan confetti.
  float contour = clamp(rimLo - rimHi, 0.0, 1.0) * detail * crestGate;
  col = mix(col, uCrest * 1.3, contour * 0.8);

  // -----------------------------------------------------------------------
  // 5. FOAM SOURCE A — CREST FOAM
  //
  // Driven by the fold alone, gated by swell height. The first implementation
  // *added* crest proximity, pinch and slope together and thresholded the sum,
  // which meant any two of the three could carry a pixel over the line — and
  // at a high camera angle they routinely did, burying half the ocean in the
  // white continents the third capture shows. Multiplying by a gate instead of
  // adding means foam needs a genuine fold AND a genuine crest, which is also
  // the physical condition for a wave to actually break.
  // -----------------------------------------------------------------------
  // Apply the pre-filter to the painted body before any foam goes on top.
  // Foam is excluded on purpose: white on blue survives averaging perfectly
  // well, and the far field needs its crest highlights to keep a silhouette.
  vec3 flatTone = mix(uMid, uShallow, 0.55);
  col = mix(flatTone, col, mix(0.28, 1.0, resolve));

  float fn = foamNoise(p, uTime);
  float crestSignal = vFold * crestGate;

  // -----------------------------------------------------------------------
  // 6. FOAM SOURCE B — THE PERSISTENT WAKE FIELD
  //
  // A world-space foam texture maintained by WakeField.ts: boats stamp into
  // it, it decays and blurs every frame. Sampling it here means the wake is a
  // real field on the water rather than a ribbon of geometry dragged behind a
  // boat, so it survives the boat turning, spreads outwards, and dissipates.
  // R is the foam amount, G is how fresh it is — fresh wake gets the bright
  // core, old wake settles into the shaded tone.
  // -----------------------------------------------------------------------
  float wake = 0.0;
  float wakeFresh = 0.0;
  if (uWakeParams.w > 0.5) {
    vec2 wuv = (p - uWakeParams.xy) / (uWakeParams.z * 2.0) + 0.5;
    vec2 inside = step(vec2(0.0), wuv) * step(wuv, vec2(1.0));
    vec2 wf = texture(uWakeField, wuv).rg * (inside.x * inside.y);
    // Feather the last few percent of the field so a wake never ends on the
    // straight edge of the render target when the boat outruns the recentre.
    vec2 e = min(wuv, 1.0 - wuv);
    wake = wf.r * smoothstep(0.0, 0.035, min(e.x, e.y));
    wakeFresh = wf.g;
  }

  // -----------------------------------------------------------------------
  // 7. FOAM SOURCE C — ANALYTIC HULL CONTACT RINGS
  //
  // Stretched teardrops around each hull: tight at the bow, long at the stern.
  // These are combined with the screen-space depth term below; the analytic
  // part guarantees a ring even when the hull is fully above the waterline
  // mid-jump, which a pure depth test cannot do. With no boats submitted
  // uContactCount is 0 and the loop costs nothing.
  // -----------------------------------------------------------------------
  float contact = 0.0;
  for (int i = 0; i < ${MAX_CONTACTS}; i++) {
    if (i >= uContactCount) break;
    vec4 A = uContactA[i];
    vec4 B = uContactB[i];
    vec2 d = p - A.xz;
    vec2 fwd = normalize(B.yz + vec2(1e-5, 0.0));
    float along = dot(d, fwd);
    float across = dot(d, vec2(-fwd.y, fwd.x));
    float stretch = along > 0.0 ? 1.0 : 0.42;
    vec2 e = vec2(along * stretch, across * 1.35);
    float r = length(e) / max(A.w, 0.1);

    // Vertical falloff: a boat 4 m in the air should not foam the water.
    float vertical = 1.0 - smoothstep(0.6, 3.2, abs(A.y - vWorldPos.y));

    float ring = (1.0 - smoothstep(0.5, 1.1, r)) * B.x * vertical;
    contact = max(contact, ring);
  }

  // -----------------------------------------------------------------------
  // 8. FOAM SOURCE D — THE WATERLINE
  //
  // Where an opaque surface (a hull, a gate float, a buoy) sits just behind
  // the water in screen space, the difference between its linear depth and
  // ours is small — that is the waterline. This is what puts foam exactly on
  // the intersection curve, following a hull's silhouette as it rolls.
  // fwidth is illegal in here because the branch is divergent, so this term
  // uses a fixed edge width.
  // -----------------------------------------------------------------------
  float depthFoam = 0.0;
  {
    vec2 suv = (vClipPos.xy / vClipPos.w) * 0.5 + 0.5;
    float sceneDepth = texture(uSceneDepth, suv).w * uCameraFar;
    float ourDepth = -(viewMatrix * vec4(vWorldPos, 1.0)).z;
    // sceneDepth of 0 means nothing was drawn there (open sky/water).
    if (sceneDepth > 0.001 && sceneDepth < ourDepth) {
      float diff = ourDepth - sceneDepth;
      depthFoam = (1.0 - smoothstep(0.0, 1.25, diff));
    }
  }

  // -----------------------------------------------------------------------
  // 9. FOAM COMPOSITE
  //
  // All four sources reduce to one signal, then get one shared threshold with
  // the noise subtracted *from the signal* — that is what gives foam a torn,
  // papery edge instead of a soft dissolve. One threshold rather than four
  // means a wake crossing a breaking crest merges into a single shape with a
  // continuous outline, which is the difference between a foam system and four
  // decals stacked on each other.
  //
  // Three tones: a bright core, a shaded body, and a cyan contour outside the
  // whole silhouette. Never two, because two tones of white on blue is a
  // sticker; the contour is what makes it look drawn.
  // -----------------------------------------------------------------------
  float foamSignal = max(max(crestSignal * 1.85, wake * 1.35), max(contact, depthFoam));
  // Distant foam loses its detail rather than boiling into noise.
  foamSignal *= mix(0.55, 1.0, detail);

  float torn = foamSignal - fn * uFoamBreakup;
  float foamEdge = hardStep(uFoamFold, torn);
  float foamCore = hardStep(uFoamFold + 0.19, torn - fn * 0.12);
  float foamHalo = hardStep(uFoamFold - 0.11, torn);

  float freshness = clamp(max(wakeFresh, crestSignal * 2.0 + depthFoam + contact), 0.0, 1.0);
  vec3 foamCol = mix(uFoamShade, uFoam, clamp(foamCore * 0.75 + freshness * 0.45, 0.0, 1.0));

  col = mix(col, uCrest * 1.15, clamp(foamHalo - foamEdge, 0.0, 1.0) * 0.75);
  col = mix(col, foamCol, foamEdge);

  // -----------------------------------------------------------------------
  // 10. GLITTER
  //
  // Gated on the specular shape so glints only appear where the surface is
  // actually turned towards the sun, and killed inside foam — white sparkles
  // on white foam are invisible and only cost fill.
  // -----------------------------------------------------------------------
  vec3 H = normalize(SUN_DIR + V);
  float specRaw = pow(max(dot(N, H), 0.0), 64.0);
  float specGate = fixedStep(0.03, specRaw, 0.02);

  float bigGlint;
  float glint = glitter(p, uTime, uSparkleDensity, bigGlint);
  float glitterMask = (glint * 0.6 + bigGlint * 1.0) * specGate * uSparkleAmount * detail;
  col += glitterMask * uSunTint * 0.85 * (1.0 - foamEdge);

  // The broad sun path. Two discrete steps, and each step is an ocean-family
  // colour rather than white: mixing towards white over blue gave the pale
  // lavender smear in the into-sun capture, which is the one place in the
  // frame that must not look washed out.
  float pathRaw = specRaw * 5.0;
  float pathA = fixedStep(0.30, pathRaw, 0.05);
  float pathB = fixedStep(0.78, pathRaw, 0.04);
  float pathFade = detail * (1.0 - foamEdge);
  col = mix(col, uCrest, pathA * 0.42 * pathFade);
  col = mix(col, mix(uFoam, uSunTint, 0.35), pathB * 0.7 * pathFade);

  // -----------------------------------------------------------------------
  // 11. HAZE
  //
  // Six steps into a horizon tone that is still an ocean colour, so the water
  // never dissolves into the sky's sand band and lose the horizon line.
  // -----------------------------------------------------------------------
  float fogT = clamp((vViewDist - uFogNear) / max(uFogFar - uFogNear, 1.0), 0.0, 1.0);
  fogT = floor(fogT * 6.0 + 0.4) / 6.0;
  // The haze target has to stay an ocean colour. Fading towards the sky's own
  // horizon band — which is a warm sand — took the far water through grey and
  // came back khaki, and it also dissolved the horizon line the sky depends on
  // for its silhouette. A pale cyan with only a hint of the horizon's warmth
  // keeps the family and keeps the line.
  vec3 hazeCol = mix(mix(uShallow, uSkyTint, 0.55), uHorizon, 0.16);
  col = mix(col, hazeCol, fogT * 0.9);

  outColor = vec4(col, 1.0);

  // The ocean writes into the edge buffer with a heavily flattened normal.
  //
  // This is not a nicety. The Sobel pass inks any pixel where the packed
  // normal changes fast, and the per-pixel ripple above changes the normal
  // every single pixel at a grazing angle — feeding it the shading normal
  // turned the whole lower half of the ultra-quality frame into a wash of ink
  // mixed into the water, which measured as a slate grey where the capture
  // should have been cyan. Writing a nearly-constant up vector means the water
  // never lines against itself, while a hull still stands out against it by a
  // mile and gets the waterline the pass exists for. Distant water is flattened
  // completely, because out there the vertex normal alone swings from one
  // triangle to the next.
  vec3 edgeN = mix(vec3(0.0, 1.0, 0.0), normalize(vNormal), 0.1 * detail);
  vec3 viewN = normalize((viewMatrix * vec4(edgeN, 0.0)).xyz);
  float viewDepth = -(viewMatrix * vec4(vWorldPos, 1.0)).z;
  outNormalDepth = vec4(viewN * 0.5 + 0.5, clamp(viewDepth / uCameraFar, 0.0, 1.0));
}
`;
