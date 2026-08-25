import {
  Camera,
  Color,
  FloatType,
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
 *       -> Sobel interior lines (reads attachment 1, composites onto colour)
 *       -> bright extract + separable blur (graphic bloom, not photographic)
 *       -> composite + paper grade + vignette -> screen
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
}

/** Bloom mix at full quality. Kept as a constant so a harness sweep survives. */
const BLOOM_STRENGTH = 0.42;

export const QUALITY_PRESETS: Record<'low' | 'medium' | 'high' | 'ultra', PipelineQuality> = {
  low: { pixelRatio: 1.0, samples: 0, bloom: false, interiorLines: false, bloomScale: 4 },
  medium: { pixelRatio: 1.0, samples: 0, bloom: true, interiorLines: true, bloomScale: 4 },
  high: { pixelRatio: 1.5, samples: 4, bloom: true, interiorLines: true, bloomScale: 3 },
  ultra: { pixelRatio: 2.0, samples: 4, bloom: true, interiorLines: true, bloomScale: 2 },
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
  }

  private createTargets(w: number, h: number): void {
    const type = this.renderer.capabilities.isWebGL2 ? HalfFloatType : UnsignedByteType;

    this.main?.dispose();
    this.main = new WebGLRenderTarget(w, h, {
      count: 2,
      type,
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

    this.lines?.dispose();
    this.lines = new WebGLRenderTarget(w, h, {
      type,
      format: RGBAFormat,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      depthBuffer: false,
      colorSpace: NoColorSpace,
    });

    // Scene depth copy: the ocean samples this to find the waterline against
    // hulls. Nearest filtering — an interpolated depth is a depth that is not
    // on any surface, and the foam threshold would smear.
    this.depthCopy?.dispose();
    this.depthCopy = new WebGLRenderTarget(w, h, {
      type,
      format: RGBAFormat,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      depthBuffer: false,
      colorSpace: NoColorSpace,
    });

    const bw = half(w / this.quality.bloomScale);
    const bh = half(h / this.quality.bloomScale);
    for (const key of ['bright', 'blurA', 'blurB'] as const) {
      this[key]?.dispose();
      this[key] = new WebGLRenderTarget(bw, bh, {
        type,
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
        tColor: { value: null },
        tNormalDepth: { value: null },
        uTexel: { value: new Vector2() },
        // A Sobel over unit normals maxes out near 5.7 (a 180-degree flip across
        // the kernel). An icosahedron's 41-degree facet edge measures about 2.8
        // and a deck-to-bulkhead corner about 5.6, while the ocean's remaining
        // ripple detail — it writes a normal already flattened 75% towards up —
        // peaks around 1.4. 1.7 sits in that gap.
        uNormalThreshold: { value: 1.7 },
        // Relative depth *curvature* per pixel. A crease where one surface
        // passes in front of another gives a step of order (gap / distance); a
        // smooth surface, however steeply it is sloped, gives near zero.
        uDepthThreshold: { value: 0.02 },
        // Curvature this large cannot be a crease — it is one surface ending
        // and another beginning, which the hull shell has already inked.
        uSilhouetteReject: { value: 0.45 },
        uLineStrength: { value: 0.95 },
        uInk: { value: PALETTE.ink.clone() },
        uCameraFar: { value: 4000 },
        uScale: { value: 1.0 },
        /** Debug: output the isolated line mask instead of the graded frame. */
        uLineMask: { value: 0 },
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
      // every silhouette grows a halo. Only foam, sparks and gate glow should
      // be over 1.15.
      { tColor: { value: null }, uThreshold: { value: 1.15 }, uKnee: { value: 0.3 } },
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
        tBloom: { value: null },
        uBloomStrength: { value: BLOOM_STRENGTH },
        uVignette: { value: 0.18 },
        uSaturation: { value: 1.22 },
        uContrast: { value: 1.12 },
        uExposure: { value: 1.0 },
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

  setSize(cssWidth: number, cssHeight: number, pixelRatio: number): void {
    this.size.set(cssWidth, cssHeight);
    const w = Math.max(2, Math.floor(cssWidth * pixelRatio));
    const h = Math.max(2, Math.floor(cssHeight * pixelRatio));
    if (w === this.fbSize.x && h === this.fbSize.y) return;
    this.fbSize.set(w, h);

    this.main.setSize(w, h);
    this.lines.setSize(w, h);
    this.depthCopy.setSize(w, h);
    const bw = Math.max(1, Math.floor(w / this.quality.bloomScale));
    const bh = Math.max(1, Math.floor(h / this.quality.bloomScale));
    this.bright.setSize(bw, bh);
    this.blurA.setSize(bw, bh);
    this.blurB.setSize(bw, bh);
  }

  setQuality(q: Partial<PipelineQuality>): void {
    const samplesChanged = q.samples !== undefined && q.samples !== this.quality.samples;
    const scaleChanged = q.bloomScale !== undefined && q.bloomScale !== this.quality.bloomScale;
    Object.assign(this.quality, q);
    if (samplesChanged || scaleChanged) {
      this.createTargets(this.fbSize.x, this.fbSize.y);
    }
    // render() only ever forces the strength to zero, so that a tuning sweep on
    // uBloomStrength is not overwritten on the next frame; the tier change is
    // the one place the value has to be put back.
    this.compositePass.uniforms.uBloomStrength.value = this.quality.bloom ? BLOOM_STRENGTH : 0;
  }

  get normalDepthTexture() {
    return this.main.textures[1];
  }

  setDebugView(mode: number): void {
    this.compositePass.uniforms.uDebugView.value = mode;
    // Mode 3 is produced inside the Sobel pass rather than the composite,
    // because the line mask only exists there; the composite then passes it
    // through ungraded so the taps show the raw mask, not a graded version of it.
    this.sobelPass.uniforms.uLineMask.value = mode === 3 ? 1 : 0;
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

    // --- 1a. sky slice. Quarantined so its transparent, depth-test-disabled
    //         cloud and sun quads cannot paint over the world or erase the
    //         normal buffer (see the note in layers.ts).
    r.setRenderTarget(this.main);
    r.autoClear = false;
    r.clear(true, true, true);
    camera.layers.set(LAYER_SKY);
    r.render(scene, camera);
    tally();

    // --- 1b. opaque slice (hulls, riders, props) into the same MRT target ---
    camera.layers.set(LAYER_OPAQUE);
    r.render(scene, camera);
    tally();

    // --- 1c. copy the packed normal/depth attachment so the water can read it
    //         while still writing to the same attachment.
    this.copyPass.uniforms.tColor.value = this.main.textures[1];
    this.copyPass.render(r, this.depthCopy);
    this.onDepthReady?.(this.depthCopy.texture, w, h);

    // --- 1d. ocean, then transparent overlays. No clear: both slices must
    //         depth-test against the opaque geometry already in the buffer.
    r.setRenderTarget(this.main);
    camera.layers.set(LAYER_OCEAN);
    r.render(scene, camera);
    tally();

    camera.layers.set(LAYER_OVERLAY);
    r.render(scene, camera);
    tally();

    camera.layers.mask = prevMask;
    r.autoClear = prevAutoClear;

    let colorTex = this.main.textures[0];

    // --- 2. Sobel interior lines ---
    if (this.quality.interiorLines) {
      const u = this.sobelPass.uniforms;
      u.tColor.value = colorTex;
      u.tNormalDepth.value = this.main.textures[1];
      (u.uTexel.value as Vector2).copy(texel);
      // Keep the line one device pixel wide no matter the pixel ratio, so the
      // ink weight matches the inverted-hull lines at every resolution.
      u.uScale.value = Math.max(1, Math.round(this.fbSize.y / 1080));
      this.sobelPass.render(r, this.lines);
      colorTex = this.lines.texture;
    }

    // --- 3. graphic bloom ---
    let bloomTex = null;
    if (this.quality.bloom) {
      this.brightPass.uniforms.tColor.value = colorTex;
      this.brightPass.render(r, this.bright);

      const bTexel = new Vector2(1 / this.bright.width, 1 / this.bright.height);
      const bu = this.blurPass.uniforms;
      bu.tColor.value = this.bright.texture;
      (bu.uTexel.value as Vector2).copy(bTexel);
      (bu.uDir.value as Vector2).set(1, 0);
      this.blurPass.render(r, this.blurA);

      bu.tColor.value = this.blurA.texture;
      (bu.uDir.value as Vector2).set(0, 1);
      this.blurPass.render(r, this.blurB);

      bu.tColor.value = this.blurB.texture;
      (bu.uDir.value as Vector2).set(1.7, 0);
      this.blurPass.render(r, this.blurA);

      bu.tColor.value = this.blurA.texture;
      (bu.uDir.value as Vector2).set(0, 1.7);
      this.blurPass.render(r, this.blurB);

      bloomTex = this.blurB.texture;
    }

    // --- 4. composite to screen ---
    const cu = this.compositePass.uniforms;
    cu.tColor.value = colorTex;
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

uniform sampler2D tColor;
uniform sampler2D tNormalDepth;
uniform vec2 uTexel;
uniform float uNormalThreshold;
uniform float uDepthThreshold;
uniform float uSilhouetteReject;
uniform float uLineStrength;
uniform float uScale;
uniform float uLineMask;
uniform vec3 uInk;

vec3 decodeNormal(vec4 nd) { return nd.xyz * 2.0 - 1.0; }

bool optedOut(vec4 s) { return dot(s.xyz, s.xyz) < 0.0001; }

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
  if (optedOut(c)) {
    outColor = uLineMask > 0.5 ? vec4(1.0) : texture(tColor, vUv);
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

  // A relative step this large is a silhouette, not a crease.
  float silhouette = smoothstep(uSilhouetteReject, uSilhouetteReject * 1.8, relDepth);
  float line = max(nLine, dLine) * (1.0 - silhouette);

  // Fade interior lines out with distance. Beyond ~120 m a crease is thinner
  // than a pixel and the line is just aliasing noise that crawls when the boat
  // moves; the hull shells keep drawing the silhouettes out to the horizon.
  line *= 1.0 - smoothstep(0.02, 0.075, c.w);
  line = clamp(line * uLineStrength, 0.0, 1.0);

  if (uLineMask > 0.5) {
    outColor = vec4(vec3(1.0 - line), 1.0);
    return;
  }

  vec4 col = texture(tColor, vUv);
  col.rgb = mix(col.rgb, uInk, line);
  outColor = col;
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
uniform sampler2D tBloom;
uniform sampler2D tDebug;
uniform float uDebugView;
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
    // Mode 3: tColor already holds the isolated mask, courtesy of uLineMask.
    if (uDebugView < 3.5) { outColor = vec4(texture(tColor, vUv).rgb, 1.0); return; }
  }

  vec3 c = texture(tColor, vUv).rgb * uExposure;

  if (uBloomStrength > 0.0) {
    c += texture(tBloom, vUv).rgb * uBloomStrength;
  }

  // Luminance-only Reinhard. The shoulder is deliberately shallow (0.22, down
  // from an initial 0.42): a strong shoulder pulls a saturated paint's bright
  // channel down along with the rest and the whole frame drifts towards pastel,
  // which is the single most common way a cel look dies. At 0.22 anything under
  // about 1.6 passes through nearly untouched and only genuine over-range —
  // foam, sparks, gate glow — gets rolled off.
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float lm = l / (1.0 + l * 0.22);
  c *= lm / max(l, 0.0001);

  float g = dot(c, vec3(0.2126, 0.7152, 0.0722));

  // Split tone before saturation, so the tint rides on the paint rather than
  // being amplified by it. Shadows carry ink-blue and highlights carry paper
  // warmth — the two-ink separation a printed cel has and a lit render does not.
  c = mix(c, c * PAPER, smoothstep(0.55, 1.0, g) * 0.16);
  c = mix(c, c * (INK * 2.0 + 0.55), (1.0 - smoothstep(0.0, 0.32, g)) * 0.5);

  c = mix(vec3(g), c, uSaturation);
  // Contrast pivoted at 0.42 rather than 0.5. Pivoting at mid-grey crushes the
  // shadow bands of the ramp into each other, and the shadow bands are the
  // whole reason the ramp has four steps instead of two.
  c = (c - 0.42) * uContrast + 0.42;

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
