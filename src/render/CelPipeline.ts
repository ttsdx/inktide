import {
  Camera,
  Color,
  HalfFloatType,
  LinearFilter,
  NearestFilter,
  NoColorSpace,
  RGBAFormat,
  Scene,
  UnsignedByteType,
  Vector2,
  WebGLRenderTarget,
  type WebGLRenderer,
} from 'three';
import { FullScreenPass } from './FullScreenPass.ts';
import { PALETTE } from '../core/Palette.ts';
import { glslVec3 } from './shaderLib.ts';
import { LAYER_OCEAN, LAYER_OPAQUE, LAYER_OVERLAY, LAYER_SKY } from './layers.ts';

/**
 * THE POST CHAIN
 *
 * scene -> [MRT: colour + packed normal/depth]
 *       -> Sobel interior-line MASK (reads attachment 1; may run below native res)
 *       -> bright extract + separable blur (graphic bloom, not photographic)
 *       -> composite (burn mask into colour) + paper grade + vignette -> screen
 *
 * The interior-line pass is the half of the outline system the inverted hull
 * cannot do: creases inside a silhouette (the join between a deck and a
 * cockpit, a rider's arm against their chest). The two systems are tuned to not
 * double up — the Sobel pass rejects any edge whose depth discontinuity is
 * large, because that is exactly where the hull shell has already drawn a line.
 */

export interface PipelineQuality {
  /** Multiplier on devicePixelRatio, clamped by the adaptive controller. */
  pixelRatio: number;
  /** MSAA samples on the main target. 0 disables. */
  samples: number;
  /** Enable the bloom chain. */
  bloom: boolean;
  /** Enable the Sobel interior-line pass. */
  interiorLines: boolean;
  /** Downscale factor for the bloom chain (2 = half res). */
  bloomScale: number;
  /**
   * Downscale factor for the Sobel pass and the pre-ocean depth copy.
   * 2 = half res: interior lines stay on at 2× without a full-res rewrite of
   * the colour buffer. The composite samples the mask at native resolution.
   */
  lineScale: number;
}

/**
 * Bloom mix at full quality. Kept as a constant so a harness sweep survives.
 *
 * Swept at 0, 0.28 and 0.5 on the knot frame. 0.28 is very nearly free — a
 * touch of energy on the hottest highlight and nothing else moves — while by 0.5
 * the banded highlights had started to soften and a faint halo was showing
 * outside the ink, which is the one thing bloom is not allowed to cost here.
 * 0.3 sits just above the free point.
 */
const BLOOM_STRENGTH = 0.3;

export const QUALITY_PRESETS: Record<'low' | 'medium' | 'high' | 'ultra', PipelineQuality> = {
  low: { pixelRatio: 1.0, samples: 0, bloom: false, interiorLines: false, bloomScale: 4, lineScale: 2 },
  medium: { pixelRatio: 1.0, samples: 0, bloom: true, interiorLines: true, bloomScale: 4, lineScale: 1 },
  // Play retina: 2× colour, no MSAA, no bloom, half-res Sobel. Ultra adds 4×
  // MSAA and the bloom chain on the same 2× buffer — adaptive never climbs there.
  high: { pixelRatio: 2.0, samples: 0, bloom: false, interiorLines: true, bloomScale: 4, lineScale: 2 },
  ultra: { pixelRatio: 2.0, samples: 4, bloom: true, interiorLines: true, bloomScale: 2, lineScale: 1 },
};

export class CelPipeline {
  readonly renderer: WebGLRenderer;
  quality: PipelineQuality;

  /** Main scene target: attachment 0 colour (HDR-ish), attachment 1 normal/depth. */
  private main!: WebGLRenderTarget;
  private lines!: WebGLRenderTarget;
  private depthCopy!: WebGLRenderTarget;
  private bright!: WebGLRenderTarget;
  private blurA!: WebGLRenderTarget;
  private blurB!: WebGLRenderTarget;

  private sobelPass!: FullScreenPass;
  private copyPass!: FullScreenPass;
  private brightPass!: FullScreenPass;
  private blurPass!: FullScreenPass;
  private compositePass!: FullScreenPass;

  /**
   * Called after the opaque slice has been drawn and its depth copied, so the
   * ocean can bind the copy before it renders. Set by the game.
   */
  onDepthReady: ((depth: import('three').Texture, w: number, h: number) => void) | null = null;

  private size = new Vector2(1, 1);
  /** Framebuffer size in device pixels. */
  private fbSize = new Vector2(1, 1);

  constructor(renderer: WebGLRenderer, quality: PipelineQuality = QUALITY_PRESETS.high) {
    this.renderer = renderer;
    this.quality = { ...quality };
    this.createTargets(1, 1);
    this.createPasses();
    this.compositePass.uniforms.uBloomStrength.value = this.quality.bloom ? BLOOM_STRENGTH : 0;
    this.compositePass.uniforms.uInteriorLines.value = this.quality.interiorLines ? 1 : 0;
  }

  /**
   * Bloom extract needs values above 1. Play high has bloom off, so the main
   * target can be LDR: half the bandwidth of a 2× half-float MRT, which is the
   * fill that was missing 60 fps on mid-range retina.
   */
  private sceneColorType() {
    return this.quality.bloom && this.renderer.capabilities.isWebGL2 ? HalfFloatType : UnsignedByteType;
  }

