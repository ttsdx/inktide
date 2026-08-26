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

const MAX_CONTACTS = 4;

export class Ocean {
  readonly mesh: Mesh;
  readonly material: ShaderMaterial;
  private readonly radius: number;
  private segments: number;
  private rings: number;

  /** Packed contact data: xyz = position, w = radius. */
  private contactA: Vector4[] = [];
  /** Packed contact data: x = strength, yz = forward, w = unused. */
  private contactB: Vector4[] = [];

  constructor(opts: OceanOptions = {}) {
    this.radius = opts.radius ?? 3200;
    this.segments = opts.segments ?? 256;
    this.rings = opts.rings ?? 100;

    const geometry = buildRadialDisc(this.radius, this.segments, this.rings);

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
        /**
         * Framebuffer pixel ratio. Feature LOD (ripple, foam, glitter, hull
         * foam) is measured in CSS pixels so a 2× target does not unlock extra
         * octaves — it only sharpens the bands. Band anti-alias still uses the
         * device footprint so retina edges stay 1 px soft.
         */
        uLodPx: { value: 1 },
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

        /**
         * THESE FIVE WERE DECLARED IN THE SHADER AND NEVER DEFINED HERE.
         *
         * A ShaderMaterial uniform that is not in this map is never set, and
         * WebGL initialises it to zero — so three of the layers this file's own
         * header lists as the art direction have been switched off since they
         * were written, and each one had a paragraph of commentary above it
         * explaining behaviour that was not happening:
         *
         *   uFormRange at (0,0) turns the N.L remap into clamp(ndl / 0.01),
         *     which is a hard step at almost zero. Every pixel facing the sun
         *     at all got formT = 1, so the band coordinate's largest term was a
         *     CONSTANT and the wave-face shading the whole band system is built
         *     on was not happening. This is the significant one.
         *   uSunPlaneStrength at 0 removed the hard lit plane over the bands.
         *   uLiftStrength at 0 removed the fresnel and horizon lift.
         *   uDeepLift at 0 left the deep band as raw waterDeep, which the note
         *     beside it says the grade eats into an almost-black hole.
         *   uPreFilterFloor at 0 let the anti-alias blend go all the way to the
         *     flat tone instead of keeping a floor of banded colour.
         *
         * The tuning probe could not have caught it either: it writes a sweep
         * value only when the uniform already exists, so every sweep of these
         * four silently did nothing and reported that they did not matter.
         */
        /**
         * The N.L range the sea can actually produce, for the band remap.
         *
         * The sun sits 39 degrees up, so a flat sea returns 0.62 and the
         * steepest face in the Gerstner budget swings it to roughly 0.45..0.78.
         */
        uFormRange: { value: new Vector2(0.45, 0.78) },
        /** How far the deepest band is lifted towards the mid blue. */
        uDeepLift: { value: 0.1 },
        uSunPlaneStrength: { value: 0.45 },
        uLiftStrength: { value: 0.5 },
        /**
         * How much banded colour survives where a pixel cannot resolve the
         * bands. Zero measured best on band area, and the reason a floor was
         * wanted in the first place — keeping some structure in the far field
         * — is now served by the flat tone itself being stepped.
         */
        uPreFilterFloor: { value: 0.0 },

        /** Floor on band-edge width, in band units. Anti-aliasing does the rest. */
        uBandSoftness: { value: 0.004 },
        /** Band thresholds along the shading coordinate. */
        /**
         * Band thresholds, chosen by measurement rather than by eye.
         *
         * At 0.27/0.50/0.73 the coordinate cleared every threshold across
         * almost the whole surface, so the ocean was painted in its two
         * palest tones and the deep navy was effectively unreachable: sampling
         * a whole frame put the darkest 2% of the water at brightness 0.906
         * against a deep palette colour of 0.39. There was no shadow anywhere
         * in a frame that is 60% water, so no wave had form and the boat had
         * nothing to silhouette against.
         *
         * Sweeping the thresholds against the measured brightness
         * distribution: 0.40 -> p02 0.886, 0.55 -> 0.804, 0.70 -> 0.373 with
         * the total range going 0.094 -> 0.615 and mean saturation rising to
         * 0.99. Troughs are a minority of the surface, which is why the median
         * barely moves while the low tail opens right up — that is the shape a
         * legible sea should have.
         *
         * That sweep scored tone alone, and won on it — but the same push that
         * made the deep tone reachable also put the MEDIAN into the deepest
         * band, so the near field came back owning a single flat colour. A
         * histogram cannot see that: a wide range is equally consistent with
         * four readable bands and with one enormous flat mass plus a few bright
         * crest pixels. Re-swept with band AREA measured alongside tone, the
         * near field's largest single tone went 0.764 at the old thresholds to
         * 0.412 here, with three tones holding a real share instead of two —
         * and p02, total range and mean saturation all came out better too, so
         * this is not a trade against the previous finding but a correction to
         * where it stopped.
         */
        uBands: { value: new Vector3(0.66, 0.83, 0.94) },
        /** Weights: x = N·L form, y = swell height, z = total height. */
        uBandMix: { value: new Vector3(0.5, 0.32, 0.18) },
        /** Fold (1 - jacobian) at which foam starts. */
        // Raised from 0.34 after measuring the finished game rather than the
        // water in isolation. With boats on the course the near field was 60%
        // desaturated pale pixels — foam had stopped picking out crests and
        // become a flat field the hulls sat in. Sweeping the threshold against
        // measured pale coverage and mean saturation in the lower half of the
        // frame: 0.34 gave 60% pale at 0.43 saturation, 0.66 gives 31% at 0.45.
        // The distance ramp below still charges far foam more on top of this.
        uFoamFold: { value: 0.66 },
        /** Fold window for the drawn crest contour, just below the foam. */
        uRimFold: { value: new Vector2(0.2, 0.3) },
        uFoamBreakup: { value: 0.34 },
        uDebug: { value: 0 },
        uSparkleAmount: { value: 1.0 },
        uSparkleDensity: { value: 0.62 },
        uDetailStrength: { value: 1.0 },
        uFogNear: { value: 240 },
        uFogFar: { value: 1900 },
        uDetailFadeStart: { value: 110 },
        uDetailFadeEnd: { value: 760 },
      },
      defines: {},
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