  private createTargets(w: number, h: number): void {
    const colorType = this.sceneColorType();

    this.main?.dispose();
    this.main = new WebGLRenderTarget(w, h, {
      count: 2,
      type: colorType,
      format: RGBAFormat,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      depthBuffer: true,
      stencilBuffer: false,
      samples: this.quality.samples,
    });
    this.main.textures[0].name = 'sceneColor';
    this.main.textures[0].colorSpace = NoColorSpace;
    // The normal/depth attachment must never be filtered or colour-managed:
    // a bilinear tap between two surfaces invents a normal that exists nowhere.
    this.main.textures[1].name = 'sceneNormalDepth';
    this.main.textures[1].minFilter = NearestFilter;
    this.main.textures[1].magFilter = NearestFilter;
    this.main.textures[1].colorSpace = NoColorSpace;

    const half = (v: number) => Math.max(1, Math.floor(v));
    const { w: lw, h: lh } = this.lineDims(w, h);

    this.lines?.dispose();
    this.lines = new WebGLRenderTarget(lw, lh, {
      type: UnsignedByteType,
      format: RGBAFormat,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      depthBuffer: false,
      colorSpace: NoColorSpace,
    });

    // Scene depth copy: the ocean samples this to find the waterline against
    // hulls. Nearest filtering — an interpolated depth is a depth that is not
    // on any surface, and the foam threshold would smear. Sized with the Sobel
    // target so the 2× play path does not pay a second full-res blit.
    this.depthCopy?.dispose();
    this.depthCopy = new WebGLRenderTarget(lw, lh, {
      type: UnsignedByteType,
      format: RGBAFormat,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      depthBuffer: false,
      colorSpace: NoColorSpace,
    });

    const bw = this.quality.bloom ? half(w / this.quality.bloomScale) : 1;
    const bh = this.quality.bloom ? half(h / this.quality.bloomScale) : 1;
    for (const key of ['bright', 'blurA', 'blurB'] as const) {
      this[key]?.dispose();
      this[key] = new WebGLRenderTarget(bw, bh, {
        type: this.quality.bloom ? colorType : UnsignedByteType,
        format: RGBAFormat,
        minFilter: LinearFilter,
        magFilter: LinearFilter,
        depthBuffer: false,
        colorSpace: NoColorSpace,
      });
    }
  }

  private createPasses(): void {
    this.sobelPass = new FullScreenPass(
      SOBEL_FRAG,
      {
        tNormalDepth: { value: null },
        /** The post-ocean attachment, used only to reject drowned pixels. */
        tPostND: { value: null },
        uTexel: { value: new Vector2() },
        // A Sobel over unit normals maxes out near 5.7 (a 180-degree flip across
        // the kernel). An icosahedron's 41-degree facet edge measures about 2.8
        // and a deck-to-bulkhead corner about 5.6, while the ocean's remaining
        // ripple detail — it writes a normal already flattened 75% towards up —
        // reaches about 2.0 at a crest. Swept in steps against the isolated
        // mask: at 1.7 the water was still being drawn, by 2.8 the icosahedron's
        // facet edges were starting to drop out. 2.2 is the middle of that gap.
        uNormalThreshold: { value: 2.2 },
        // Relative depth *curvature* per pixel. A crease where one surface
        // passes in front of another gives a step of order (gap / distance); a
        // smooth surface, however steeply it is sloped, gives near zero. The
        // crease stack's 45 cm steps at 6 m measure about 0.11, so 0.075 holds
        // them with margin while dropping the ocean's self-occluding crests.
        uDepthThreshold: { value: 0.075 },
        // Curvature this large cannot be a crease — it is one surface ending
        // and another beginning, which the hull shell has already inked.
        uSilhouetteReject: { value: 0.45 },
        // Relative screen-space depth slope above which a surface is treated as
        // raking away from the camera rather than facing it, and its normal
        // gradient as foreshortening rather than a crease.
        //
        // This is a safety net for opaque geometry only — a long deck seen from
        // astern, a ramp at the horizon — where the normal Sobel would otherwise
        // scribble on a surface whose detail is under a pixel wide. It is NOT
        // the water fix; see the note where tNormalDepth is bound. Kept as loose
        // as it can be and still do that job: the swept coverage on the
        // calibration crease stack was 1.56% unsuppressed, 1.35% at 0.20 and
        // 1.07% at 0.13, so tightening past 0.20 starts eating real creases.
        uGrazeReject: { value: 0.3 },
        uLineStrength: { value: 0.95 },
        uCameraFar: { value: 4000 },
        uScale: { value: 1.0 },
      },
      'SobelInteriorLines',
    );

    this.copyPass = new FullScreenPass(
      COPY_FRAG,
      { tColor: { value: null } },
      'DepthCopy',
    );

    this.brightPass = new FullScreenPass(
      BRIGHT_FRAG,
      // The threshold sits above 1 on purpose. Attachment 0 is half-float and
      // holds pre-tonemap values: a lit saturated paint reaches ~1.4 all by
      // itself, so a sub-1 threshold blooms every lit surface in the frame and
      // every silhouette grows a halo. A lit paint plus its banded highlight
      // reaches about 1.7, and blooming that softened the one edge the highlight
      // exists to have; foam and gate glow run well past 2.
      { tColor: { value: null }, uThreshold: { value: 1.55 }, uKnee: { value: 0.35 } },
      'BrightExtract',
    );

    this.blurPass = new FullScreenPass(
      BLUR_FRAG,
      { tColor: { value: null }, uDir: { value: new Vector2(1, 0) }, uTexel: { value: new Vector2() } },
      'GraphicBlur',
    );

    this.compositePass = new FullScreenPass(
      COMPOSITE_FRAG,
      {
        tColor: { value: null },
        tLines: { value: null },
        tBloom: { value: null },
        uInteriorLines: { value: 0 },
        uBloomStrength: { value: BLOOM_STRENGTH },
        uVignette: { value: 0.18 },
        // Swept as a 3x3 grid against the knot frame and scored on mean
        // saturation versus clipped-pixel count, because "more contrasty" and
        // "more saturated" both look better in isolation and only one of them is
        // cheap. Saturation 1.25 with contrast 1.16 and contrast 1.30 with
        // saturation 1.10 land on identical mean chroma (0.671), but the
        // saturation route clips 12.7% of pixels against the contrast route's
        // 16.0%. Doing both gained 0.011 more chroma for another 8 points of
        // clipping, which is not a trade. So: take it out of saturation, and
        // spend only as much contrast as the ocean's band separation needs.
        uSaturation: { value: 1.25 },
        uContrast: { value: 1.2 },
        uExposure: { value: 1.08 },
        uTexel: { value: new Vector2() },
        uTime: { value: 0 },
        uFlash: { value: 0 },
        uFlashColor: { value: new Color(1, 1, 1) },
        // 0 = normal output, 1 = packed normals, 2 = linear depth,
        // 3 = the isolated line mask. Driven by the harness and the ?debug flag.
        uDebugView: { value: 0 },
        tDebug: { value: null },
      },
      'CelComposite',
    );
  }

  private lineDims(w: number, h: number): { w: number; h: number } {
    const s = Math.max(1, this.quality.lineScale);
    return { w: Math.max(1, Math.floor(w / s)), h: Math.max(1, Math.floor(h / s)) };
  }

  setSize(cssWidth: number, cssHeight: number, pixelRatio: number): void {
    this.size.set(cssWidth, cssHeight);
    const w = Math.max(2, Math.floor(cssWidth * pixelRatio));
    const h = Math.max(2, Math.floor(cssHeight * pixelRatio));
    if (w === this.fbSize.x && h === this.fbSize.y) return;
    this.fbSize.set(w, h);

    this.main.setSize(w, h);
    const { w: lw, h: lh } = this.lineDims(w, h);
    this.lines.setSize(lw, lh);
    this.depthCopy.setSize(lw, lh);
    const bw = this.quality.bloom ? Math.max(1, Math.floor(w / this.quality.bloomScale)) : 1;
    const bh = this.quality.bloom ? Math.max(1, Math.floor(h / this.quality.bloomScale)) : 1;
    this.bright.setSize(bw, bh);
    this.blurA.setSize(bw, bh);
    this.blurB.setSize(bw, bh);
  }

  setQuality(q: Partial<PipelineQuality>): void {
    const samplesChanged = q.samples !== undefined && q.samples !== this.quality.samples;
    const scaleChanged = q.bloomScale !== undefined && q.bloomScale !== this.quality.bloomScale;
    const lineChanged = q.lineScale !== undefined && q.lineScale !== this.quality.lineScale;
    const bloomChanged = q.bloom !== undefined && q.bloom !== this.quality.bloom;
    Object.assign(this.quality, q);
    if (samplesChanged || scaleChanged || lineChanged || bloomChanged) {
      this.createTargets(this.fbSize.x, this.fbSize.y);
    }
    // render() only ever forces the strength to zero, so that a tuning sweep on
    // uBloomStrength is not overwritten on the next frame; the tier change is
    // the one place the value has to be put back.
    this.compositePass.uniforms.uBloomStrength.value = this.quality.bloom ? BLOOM_STRENGTH : 0;
    this.compositePass.uniforms.uInteriorLines.value = this.quality.interiorLines ? 1 : 0;
  }

  get normalDepthTexture() {
    return this.main.textures[1];
  }

  setDebugView(mode: number): void {
    this.compositePass.uniforms.uDebugView.value = mode;
  }

  /** Poke a single pass uniform by name. Used for tuning sweeps from the harness. */
  setPassUniform(pass: string, name: string, value: number): void {
    const target: Record<string, FullScreenPass> = {
      sobel: this.sobelPass,
      bright: this.brightPass,
      composite: this.compositePass,
    };
    const p = target[pass];
    if (p && p.uniforms[name]) p.uniforms[name].value = value;
  }

  /** Trigger a one-frame full-screen colour flash (boost pickup, hard landing). */
  flash(color: Color, strength: number): void {
    (this.compositePass.uniforms.uFlashColor.value as Color).copy(color);
    this.compositePass.uniforms.uFlash.value = strength;
  }

  /** Accumulated across all slices of the last frame (three.js resets per render). */
  readonly stats = { calls: 0, triangles: 0, points: 0, lines: 0 };