  /**
   * Render individual shading terms instead of the finished surface, for the
   * capture harness. 0 is off, and is the only value the game ever sets.
   */
  setDebug(mode: number): void {
    this.material.uniforms.uDebug.value = mode;
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
   *
   * The disc itself also rebuilds. 384 × 132 is ~101k displaced triangles, all
   * on screen, all running six Gerstner waves in the vertex shader. That is
   * the right density at retina ultra; it is wasted work at a 1× medium frame,
   * where the near rings already cover several pixels each. The exponential
   * spacing is kept, only the sample count moves, so there is no LOD pop of
   * the kind a clip-map would make — the surface is the same function, sampled
   * coarser.
   *
   * `INK_TIER_LOW` is a compile-time strip of the glitter lattice. A uniform
   * of zero still pays for the hashes; a define does not.
   */
  setQuality(tier: OceanQuality): void {
    const u = this.material.uniforms;
    const defs = this.material.defines as Record<string, string | number>;
    const before = `${defs.INK_TIER_LOW ?? ''}|${defs.INK_TIER_MED ?? ''}|${defs.INK_TIER_HIGH ?? ''}`;
    delete defs.INK_TIER_LOW;
    delete defs.INK_TIER_MED;
    delete defs.INK_TIER_HIGH;
    switch (tier) {
      case 'low':
        u.uDetailStrength.value = 0.0;
        u.uSparkleAmount.value = 0.0;
        u.uDetailFadeStart.value = 55;
        u.uDetailFadeEnd.value = 340;
        this.setDensity(128, 48);
        defs.INK_TIER_LOW = 1;
        u.uLodPx.value = 1;
        break;
      case 'medium':
        u.uDetailStrength.value = 0.6;
        u.uSparkleAmount.value = 0.85;
        u.uDetailFadeStart.value = 80;
        u.uDetailFadeEnd.value = 520;
        this.setDensity(192, 72);
        defs.INK_TIER_MED = 1;
        u.uLodPx.value = 1;
        break;
      case 'high':
        u.uDetailStrength.value = 1.0;
        u.uSparkleAmount.value = 1.0;
        u.uDetailFadeStart.value = 110;
        u.uDetailFadeEnd.value = 760;
        this.setDensity(192, 72);
        defs.INK_TIER_HIGH = 1;
        u.uLodPx.value = 2;
        break;
      case 'ultra':
        u.uDetailStrength.value = 1.0;
        u.uSparkleAmount.value = 1.0;
        u.uDetailFadeStart.value = 150;
        u.uDetailFadeEnd.value = 900;
        this.setDensity(384, 132);
        u.uLodPx.value = 1;
        break;
    }
    const after = `${defs.INK_TIER_LOW ?? ''}|${defs.INK_TIER_MED ?? ''}|${defs.INK_TIER_HIGH ?? ''}`;
    if (after !== before) this.material.needsUpdate = true;
  }

  /**
   * Feature LOD is measured in CSS pixels. Pass the live framebuffer pixel
   * ratio so adaptive scale and retina stay honest: 2× does not evaluate
   * octaves that 1× would have already rejected.
   */
  setLodPx(pixelRatio: number): void {
    this.material.uniforms.uLodPx.value = Math.max(0.5, pixelRatio);
  }

  /** Triangle count of the current disc. Used by the perf probe. */
  get triangleCount(): number {
    const idx = this.mesh.geometry.getIndex();
    return idx ? idx.count / 3 : 0;
  }

  private setDensity(segments: number, rings: number): void {
    if (segments === this.segments && rings === this.rings) return;
    this.segments = segments;
    this.rings = rings;
    const next = buildRadialDisc(this.radius, segments, rings);
    this.mesh.geometry.dispose();
    this.mesh.geometry = next;
  }

  /**
   * The distance band over which the vertex shader fades short-wave detail.
   * Anything that must float has to sample the wave field with the same fade,
   * so the value has to be readable rather than private to the material.
   */
  get detailFade(): { start: number; end: number } {
    return {
      start: this.material.uniforms.uDetailFadeStart.value as number,
      end: this.material.uniforms.uDetailFadeEnd.value as number,
    };
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
out float vFlatDepth;
out float vViewZ;

void main() {
  // the position attribute is already centred on the camera by the mesh transform, so the
  // model matrix gives us the true world XZ the wave field is defined in.
  vec4 world = modelMatrix * vec4(position, 1.0);
  vec2 xz = world.xz;

  float dist = length(xz - uCameraXZ);

  // Detail fade: past uDetailFadeStart the short chop is smaller than a pixel
  // and only produces shimmer, so it is rolled away. detail also drives foam
  // and sparkle density in the fragment shader, so distant water settles into
  // flat painted bands.
  //
  // The fade is applied PER WAVE inside gerstnerEval, weighted by wavelength,
  // rather than as one multiplier over the whole field. Scaling everything was
  // both a look bug and a correctness bug: it flattened the swell that gives
  // the horizon its silhouette, and it moved the surface out from under every
  // object the CPU sampler had placed on it — by up to two metres at a crest,
  // which is how gate collars ended up hovering. Anything that must float now
  // asks sampleOcean() for this same detail value and gets the same surface.
  float detail = gerstnerDetail(dist, uDetailFadeStart, uDetailFadeEnd);
  vDetail = detail;

  GerstnerResult g = gerstnerEval(xz, uTime, uAmplitude, uChoppiness, detail);

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

  // The depth handed to the edge pass is measured to the point on the MEAN SEA
  // PLANE under this vertex, not to the vertex itself.
  //
  // The interior-line pass thresholds the second difference of depth, which is
  // the right measure for finding creases on a hull — a plane of any slope has
  // zero curvature, so a hull seen edge-on does not line itself. Water is not a
  // hull. It is curved everywhere by construction, and at a grazing angle a
  // single pixel spans several metres of a wave face, so its genuine curvature
  // over one pixel is enormous and the term fires across the whole surface.
  // Captured at chase-cam height that arrived as a slate-grey wedge lying over
  // the mid-distance — measurably 30% desaturated, ink washed over water at
  // roughly 40% coverage — in the middle of a frame that is supposed to be
  // saturated blue.
  //
  // Dropping the wave displacement leaves the depth of a flat plane, whose
  // curvature is nil, so the water no longer lines against itself at any angle.
  // Nothing is lost: this attachment's only consumer is that pass, the ocean's
  // own waterline foam reads the separately copied opaque-pass depth, and the
  // ridges the lines were nominally finding are already drawn deliberately by
  // the crest contour, which knows where a crest actually is instead of
  // inferring it from a depth buffer.
  vFlatDepth = -(viewMatrix * vec4(xz.x, 0.0, xz.y, 1.0)).z;

  vec4 viewPos = viewMatrix * vec4(finalPos, 1.0);
  vViewZ = -viewPos.z;
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
uniform float uLodPx;
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

/** (lo, hi) of the N.L range the sea can actually produce, for the band remap. */
uniform vec2 uFormRange;
uniform float uPreFilterFloor;
uniform float uLiftStrength;
uniform float uSunPlaneStrength;
uniform float uDeepLift;
uniform float uBandSoftness;
uniform vec3 uBands;
uniform vec3 uBandMix;
uniform float uFoamFold;
uniform vec2 uRimFold;
uniform float uFoamBreakup;
uniform float uDebug;
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
in float vFlatDepth;
in float vViewZ;

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

  // Warp the sampling frame before the FIRST octave, not only between octaves.
  //
  // Every octave below is a directional wave train, which is a stripe pattern
  // by construction. The later ones are broken up by the warp accumulated from
  // their predecessors, but the first — and the strongest, at more than twice
  // the amplitude of any other — had nothing in front of it and stayed a clean
  // set of parallel crests 11 m apart. Under cel banding a clean periodic ridge
  // is not a subtle artefact the way it would be under smooth shading: every
  // ridge crosses the same band threshold at the same point in its cycle, so
  // the thresholds print the period. Seen from directly above, where nothing is
  // foreshortened, the open ocean came back ruled with even rows of light and
  // dark dashes — corduroy.
  //
  // The warp is nearly a full wavelength of displacement over a ~70 m noise, so
  // the crest lines wander by more than their own spacing and no two rows stay
  // in step long enough to read as a texture.
  vec2 warp = vec2(
    noiseR(p * 0.0143 + vec2(t * 0.0061, 0.31)),
    noiseG(p * 0.0143 + vec2(0.17, -t * 0.0048))
  ) - 0.5;
  vec2 pw = p + warp * 9.0;

  vec3 a = rippleOctave(pw, t, vec2( 0.8607,  0.5091), 11.30, 0.170, 1.00, 0.0, px);
  vec2 q = pw + a.xy * 2.6;
  vec3 b = rippleOctave(q, t, vec2(-0.3894,  0.9211),  6.70, 0.145, 1.28, 2.1, px);
  q += b.xy * 1.7;
  vec3 c = rippleOctave(q, t, vec2( 0.6402, -0.7682),  3.90, 0.120, 1.55, 4.3, px);
#ifdef INK_TIER_LOW
  return (a + b + c) * gust;
#else
  q += c.xy * 1.1;
  vec3 d = rippleOctave(q, t, vec2(-0.9563, -0.2924),  2.30, 0.098, 1.82, 1.2, px);
#ifdef INK_TIER_HIGH
  return (a + b + c + d) * gust;
#else
  q += d.xy * 0.7;
  vec3 e = rippleOctave(q, t, vec2( 0.2079,  0.9781),  1.31, 0.072, 2.10, 5.6, px);
#ifdef INK_TIER_MED
  return (a + b + c + d + e) * gust;
#else
  q += e.xy * 0.5;
  vec3 f = rippleOctave(q, t, vec2(-0.6820, 0.7314), 0.78, 0.055, 2.42, 3.0, px);
  q += f.xy * 0.35;
  vec3 g = rippleOctave(q, t, vec2( 0.9911, -0.1332), 0.44, 0.042, 2.75, 0.6, px);
  return (a + b + c + d + e + f + g) * gust;
#endif
#endif
#endif
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
float foamNoise(vec2 p, float t, float px) {
  // Squash the sampling frame along the primary swell's direction of travel.
  // Foam is torn off a crest and dragged down the face, so its grain runs
  // *along* the crest line, not isotropically: an unsquashed noise gives round
  // blobs of foam, which is the difference between spume and cotton wool. The
  // direction is the first entry of the WAVES table, normalised.
  // 2.3:1, not the 4.3:1 this started at. Foam grain genuinely is directional,
  // but past about 2.5:1 the difference between "streaky" and "combed" stops
  // being a matter of degree: the noise loses its blobs entirely and every
  // contour drawn through it becomes a long parallel stroke.
  vec2 dir = vec2(0.9550, 0.2965);
  vec2 s = vec2(dot(p, dir) * 1.55, dot(p, vec2(-dir.y, dir.x)) * 0.68);

  float big = noiseR(s * 0.021 + vec2(t * 0.009, -t * 0.005));
  float mid = noiseG(s * 0.098 - vec2(t * 0.028, t * 0.017));
  // The tear octave is sampled in UNsquashed world space, unlike the two above.
  //
  // Stretching the fine grain 4:1 as well as the streaks turned the foam edge
  // into a comb. It hid at low camera angles, where foreshortening squashes the
  // long axis back towards square, and then appeared in full from directly
  // above as a regular field of parallel dashes lying across the water like
  // pencil hatching — a repeating texture, which is the one thing a hand-drawn
  // surface must never look like. The macro streaks genuinely are directional,
  // because that is foam being dragged down the face of a wave, but the tear at
  // the boundary of a foam patch has no direction at all.
  // The tear octave slides its FREQUENCY down with the pixel footprint rather
  // than fading its amplitude out.
  //
  // Fading it out is the obvious way to stop it aliasing, and it was worse than
  // the aliasing. This is the only isotropic octave of the three; with it gone,
  // the foam boundary in the mid-ground was drawn entirely by the two squashed
  // ones, and the capture filled with long parallel diagonal streaks. Combing
  // is a far more damaging artefact than stipple, because stipple at least
  // looks like an accident and a comb looks like a texture someone chose.
  //
  // Sliding the frequency keeps a tear at every distance and holds its feature
  // size near three pixels, which is above the sampling limit everywhere, so
  // the edge is torn in the near field and still torn at the horizon.
#ifdef INK_TIER_LOW
  return (big * 0.55 + mid * 0.45) - 0.5;
#else
  float fineScale = 0.42 / (1.0 + px * 1.3);
  float fine = noiseA(p * fineScale + vec2(-t * 0.046, t * 0.038));
  return (big * 0.46 + mid * 0.34 + fine * 0.20) - 0.5;
#endif
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
  // World-space width of this pixel. Every scale-dependent *feature* below is
  // made against CSS pixels (the px variable), not device pixels: a 2x buffer would
  // otherwise unlock extra ripple octaves, foam hashes and hull-contact loops
  // that 1× already rejected, which is four times the fill paying more ALU
  // each. Band anti-alias (hardStep / bandStepAA) still uses the device
  // footprint so retina edges stay one device-pixel soft.
  float pxDev = max(length(fwidth(p)), 1e-4);
  float px = pxDev * max(uLodPx, 0.5);

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
  float resolve = 1.0 - smoothstep(0.35, 2.2, pxDev);

  // The detail multiplier gets a far more generous curve than the pre-filter,
  // although the two were originally one value.
  //
  // Sharing the pre-filter's curve conflated two different jobs. The pre-filter
  // is defending against MSAA averaging high-contrast bands into dirt, and has
  // to be pessimistic. This term only decides how much ripple, foam and sparkle
  // to pay for — and each ripple octave already rejects itself the moment its
  // own wavelength drops below a pixel, so it is not policing aliasing at all.
  // Handing it the pessimistic curve threw away structure that would have
  // rendered perfectly well: water twenty metres from a chase camera, the
  // busiest and most-looked-at part of the frame, came back as plain blue.
  float detail = min(vDetail, 1.0 - smoothstep(0.45, 2.6, px));

  float detailAmt = uDetailStrength * detail;
  vec3 dw = vec3(0.0);
  // Horizon pixels cannot hold the ripple. Paying seven octaves there is how
  // a chase frame spends most of its fragment time on water nobody can read.
#ifdef INK_TIER_LOW
  const float DETAIL_PX = 0.92;
#elif defined(INK_TIER_MED)
  const float DETAIL_PX = 1.05;
#elif defined(INK_TIER_HIGH)
  const float DETAIL_PX = 0.88;
#else
  const float DETAIL_PX = 1.35;
#endif
  if (detailAmt > 0.04 && px < DETAIL_PX) dw = detailWave(p, uTime, px) * detailAmt;
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
  // Remap N.L across the range the ocean can actually produce, not 0..1.
  //
  // This is why the water had no dark tone. The sun sits 39 degrees up, so a
  // flat sea returns N.L = 0.62, and the steepest wave face in the Gerstner
  // budget only swings it to roughly 0.45..0.78. Spread over a 0.16..0.94
  // remap, that entire swing occupied the middle third of the band coordinate
  // and never once reached the deep threshold: measured across a whole frame,
  // the darkest 2% of the ocean sat at brightness 0.878 against a deep palette
  // colour of 0.39. The trough tone was not weak, it was unreachable.
  //
  // Normalising against the achievable range turns the same physical swing into
  // the full 0..1 of the coordinate, so a wave face turned away from the sun
  // lands in the deep band and a face turned into it lands in the crest band.
  float formT = clamp((ndl - uFormRange.x) / max(uFormRange.y - uFormRange.x, 0.01), 0.0, 1.0);

  // Past the detail-fade window the surface normal is carried by triangles
  // tens of metres wide, so N·L stops describing a wave and starts describing
  // the tessellation — which is what put the scratchy dark streaks through the
  // 50–150 m band of the second capture. Roll the coordinate's weight over to
  // the swell, which is smooth at any triangle size, as detail dies. Total
  // weight is conserved so the band thresholds do not have to move with it.
  float formMix = mix(0.40, 1.0, detail);
  float swellW = uBandMix.y + uBandMix.x * (1.0 - formMix);
  float bandBase = vSwell * swellW + vHeight * uBandMix.z;
  float band = formT * uBandMix.x * formMix + bandBase + dw.z * 0.13;

  // The same coordinate with the per-pixel ripple removed. A painted shadow
  // shape is large and simple — the detail lives in the light. Cutting the
  // darkest tone against the full ripple instead produced the swarm of little
  // dark commas that covers the foreground of the third capture, so the deep
  // band is cut almost entirely against the broad surface and each successive
  // band picks up more of the detail.
  float formBroad = clamp((dot(normalize(vNormal), SUN_DIR) - uFormRange.x) / max(uFormRange.y - uFormRange.x, 0.01), 0.0, 1.0);
  float bandBroad = formBroad * uBandMix.x * formMix + bandBase;

  float b1 = hardStep(uBands.x, mix(band, bandBroad, 0.62));
  float b2 = hardStep(uBands.y, mix(band, bandBroad, 0.35));
  // The top band takes some of the broad coordinate too, where it used to be
  // cut against the fully rippled one.
  //
  // Cutting the palest tone against the per-pixel ripple prints the ripple's
  // own periodicity as colour: each octave is a directional wave train, so the
  // threshold lands on every ridge and the surface fills with even rows of pale
  // dashes. It hid while the detail term was pessimistic enough to switch the
  // ripple off beyond a few metres, and reappeared across the whole near field
  // the moment that term was relaxed — which made it look like a foam artefact
  // and cost several rounds chasing it through the foam noise. It was never
  // foam; it was the crest tone, drawn on every ripple.
  //
  // The ripple still lifts the band — that is what gives near water its
  // surface — but no longer decides on its own where the palest tone starts.
  float b3 = hardStep(uBands.z, mix(band, bandBroad, 0.30));

  // The deepest tone is lifted a fifth of the way towards the mid blue. Raw
  // waterDeep does not survive the composite: the grade pushes saturation to
  // 1.14, which drives its already tiny red channel negative and clips it, so
  // the trough measured as rgb(0,1,89) — an almost-black hole punched in the
  // surface rather than the bottom band of an ocean. The lift is still made of
  // palette colours; it only stops the pipeline from eating one of them.
  vec3 col = mix(uDeep, uMid, uDeepLift);
  col = mix(col, uMid, b1);
  col = mix(col, uShallow, b2);
  col = mix(col, uCrest, b3);
  // Kept for the debug taps: the four-tone body before anything is layered on.
  vec3 bandCol = col;

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
  col = mix(col, mix(uCrest, uSunTint, 0.28), sunPlane * uSunPlaneStrength);

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
  col = mix(col, liftCol, lift * uLiftStrength);

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
  // Gated on the swell as well as the fold, or the contour appears on every
  // ripple in the trough too and the surface fills with cyan confetti — which
  // is precisely what a near-vertical camera showed once the foam was thinned
  // enough to see past it: the fold window is a level set, so on a surface with
  // ripples everywhere it closes into hundreds of little cyan rings. Raising
  // the gate restricts it to water that is genuinely lifted, where the window
  // lands on the long ridge of a swell and traces it as an open line.
  float crestGate = smoothstep(0.42, 0.80, vSwell);
  float contour = clamp(rimLo - rimHi, 0.0, 1.0) * detail * crestGate;
  col = mix(col, uCrest * 1.3, contour * 0.55);

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
#ifdef INK_TIER_LOW
  const float FOAM_PX = 0.95;
#elif defined(INK_TIER_MED)
  const float FOAM_PX = 1.05;
#elif defined(INK_TIER_HIGH)
  const float FOAM_PX = 0.95;
#else
  const float FOAM_PX = 1.35;
#endif
  float fn = 0.0;
  if (px < FOAM_PX) fn = foamNoise(p, uTime, px);
  // Foam gets its own, stricter swell gate than the contour above.
  //
  // Sharing one gate looked economical and was wrong. The contour wants to
  // trace every ridge, including the small ones, because that is what gives the
  // surface its drawn structure. Foam wants only the crests that are actually
  // breaking. With the contour's gate doing both jobs, a near-vertical camera —
  // which sees a huge area of water all at full detail, with nothing
  // foreshortened away — buried about a third of the frame under white
  // continents. That is stormier than this game ever is, and it destroys the
  // read of the wake, which has to be the brightest thing on the water.
  float foamGate = smoothstep(0.44, 0.82, vSwell);

  // Foam lives in PATCHES along a crest, not evenly down its whole length.
  //
  // A real wave does not break uniformly from end to end; it breaks where it
  // happens to be steepest, in runs of a few metres, and the rest of the ridge
  // stays unbroken water. Gating on fold and swell alone gives every crest the
  // same even sprinkle, and thinning that sprinkle to control the coverage just
  // dices it finer — the high camera came back speckled with confetti while the
  // chase camera, which sees only one or two crests, came back with no foam on
  // them at all. Neither is a coverage problem; both are a *distribution*
  // problem, and a slow large-scale mask is the fix. Multiplying before the
  // threshold rather than subtracting after it means the surviving patches keep
  // their full strength and land as decisive white shapes with clear water
  // between them, which is how an animator would place them.
  // The clump scale is set by what one frame can see, not by what looks right
  // on a map. At a 110 m period a chase camera — which is looking at maybe two
  // crests — sits entirely inside one clump or entirely outside it, so the
  // water was either uniformly foamed or, as captured, had none at all. Around
  // 60 m there is always some of each in shot.
  float clumpN = 0.46;
  if (px < FOAM_PX) clumpN = noiseR(p * 0.0160 + vec2(uTime * 0.004, -uTime * 0.003));
  float clump = smoothstep(0.30, 0.62, clumpN);
  // Squared, not linear. This is what stops foam drawing slivers.
  //
  // The fold signal is a field of parallel ridges, and a linear drive against a
  // fixed threshold puts a thin stroke of foam on every one of them — hundreds
  // of parallel strokes across the near field, which reads as hatching rather
  // than as spume, and which no amount of work on the breakup noise could fix
  // because the periodicity is in the water and not in the noise. Squaring the
  // drive widens the gap between a ridge that is genuinely breaking and one
  // that is merely present: a strong crest keeps all its foam and a marginal
  // one loses it entirely, instead of every ridge getting a share.
  //
  // The 2.1 puts the peak back where it was, so the composite thresholds below
  // did not have to be retuned around this.
  float raw = vFold * foamGate;
  float crestSignal = raw * raw * 2.1 * mix(0.42, 1.70, clump);

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
#ifdef INK_TIER_HIGH
  const float NEAR_WORK_PX = 0.88;
#else
  const float NEAR_WORK_PX = 1.22;
#endif
  float wake = 0.0;
  float wakeFresh = 0.0;
  if (uWakeParams.w > 0.5 && px < NEAR_WORK_PX) {
    // Warp the lookup in world space before sampling, to break the texel grid.
    //
    // The field is half a metre per texel, which a chase camera magnifies to
    // several pixels. Bilinear filtering between texels is piecewise linear, so
    // the contour of a hard threshold taken across it runs along texel
    // boundaries — and the wake came back ruled with even rows of blue dashes
    // through the white, which is the grid itself, drawn. It is the same defect
    // as the corduroy in the ripple field and it has the same cause: a regular
    // lattice meeting a hard step.
    //
    // Three texels of wander costs one fetch and makes the threshold follow the
    // noise instead of the lattice, so the wake's edge tears exactly like the
    // crest foam beside it rather than resolving into rectangles.
#ifdef INK_TIER_HIGH
    // Play retina: two ALU hashes instead of two extra noise taps. The field
    // is 384²; the lattice is still broken, just not with a texture fetch.
    vec2 jitter = vec2(hash21(floor(p * 3.1)), hash21(floor(p * 3.1 + 19.7))) - 0.5;
#else
    vec2 jitter = vec2(noiseR(p * 0.21 + vec2(0.13, 0.71)),
                       noiseG(p * 0.21 + vec2(0.57, 0.29))) - 0.5;
#endif
    vec2 wuv = (p + jitter * 1.6 - uWakeParams.xy) / (uWakeParams.z * 2.0) + 0.5;
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
  if (px < NEAR_WORK_PX) {
  for (int i = 0; i < ${MAX_CONTACTS}; i++) {
    if (i >= uContactCount) break;
    vec4 A = uContactA[i];
    vec4 B = uContactB[i];
    vec2 d = p - A.xz;
    vec2 fwd = normalize(B.yz + vec2(1e-5, 0.0));
    float along = dot(d, fwd);
    float across = dot(d, vec2(-fwd.y, fwd.x));
    // The teardrop is scaled to the actual hull: r = 1 lands just outboard of
    // the chine and just ahead of the bow, and trails a long way aft where the
    // wake starts. Getting this to match matters because the collar below is
    // pinned to r = 1.
    float stretch = along > 0.0 ? 0.72 : 0.40;
    vec2 e = vec2(along * stretch, across * 1.35);
    float r = length(e) / max(A.w, 0.1);

    // Vertical falloff: a boat 4 m in the air should not foam the water.
    float vertical = 1.0 - smoothstep(0.6, 3.2, abs(A.y - vWorldPos.y));

    // A COLLAR, not a disc.
    //
    // This was a filled ellipse at full strength in the middle falling to zero
    // at the rim, which puts all of its foam underneath the boat where the
    // hull occludes it and leaves only the weakest fringe visible. The whole
    // point of hull foam is the line where the hull enters the water, so the
    // strong part belongs exactly there, at r = 1, falling away on both sides.
    //
    // Both edges are perturbed by the shared breakup noise so the collar tears
    // like every other foam source. Without it the hull's contact foam is the
    // one perfectly smooth ellipse in a frame of hand-torn shapes, and a
    // no-wake capture showed it doing exactly that — a clean white lozenge
    // sitting on the water like a sticker.
    float collar = 1.0 - smoothstep(0.0, 0.34, abs(r - 1.0) + fn * 0.16);
    // A weaker wash inside the collar: the water the hull is pushing aside is
    // disturbed too, it just is not breaking.
    float inside = (1.0 - smoothstep(0.5, 1.0, r)) * 0.42;
    contact = max(contact, max(collar, inside) * B.x * vertical);
  }
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
#ifndef INK_TIER_LOW
  if (px < NEAR_WORK_PX) {
    vec2 suv = (vClipPos.xy / vClipPos.w) * 0.5 + 0.5;
    float sceneDepth = texture(uSceneDepth, suv).w * uCameraFar;
    float ourDepth = vViewZ;
    if (sceneDepth > 0.001 && sceneDepth > ourDepth) {
      float diff = sceneDepth - ourDepth;
      depthFoam = (1.0 - smoothstep(0.0, 1.25, diff));
    }
  }
#endif

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
  // The wake's gain is deliberately the lowest of the four. Its field already
  // saturates at 1.0, so any gain above about 1.1 pushes the whole ribbon —
  // shoulders included — so far past the tear threshold that the noise cannot
  // reach it, and the wake comes back as a smooth-edged white blob sitting on
  // water whose own foam is properly torn. Two different edge treatments in one
  // frame is worse than either, and it is the wake that looks pasted on.
  float foamSignal = max(max(crestSignal * 1.55, wake * 1.10), max(contact, depthFoam));
  // Distant foam loses its detail rather than boiling into noise.
  foamSignal *= mix(0.55, 1.0, detail);

  // The threshold RISES with the pixel footprint. It is the only term in the
  // foam composite that is not a constant, and it is doing the most work.
  //
  // Chop is a field of roughly parallel ridges, so the fold signal crosses any
  // fixed threshold periodically in space. Near the camera that is exactly what
  // is wanted — foam picks out individual crests. At mid distance, where one
  // ridge is a couple of pixels across, it instead produces one thin sliver per
  // ridge over a very large area, and a few hundred parallel slivers is not
  // foam, it is hatching. The captures showed it as a comb lying across the
  // whole mid-ground, and it was the last and most stubborn artefact here:
  // narrowing the noise, band-limiting it and re-warping it all failed, because
  // the periodicity was never in the noise. It was in the water.
  //
  // Charging distant foam more means only genuinely strong crests keep it,
  // which is both what real water does and what a background painter does: near
  // foam is drawn crest by crest, far foam is implied with two or three shapes.
  float foamFold = uFoamFold + 0.30 * smoothstep(0.25, 1.6, px);

  float torn = foamSignal - fn * uFoamBreakup;
  float foamEdge = hardStep(foamFold, torn);
  float foamCore = hardStep(foamFold + 0.19, torn - fn * 0.12);
  float foamHalo = hardStep(foamFold - 0.11, torn);

  // -----------------------------------------------------------------------
  // FOAM TONE: three flat steps, never a ramp.
  //
  // 'freshness' is a continuous field — the wake texture's age term is smooth
  // by construction — so mixing the foam colour by it directly painted the
  // inside of every foam patch as an airbrushed gradient. Cropped to native
  // resolution, the wake behind a boat was a single smooth wash running most
  // of the way across the frame with no step anywhere in it: the one surface
  // in the game that had abandoned the art direction completely, and the
  // largest one, because a wake at speed covers more of the screen than the
  // boat does.
  //
  // The edge was never the problem here. Quantising the interior is.
  //
  // Three tones rather than two, and the deepest is pulled towards the crest
  // cyan rather than being another near-white: foamShade and foam are 0.72
  // and 0.98 in value, so a two-step foam has almost no internal contrast and
  // reads as one tone with a slightly dirty edge whatever the threshold does.
  // -----------------------------------------------------------------------
  float freshness = clamp(max(wakeFresh, crestSignal * 2.0 + depthFoam + contact), 0.0, 1.0);
  float foamTone = clamp(foamCore * 0.75 + freshness * 0.45, 0.0, 0.999);
  float foamStep = floor(foamTone * 3.0);
  vec3 foamDeep = mix(uCrest, uFoamShade, 0.55);
  vec3 foamCol = foamStep < 0.5 ? foamDeep : (foamStep < 1.5 ? uFoamShade : uFoam);

  // Everything the body has picked up before the foam is composited over it.
  vec3 preFoamCol = col;

  col = mix(col, uCrest * 1.15, clamp(foamHalo - foamEdge, 0.0, 1.0) * 0.75);
  col = mix(col, foamCol, foamEdge);

  // Apply the pre-filter now, after the foam, and aim it at a target that
  // knows how much foam is here.
  //
  // Running it before the foam left the foam itself unfiltered, so a wake seen
  // at a grazing angle still alternated white and blue faster than a pixel and
  // still resolved to grey — a dirty wedge across the bottom right of the
  // spray capture. Folding the foam into the target instead means heavily
  // foamed water flattens towards pale foam and clear water flattens towards
  // saturated blue, and neither of them flattens towards the average of the
  // two, which is the only colour on that line nobody wants.
  // Quantised, for the same reason the foam above it is.
  //
  // This term is a continuous function of foamSignal, and it DOMINATES the most
  // grazing pixels — which at chase-camera height is most of the frame. So no
  // matter how hard the bands above are cut, the mid-ground was being repainted
  // as a smooth wash by the thing meant to be anti-aliasing it. Measured on a
  // wake crop, banding the foam alone took the region from 1805 distinct
  // colours to 884; it was still a gradient, and this was why.
  //
  // Stepping it does not bring the aliasing back. The aliasing the pre-filter
  // exists for comes from the chop's high-frequency banding crossing a
  // threshold faster than a pixel; foamSignal at a large pixel footprint is a
  // slow field, so its steps are large, stable shapes rather than a shimmer.
  float flatFoam = clamp(foamSignal * 1.3, 0.0, 0.999);
  vec3 flatTone = mix(mix(uMid, uShallow, 0.55), uFoamShade, floor(flatFoam * 3.0) / 2.0);
  // The pre-filter target has to carry the fresnel lift too, or it undoes it.
  //
  // The most grazing pixels in the frame are exactly the ones the pre-filter
  // takes furthest towards flatTone, and they are also the ones the lift has
  // most to say about — water seen edge-on is mostly sky. Flattening them to a
  // mid blue threw that away and left the top edge of every near crest dark,
  // which matters because that edge is a silhouette against the sky's warm sand
  // band: multisampling resolves dark navy against sand to a grey-olive, and
  // the crest close-up came back with a dirty fringe along its ridge. Carrying
  // the lift into the target makes those pixels pale cyan instead, and pale
  // cyan against sand resolves to a pale warm cyan, which is a colour the frame
  // is allowed to contain.
  flatTone = mix(flatTone, liftCol, lift * 0.5);
  col = mix(flatTone, col, mix(uPreFilterFloor, 1.0, resolve));

  // -----------------------------------------------------------------------
  // 10. GLITTER + SUN PATH
  //
  // Azimuth first. Specular x^64 and the dash-noise tap are only visible on
  // the sun's reflection road; paying them on the rest of the ocean is how a
  // 2x chase spent most of its fragment time on water that stayed navy.
  // -----------------------------------------------------------------------
  vec2 sunAz = normalize(vec2(SUN_DIR.x, SUN_DIR.z));
  vec2 toPix = normalize(p - cameraPosition.xz + vec2(1e-5, 0.0));
  float road = smoothstep(0.72, 0.96, dot(toPix, sunAz));
  road = floor(road * 3.0 + 0.35) / 3.0;

  float specRaw = 0.0;
  float specGate = 0.0;
  float dash = 1.0;
  float glitterMask = 0.0;

#if defined(INK_TIER_LOW) || defined(INK_TIER_MED) || defined(INK_TIER_HIGH)
  if (road > 0.01) {
    vec3 H = normalize(SUN_DIR + V);
    specRaw = max(dot(N, H), 0.0);
    specRaw *= specRaw;
    specRaw *= specRaw;
    specRaw *= specRaw;
    specRaw *= specRaw;
    specRaw *= specRaw;
    specRaw *= specRaw;
    if (px < 1.05) {
      vec2 sdir = sunAz;
      vec2 sperp = vec2(sdir.y, -sdir.x);
      vec2 gp = vec2(dot(p, sdir) * 1.4, dot(p, sperp) * 0.62);
      float dashN = noiseG(gp * 0.36 + vec2(uTime * 0.06, -uTime * 0.021));
      dash = mix(0.62, 1.0, fixedStep(0.47, dashN, 0.02));
    }
  }
#else
  vec3 H = normalize(SUN_DIR + V);
  specRaw = max(dot(N, H), 0.0);
  specRaw *= specRaw;
  specRaw *= specRaw;
  specRaw *= specRaw;
  specRaw *= specRaw;
  specRaw *= specRaw;
  specRaw *= specRaw;
  specGate = fixedStep(0.03, specRaw, 0.02);
  if (px < 1.22) {
    float bigGlint;
    float glintOctave = exp2(floor(log2(max(vViewDist, 4.0) / 12.0)));
    float glint = glitter(p, uTime, uSparkleDensity / glintOctave, bigGlint);
    glitterMask = (glint * 0.6 + bigGlint * 1.0) * specGate * uSparkleAmount * detail;
    col += glitterMask * uSunTint * 0.85 * (1.0 - foamEdge);
  }
  if (road > 0.01 && px < 1.05) {
    vec2 sdir = sunAz;
    vec2 sperp = vec2(sdir.y, -sdir.x);
    vec2 gp = vec2(dot(p, sdir) * 1.4, dot(p, sperp) * 0.62);
    float dashN = noiseG(gp * 0.36 + vec2(uTime * 0.06, -uTime * 0.021));
    dash = mix(0.62, 1.0, fixedStep(0.47, dashN, 0.02));
  }
#endif

  float pathA = 0.0;
  float pathB = 0.0;
  float pathFade = 0.0;
  if (road > 0.01) {
    float pathRaw = specRaw * 5.0;
    pathA = fixedStep(0.30, pathRaw, 0.05);
    pathB = fixedStep(0.78, pathRaw, 0.04);
    pathFade = detail * (1.0 - foamEdge) * dash * road;
    col = mix(col, uCrest, pathA * 0.42 * pathFade);
    col = mix(col, mix(uFoam, uSunTint, 0.35), pathB * 0.7 * pathFade);
  }

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

  // Term isolation for the capture harness. Each channel carries one candidate
  // so a single frame says which one owns an artefact, instead of a round of
  // captures per guess.
  //
  // DO NOT TRUST THIS UNTIL IT IS FIXED.
  //
  // Measured with one capture per process, so no shared page state can be
  // involved, sampling the same central water region, reading uDebug back from
  // the material after the render to confirm it arrived:
  //
  //   uDebug 0  rgb(16,106,106)
  //   uDebug 1  rgb(16, 98, 57)
  //   uDebug 2  rgb(16, 98, 57)   identical to mode 1, which outputs different
  //                               channels, so at least one of them is wrong
  //   uDebug 4  rgb(16,106,106)   identical to mode 0, so the tap is not taking
  //   uDebug 5  rgb(16,106,106)   effect at all
  //
  // The block is reached — 1 and 2 do change the frame — but its later branches
  // do not, and two branches that write different values produce the same
  // pixels. Something between this write and the composite is not what it
  // looks like. Until that is understood, any conclusion drawn from these
  // frames is unfounded; one already was, and had to be reverted.
  if (uDebug > 0.5) {
    if (uDebug < 1.5)      outColor = vec4(foamEdge, b3, sunPlane, 1.0);
    else if (uDebug < 2.5) outColor = vec4(
      clamp(foamHalo - foamEdge, 0.0, 1.0) * 0.75,
      pathA * 0.42 * pathFade + pathB * 0.7 * pathFade,
      glitterMask,
      1.0);
    else if (uDebug < 3.5) outColor = vec4(contour, b2, sunPlane * 0.82, 1.0);
    // 4 and 5 output COLOURS rather than masks, which the three modes above
    // all do. Chasing why the water's darkest tone renders as a saturated teal
    // 36 degrees off waterDeep, the masks could say which terms were firing but
    // not what colour anything was, and inverting the grade analytically only
    // narrowed it to "not any one of these terms alone". Being able to shoot
    // the band ramp on its own and subtract it from the finished frame answers
    // it in one capture instead of a round per candidate.
    else if (uDebug < 4.5) outColor = vec4(bandCol, 1.0);
    else                   outColor = vec4(preFoamCol, 1.0);
  }

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
  outNormalDepth = vec4(viewN * 0.5 + 0.5, clamp(vFlatDepth / uCameraFar, 0.0, 1.0));
}
`;