  render(scene: Scene, camera: Camera, elapsed: number): void {
    const r = this.renderer;
    const { x: w, y: h } = this.fbSize;
    const texel = new Vector2(1 / w, 1 / h);
    const prevAutoClear = r.autoClear;
    const prevMask = camera.layers.mask;

    // three.js zeroes renderer.info on every render() call, so the multi-slice
    // frame has to be tallied by hand or the HUD reports only the last pass.
    this.stats.calls = 0;
    this.stats.triangles = 0;
    const tally = () => {
      this.stats.calls += r.info.render.calls;
      this.stats.triangles += r.info.render.triangles;
    };

    // --- opaque, then depth copy, ocean, sky holes, overlay ---
    r.setRenderTarget(this.main);
    r.autoClear = false;
    r.clear(true, true, true);

    // --- 1a. opaque slice (hulls, riders, props) ---
    camera.layers.set(LAYER_OPAQUE);
    r.render(scene, camera);
    tally();

    // --- copy packed normal/depth so the water can read it while still
    //     writing to the same attachment.
    //
    // Skipped when interior lines are off. The copy exists for two readers:
    // the Sobel pass and the ocean's waterline foam. Both are compiled or
    // switched off on the low tier, so the extra full-screen blit is free
    // work on the fill-bound path.
    if (this.quality.interiorLines) {
      this.copyPass.uniforms.tColor.value = this.main.textures[1];
      this.copyPass.render(r, this.depthCopy);
      this.onDepthReady?.(this.depthCopy.texture, this.depthCopy.width, this.depthCopy.height);
    }

    // --- ocean. No clear: must depth-test against opaque geometry.
    r.setRenderTarget(this.main);
    camera.layers.set(LAYER_OCEAN);
    r.render(scene, camera);
    tally();

    // Sky last among the solid slices, with depth test on. The dome used to
    // paint the whole target first, then the ocean overwrote every water
    // pixel — a full-screen fill that never showed. Drawing it into the
    // leftover far-plane holes (zenith, above the horizon) is the same picture
    // at a fraction of the fill. Overlay still follows so spray and lamps sit
    // on top of both water and sky.
    camera.layers.set(LAYER_SKY);
    r.render(scene, camera);
    tally();

    camera.layers.set(LAYER_OVERLAY);
    r.render(scene, camera);
    tally();

    camera.layers.mask = prevMask;
    r.autoClear = prevAutoClear;

    const colorTex = this.main.textures[0];

    // --- 2. Sobel interior lines (mask only; colour stays native-res) ---
    if (this.quality.interiorLines) {
      const u = this.sobelPass.uniforms;
      // THE PRE-OCEAN SNAPSHOT, not the final attachment.
      //
      // depthCopy is taken between the opaque slice and the ocean slice — it
      // exists so the water can read the geometry it is about to draw over — and
      // that makes it exactly the buffer the interior-line pass wants: opaque
      // geometry and nothing else. Running the Sobel on the final attachment put
      // the ocean in front of it, and no threshold could get the water out. A
      // sweep of the grazing reject bears that out: taking the water's ink from
      // 1.44% coverage down to 0.93% cost the calibration crease stack half of
      // its lines, because at a wave crest the water genuinely self-occludes and
      // the curvature it produces is the same measurement a hull crease makes.
      // The two are not separable by threshold. They are trivially separable by
      // which slice drew them, which is what this does — and it is the right
      // answer for the art direction anyway: Wave Race water carries banded
      // colour and no interior ink at all.
      u.tNormalDepth.value = this.depthCopy.texture;
      u.tPostND.value = this.main.textures[1];
      // Kernel is one *output* pixel. On the 2× play path the mask is half-res,
      // so that is one CSS pixel — the same weight medium draws at 1×.
      (u.uTexel.value as Vector2).set(1 / this.lines.width, 1 / this.lines.height);
      u.uScale.value = Math.max(1, Math.round(this.lines.height / 540));
      this.sobelPass.render(r, this.lines);
    }

    // --- 3. graphic bloom ---
    let bloomTex = null;
    if (this.quality.bloom) {
      this.brightPass.uniforms.tColor.value = colorTex;
      this.brightPass.render(r, this.bright);

      // ONE separable pass, not two. The second, wider pair spread the glow far
      // enough that a highlight on the calibration sphere lifted the whole
      // upper half of the sphere: on a pure red paint that added light has
      // nowhere to go but the green and blue channels, and the measured chroma
      // across every band above the terminator collapsed to a pastel. A single
      // 9-tap at half resolution is a ~6 px glow — graphic, local to the thing
      // that is actually bright, and no help to anything that is not.
      const bTexel = new Vector2(1 / this.bright.width, 1 / this.bright.height);
      const bu = this.blurPass.uniforms;
      bu.tColor.value = this.bright.texture;
      (bu.uTexel.value as Vector2).copy(bTexel);
      (bu.uDir.value as Vector2).set(1, 0);
      this.blurPass.render(r, this.blurA);

      bu.tColor.value = this.blurA.texture;
      (bu.uDir.value as Vector2).set(0, 1);
      this.blurPass.render(r, this.blurB);

      bloomTex = this.blurB.texture;
    }

    // --- 4. composite to screen ---
    const cu = this.compositePass.uniforms;
    cu.tColor.value = colorTex;
    cu.tLines.value = this.lines.texture;
    cu.uInteriorLines.value = this.quality.interiorLines ? 1 : 0;
    cu.tBloom.value = bloomTex;
    cu.tDebug.value = this.main.textures[1];
    if (!this.quality.bloom) cu.uBloomStrength.value = 0;
    (cu.uTexel.value as Vector2).copy(texel);
    cu.uTime.value = elapsed;
    this.compositePass.render(r, null);

    // Decay the flash so a caller only needs to poke it once.
    cu.uFlash.value *= 0.82;
    if (cu.uFlash.value < 0.002) cu.uFlash.value = 0;

    r.setRenderTarget(null);
  }

  dispose(): void {
    this.main.dispose();
    this.lines.dispose();
    this.depthCopy.dispose();
    this.bright.dispose();
    this.blurA.dispose();
    this.blurB.dispose();
    this.sobelPass.dispose();
    this.copyPass.dispose();
    this.brightPass.dispose();
    this.blurPass.dispose();
    this.compositePass.dispose();
  }
}

// ---------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------

/**
 * Sobel over the packed normal/depth buffer.
 *
 * Two gradients are computed: one over the decoded view normal (catches creases
 * where the surface bends but stays continuous in depth) and one over linear
 * depth (catches overlaps).
 *
 * KEEPING THE TWO LINE SYSTEMS FROM DOUBLING UP is the hard part, and it takes
 * two independent mechanisms:
 *
 *  1. Ink pixels written by the inverted-hull shells carry a zero normal (see
 *     writeInkNormalDepth). Any *neighbour* tap carrying one is replaced by the
 *     centre sample, so the ink band contributes no gradient at all. This is
 *     what handles thin geometry — a mast, a rider's forearm — where the front
 *     and back surfaces are millimetres apart and no depth heuristic can tell a
 *     silhouette from a crease.
 *
 *  2. The depth gradient is normalised by the centre depth, making it a
 *     *relative* step that is scale invariant, and a large relative step is
 *     read as a silhouette and suppressed. Absolute thresholds cannot work
 *     here: the same 20 cm crease is 0.00005 of the far plane at 3 m and at
 *     300 m, but at 300 m it is a tenth of a pixel wide. The old absolute
 *     uSilhouetteReject of 0.0055 could only be reached by geometry more than
 *     22 m deep, so in practice it never fired at all.
 */
const SOBEL_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
layout(location = 0) out vec4 outColor;

uniform sampler2D tNormalDepth;
uniform sampler2D tPostND;
uniform vec2 uTexel;
uniform float uNormalThreshold;
uniform float uDepthThreshold;
uniform float uSilhouetteReject;
uniform float uGrazeReject;
uniform float uLineStrength;
uniform float uScale;

vec3 decodeNormal(vec4 nd) { return nd.xyz * 2.0 - 1.0; }

/**
 * Is this pixel exempt from interior lines?
 *
 * Two exemption encodings have to be honoured, and both are recognisable by
 * looking at the *decoded* vector rather than the stored bytes:
 *
 *  - The sky, the racing ribbon and the cleared framebuffer store a raw zero or
 *    near-zero, which decodes to roughly (-1,-1,-1). A visible fragment's view
 *    normal cannot point away from the camera, so a strongly negative z is a
 *    reliable tell. (The old test compared the stored value against zero, which
 *    the *cleared* buffer — ink blue, not black — narrowly failed.)
 *  - The outline shells store the encoded zero, which decodes to (0,0,0). MSAA
 *    averaging shortens that towards the neighbouring surface normal without
 *    rotating it, so a length threshold catches every pixel more than about
 *    half covered by ink and lets the rest through pointing the right way.
 */
bool optedOut(vec4 s) {
  vec3 dn = s.xyz * 2.0 - 1.0;
  return dot(dn, dn) < 0.36 || dn.z < -0.35;
}

/**
 * Resolve an opposite pair of taps.
 *
 * Where one of the pair opted out, it is replaced by the LINEAR EXTRAPOLATION
 * of its partner through the centre, not by the centre itself. Substituting the
 * centre leaves a one-sided gradient at the boundary, which puts a line one
 * pixel inside every ink band on every curved surface; extrapolating asserts
 * "this surface carries on", which is the only substitution that makes the ink
 * genuinely invisible to both the gradient and the curvature terms below.
 */
void resolve(vec2 uvA, vec2 uvB, vec4 c, out vec4 a, out vec4 b) {
  a = texture(tNormalDepth, uvA);
  b = texture(tNormalDepth, uvB);
  bool oa = optedOut(a);
  bool ob = optedOut(b);
  if (oa && ob) { a = c; b = c; }
  else if (oa) { a = 2.0 * c - b; }
  else if (ob) { b = 2.0 * c - a; }
}

void main() {
  vec2 t = uTexel * uScale;
  vec4 c  = texture(tNormalDepth, vUv);

  // Sky, ink and anything else that opted out has a zero normal; never line it.
  // On the pre-ocean buffer, open water reads as the sky's opt-out and lands
  // here, which is the whole point.
  if (optedOut(c)) {
    outColor = vec4(0.0);
    return;
  }

  // Drowned pixels. The pre-ocean buffer still holds the submerged part of a
  // hull, so without this the crease lines of a boat would keep drawing straight
  // through the water in front of them. The relative tolerance matters: at 90 m
  // an absolute epsilon either lets the whole ocean through or eats the lines on
  // anything that is merely close to the waterline.
  // Reject if this pixel OR ANY OF ITS NEIGHBOURS is behind water.
  //
  // Testing only the centre was not enough. The Sobel kernel is three pixels
  // wide, so at the waterline it straddles pixels that survived and pixels the
  // ocean has since covered — and in the pre-ocean buffer that boundary is a
  // colossal depth step, because on one side there is hull and on the other
  // there is nothing. The pass drew that step as ink, which appeared in six
  // captured frames as a thin open trapezoid with two long verticals hanging
  // beneath the boat, on the open water, attached to nothing. It looked exactly
  // like CAD construction geometry or a selection marquee, and it is the kind
  // of artefact a viewer calls unfinished within a second.
  //
  // Widening the test to the kernel's own footprint means a line is only drawn
  // where every sample contributing to it is still visible in the final image.
  vec2 tk = uTexel * uScale;
  float postC = texture(tPostND, vUv).w;
  float postL = texture(tPostND, vUv + vec2(-tk.x, 0.0)).w;
  float postR = texture(tPostND, vUv + vec2( tk.x, 0.0)).w;
  float postU = texture(tPostND, vUv + vec2(0.0,  tk.y)).w;
  float postD = texture(tPostND, vUv + vec2(0.0, -tk.y)).w;
  float postMin = min(min(postC, postL), min(postR, min(postU, postD)));
  // A relative test alone cannot see this. Water covering a submerged hull sits
  // only centimetres in front of it, so at 8 m the difference is 0.1% — nowhere
  // near the 1.5% the relative threshold needs, and every crease on the drowned
  // part of the hull was drawn straight through the ocean. That is what the
  // trapezoid of "construction lines" under the boat actually was: the outline
  // of its own submerged sponsons, inked onto the foam above them.
  //
  // The absolute term is in far-plane units: 1.5e-5 of 4000 m is 6 cm, which is
  // comfortably above the half-float depth buffer's resolution at these ranges
  // and far below any gap that could be a real crease.
  if (postMin < c.w * 0.985 || postMin < c.w - 1.5e-5) {
    outColor = vec4(0.0);
    return;
  }

  vec4 l, r, u, d, tl, br, tr, bl;
  resolve(vUv + vec2(-t.x, 0.0), vUv + vec2( t.x, 0.0), c, l, r);
  resolve(vUv + vec2(0.0,  t.y), vUv + vec2(0.0, -t.y), c, u, d);
  resolve(vUv + vec2(-t.x,  t.y), vUv + vec2( t.x, -t.y), c, tl, br);
  resolve(vUv + vec2( t.x,  t.y), vUv + vec2(-t.x, -t.y), c, tr, bl);

  // --- normal gradient (Sobel over the 3 normal channels) ---
  vec3 gxN = decodeNormal(tl) + 2.0 * decodeNormal(l) + decodeNormal(bl)
           - decodeNormal(tr) - 2.0 * decodeNormal(r) - decodeNormal(br);
  vec3 gyN = decodeNormal(tl) + 2.0 * decodeNormal(u) + decodeNormal(tr)
           - decodeNormal(bl) - 2.0 * decodeNormal(d) - decodeNormal(br);
  float normalEdge = sqrt(dot(gxN, gxN) + dot(gyN, gyN));

  // --- depth CURVATURE, not depth gradient -------------------------------
  //
  // A Sobel on depth cannot tell "one surface seen nearly edge-on" from "two
  // surfaces overlapping": both produce an enormous gradient. That is why the
  // gradient version drew an ink line along the far side of every wave crest in
  // the ocean, all the way to the horizon, and no amount of threshold tuning
  // fixed it — the water's gradient at a grazing crest genuinely exceeds a
  // hull's gradient at a real overlap.
  //
  // The second difference does distinguish them, because a plane of ANY slope
  // has zero curvature. Normalising by the centre depth then makes the measure
  // scale invariant, so the same crease reads the same at 3 m and at 100 m.
  float curve = abs(c.w * 2.0 - l.w - r.w)
              + abs(c.w * 2.0 - u.w - d.w)
              + 0.5 * (abs(c.w * 2.0 - tl.w - br.w) + abs(c.w * 2.0 - tr.w - bl.w));
  float relDepth = curve / max(c.w, 1e-5);

  float nLine = smoothstep(uNormalThreshold, uNormalThreshold * 1.9, normalEdge);
  float dLine = smoothstep(uDepthThreshold, uDepthThreshold * 2.2, relDepth);

  // A curved surface's normal gradient is UNBOUNDED at its own silhouette: as
  // the surface turns away, dN/dpixel goes to infinity. So the normal term draws
  // a line just inside every rounded object however carefully the ink is
  // flagged, and that — not the ink band — was the actual source of the doubled
  // silhouettes. Fade the term out where the view normal has gone edge-on,
  // because those pixels are a silhouette by definition and the hull shell has
  // already inked them.
  float faceOn = abs(decodeNormal(c).z);
  nLine *= smoothstep(0.04, 0.22, faceOn);

  // --- grazing-surface reject, measured from DEPTH, not from the normal ---
  //
  // The faceOn gate above cannot see the ocean, and the isolated line mask
  // proves it: the water carried long heavy strokes across the whole mid
  // distance while every hull crease behaved. The reason is that the ocean
  // deliberately writes a normal flattened most of the way towards world up, so
  // its *stored* normal claims to be face-on while its actual geometry is
  // grazing enough that one pixel spans metres of surface. Over that footprint
  // the un-flattened ripple detail folds many wavelengths into a couple of
  // pixels and the normal Sobel saturates — a real gradient, on real geometry,
  // that no threshold on the gradient itself can separate from a crease.
  //
  // The screen-space depth SLOPE does see it, because slope is a property of the
  // geometry rather than of the shading normal. Relative to depth it is scale
  // invariant: a face-on surface at any distance measures near zero (the crease
  // stack's decks come in around 0.01), a surface raked far enough that a pixel
  // covers a significant fraction of its own distance measures two orders of
  // magnitude higher (mid-distance water, 0.2 and up). Suppressing the normal
  // term across that gap removes the water without touching a single crease.
  //
  // The depth term is deliberately left alone: a genuine crease seen at a
  // grazing angle — the deck line of a boat viewed from astern — still needs its
  // line, and the curvature measure was already immune to slope.
  float gxD = tl.w + 2.0 * l.w + bl.w - tr.w - 2.0 * r.w - br.w;
  float gyD = tl.w + 2.0 * u.w + tr.w - bl.w - 2.0 * d.w - br.w;
  float relSlope = sqrt(gxD * gxD + gyD * gyD) / max(c.w, 1e-5);
  nLine *= 1.0 - smoothstep(uGrazeReject, uGrazeReject * 2.6, relSlope);

  // A relative step this large is a silhouette, not a crease.
  float silhouette = smoothstep(uSilhouetteReject, uSilhouetteReject * 1.8, relDepth);
  float line = max(nLine, dLine) * (1.0 - silhouette);

  // Fade interior lines out between 26 m and 46 m (c.w is depth over the 4000 m
  // far plane). Beyond that a crease is thinner than a pixel, so the line stops
  // describing a form and becomes aliasing noise that crawls as the boat moves.
  // Cutting in this close also removes the last of the water: what survives the
  // curvature test on the ocean is real self-occlusion at wave crests, which no
  // threshold can distinguish from a hull crease of the same relative size, but
  // it happens almost entirely in the mid distance. The hull shells keep drawing
  // silhouettes out to the horizon regardless.
  line *= 1.0 - smoothstep(0.0065, 0.0115, c.w);
  line = clamp(line * uLineStrength, 0.0, 1.0);
  outColor = vec4(line, 0.0, 0.0, 1.0);
}
`;

const COPY_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
layout(location = 0) out vec4 outColor;
uniform sampler2D tColor;
void main() { outColor = texture(tColor, vUv); }
`;

const BRIGHT_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
layout(location = 0) out vec4 outColor;
uniform sampler2D tColor;
uniform float uThreshold;
uniform float uKnee;

void main() {
  vec3 c = texture(tColor, vUv).rgb;
  float l = max(max(c.r, c.g), c.b);
  // Soft knee so the bloom source has a shape rather than a hard clip ring.
  float soft = clamp(l - uThreshold + uKnee, 0.0, 2.0 * uKnee);
  soft = soft * soft / (4.0 * uKnee + 0.0001);
  float contrib = max(soft, l - uThreshold) / max(l, 0.0001);
  outColor = vec4(c * contrib, 1.0);
}
`;

const BLUR_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
layout(location = 0) out vec4 outColor;
uniform sampler2D tColor;
uniform vec2 uDir;
uniform vec2 uTexel;

void main() {
  // 9-tap gaussian using linear-sampling pairs (5 fetches).
  vec2 o = uDir * uTexel;
  vec3 c = texture(tColor, vUv).rgb * 0.227027;
  c += texture(tColor, vUv + o * 1.3846).rgb * 0.316216;
  c += texture(tColor, vUv - o * 1.3846).rgb * 0.316216;
  c += texture(tColor, vUv + o * 3.2308).rgb * 0.070270;
  c += texture(tColor, vUv - o * 3.2308).rgb * 0.070270;
  outColor = vec4(c, 1.0);
}
`;

/**
 * Composite + grade.
 *
 * Deliberately *not* a filmic tonemap: filmic curves desaturate highlights,
 * which is the opposite of what printed cel art does. Instead we use a gentle
 * Reinhard-on-luminance so bright foam stays white without the saturated hull
 * colours washing out, then push saturation and contrast back up.
 */
const COMPOSITE_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
layout(location = 0) out vec4 outColor;

uniform sampler2D tColor;
uniform sampler2D tLines;
uniform sampler2D tBloom;
uniform sampler2D tDebug;
uniform float uDebugView;
uniform float uInteriorLines;
uniform float uBloomStrength;
uniform float uVignette;
uniform float uSaturation;
uniform float uContrast;
uniform float uExposure;
uniform float uFlash;
uniform vec3 uFlashColor;
uniform vec2 uTexel;
uniform float uTime;

const vec3 INK = ${glslVec3(PALETTE.ink)};
const vec3 PAPER = ${glslVec3(PALETTE.skyHaze)};
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

vec3 linearToSRGB(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(max(c, 0.0), vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

void main() {
  // Debug taps. Verifying "the MRT normal buffer is populated" by reading the
  // shader source is exactly the kind of assumption this project is not allowed
  // to make, so the buffer is directly viewable instead.
  if (uDebugView > 0.5) {
    vec4 nd = texture(tDebug, vUv);
    if (uDebugView < 1.5) { outColor = vec4(nd.rgb, 1.0); return; }
    if (uDebugView < 2.5) { outColor = vec4(vec3(nd.w * 12.0), 1.0); return; }
    // Mode 3: isolated interior-line mask (white lines on paper).
    if (uDebugView < 3.5) {
      float line = texture(tLines, vUv).r;
      outColor = vec4(vec3(1.0 - line), 1.0);
      return;
    }
  }

  vec3 c = texture(tColor, vUv).rgb * uExposure;

  if (uInteriorLines > 0.5) {
    c = mix(c, INK, texture(tLines, vUv).r);
  }

  if (uBloomStrength > 0.0) {
    c += texture(tBloom, vUv).rgb * uBloomStrength;
  }

  // Luminance-only Reinhard. The shoulder is deliberately shallow (0.22, down
  // from an initial 0.42): a strong shoulder pulls a saturated paint's bright
  // channel down along with the rest and the whole frame drifts towards pastel,
  // which is the single most common way a cel look dies. At 0.22 anything under
  // about 1.6 passes through nearly untouched and only genuine over-range —
  // foam, sparks, gate glow — gets rolled off.
  float l = dot(c, LUMA);
  float lm = l / (1.0 + l * 0.22);
  c *= lm / max(l, 0.0001);

  float g = dot(c, LUMA);

  // Split tone before saturation, so the tint rides on the paint rather than
  // being amplified by it. Shadows carry ink-blue and highlights carry paper
  // warmth — the two-ink separation a printed cel has and a lit render does not.
  //
  // Both tints are normalised to unit luminance so they shift hue WITHOUT
  // changing value. The shadow tint used to be a straight multiply by
  // INK * 2 + 0.55, whose own luminance is 0.69, so every shadow in the game
  // was quietly being darkened by a further 15% by a term whose stated job was
  // to tint it.
  vec3 paperTint = PAPER / max(dot(PAPER, LUMA), 1e-4);
  vec3 inkTint = (INK * 2.0 + 0.55);
  inkTint /= max(dot(inkTint, LUMA), 1e-4);
  c = mix(c, c * paperTint, smoothstep(0.55, 1.0, g) * 0.16);
  c = mix(c, c * inkTint, (1.0 - smoothstep(0.0, 0.32, g)) * 0.5);

  // --- saturation, bounded so it cannot clip a channel to zero -------------
  //
  // mix(vec3(g), c, sat) with sat > 1 pushes every channel away from the
  // luminance, so the darkest channel of a saturated colour goes NEGATIVE and
  // the clamp at the end of this shader turns it into a hard zero. That is
  // what was happening: the shade band of the red hull came back as (44,0,0),
  // (0,11,0) or (0,0,22) depending only on which channel happened to cross
  // first, so the same paint had a different shadow hue in every frame and the
  // outline had nothing to separate itself from.
  //
  // The largest boost this pixel can take is the one that lands its darkest
  // channel exactly on zero; take the smaller of that and the requested one.
  float minC = min(min(c.r, c.g), c.b);
  float headroom = g > minC ? g / (g - minC) : 1e9;
  c = mix(vec3(g), c, min(uSaturation, headroom));

  // --- contrast, applied to value only -------------------------------------
  //
  // Pivoted at 0.42 rather than 0.5, because pivoting at mid-grey crushes the
  // ramp's shadow bands into each other and those bands are the whole reason
  // it has four steps. Applied as a scale on luminance with the chroma carried
  // along, rather than as a per-channel offset: an offset subtracts the same
  // absolute amount from all three channels, which for any dark saturated
  // colour drives the two small channels below zero and desaturates it towards
  // a single primary on the way. A scale cannot change a channel's sign and
  // leaves hue and saturation exactly where the ramp put them.
  // The floor is proportional to the input rather than absolute. A pivot at
  // 0.42 subtracts a fixed 0.084 of luminance, which is nothing to a lit band
  // and is most of a shadow band: measured on the crimson hull it scaled the
  // shade band by 0.24, so the ramp's two dark steps arrived on screen almost
  // on top of each other. Holding shadows at no less than 62% of their own
  // value keeps the steps apart and still lets the contrast do its work in the
  // mid-tones, where band separation is what the grade was raised for.
  float lum = dot(c, LUMA);
  float graded = max((lum - 0.42) * uContrast + 0.42, lum * 0.62);
  c *= graded / max(lum, 1e-4);

  // Paper-tinted vignette: darkens towards ink at the corners rather than
  // towards black, which keeps the frame feeling printed. Kept weak — the first
  // guess of 0.34 was mixing 40% ink into the corners, which read as a lens
  // effect on a frame that is meant to read as a printed page.
  vec2 q = vUv - 0.5;
  float vig = 1.0 - dot(q, q) * uVignette * 2.4;
  c = mix(INK * 0.75, c, clamp(vig, 0.0, 1.0));

  // Impact flash
  c = mix(c, uFlashColor, clamp(uFlash, 0.0, 1.0));

  c = clamp(c, 0.0, 1.0);
  outColor = vec4(linearToSRGB(c), 1.0);
}
`;
