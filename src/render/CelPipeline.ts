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
import { LAYER_OCEAN, LAYER_OPAQUE, LAYER_OVERLAY } from './layers.ts';

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
        uNormalThreshold: { value: 0.34 },
        uDepthThreshold: { value: 0.00055 },
        uSilhouetteReject: { value: 0.0055 },
        uLineStrength: { value: 0.85 },
        uInk: { value: PALETTE.ink.clone() },
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
      { tColor: { value: null }, uThreshold: { value: 0.86 }, uKnee: { value: 0.28 } },
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
        uBloomStrength: { value: 0.42 },
        uVignette: { value: 0.34 },
        uSaturation: { value: 1.14 },
        uContrast: { value: 1.06 },
        uExposure: { value: 1.0 },
        uTexel: { value: new Vector2() },
        uTime: { value: 0 },
        uFlash: { value: 0 },
        uFlashColor: { value: new Color(1, 1, 1) },
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
  }

  get normalDepthTexture() {
    return this.main.textures[1];
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

    // --- 1a. opaque slice (sky, hulls, riders, props) into the MRT target ---
    r.setRenderTarget(this.main);
    r.autoClear = true;
    camera.layers.set(LAYER_OPAQUE);
    r.clear(true, true, true);
    r.render(scene, camera);
    tally();

    // --- 1b. copy the packed normal/depth attachment so the water can read it
    //         while still writing to the same attachment.
    this.copyPass.uniforms.tColor.value = this.main.textures[1];
    this.copyPass.render(r, this.depthCopy);
    this.onDepthReady?.(this.depthCopy.texture, w, h);

    // --- 1c. ocean, then transparent overlays. No clear: both slices must
    //         depth-test against the opaque geometry already in the buffer.
    r.autoClear = false;
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
    cu.uBloomStrength.value = this.quality.bloom ? 0.42 : 0;
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
 * Two gradients are computed: one over the decoded view normal (catches
 * creases where the surface bends but stays continuous in depth) and one over
 * linear depth (catches overlaps). The depth gradient is then used *negatively*
 * — a large depth step means we are at a silhouette, where the inverted-hull
 * shell has already drawn ink, so we suppress the Sobel line there. That is the
 * whole trick to running both line systems without doubling.
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
uniform vec3 uInk;

vec3 decodeNormal(vec4 nd) { return nd.xyz * 2.0 - 1.0; }

void main() {
  vec2 t = uTexel * uScale;
  vec4 c  = texture(tNormalDepth, vUv);

  // Sky and cleared pixels have depth 0 and a zero normal; never line them.
  if (dot(c.xyz, c.xyz) < 0.0001) {
    outColor = texture(tColor, vUv);
    return;
  }

  vec4 l  = texture(tNormalDepth, vUv + vec2(-t.x, 0.0));
  vec4 r  = texture(tNormalDepth, vUv + vec2( t.x, 0.0));
  vec4 u  = texture(tNormalDepth, vUv + vec2(0.0,  t.y));
  vec4 d  = texture(tNormalDepth, vUv + vec2(0.0, -t.y));
  vec4 tl = texture(tNormalDepth, vUv + vec2(-t.x,  t.y));
  vec4 tr = texture(tNormalDepth, vUv + vec2( t.x,  t.y));
  vec4 bl = texture(tNormalDepth, vUv + vec2(-t.x, -t.y));
  vec4 br = texture(tNormalDepth, vUv + vec2( t.x, -t.y));

  // --- normal gradient (Sobel over the 3 normal channels) ---
  vec3 gxN = decodeNormal(tl) + 2.0 * decodeNormal(l) + decodeNormal(bl)
           - decodeNormal(tr) - 2.0 * decodeNormal(r) - decodeNormal(br);
  vec3 gyN = decodeNormal(tl) + 2.0 * decodeNormal(u) + decodeNormal(tr)
           - decodeNormal(bl) - 2.0 * decodeNormal(d) - decodeNormal(br);
  float normalEdge = sqrt(dot(gxN, gxN) + dot(gyN, gyN));

  // --- depth gradient ---
  float gxD = tl.w + 2.0 * l.w + bl.w - tr.w - 2.0 * r.w - br.w;
  float gyD = tl.w + 2.0 * u.w + tr.w - bl.w - 2.0 * d.w - br.w;
  float depthEdge = sqrt(gxD * gxD + gyD * gyD);

  // Depth thresholds have to scale with distance or a far-away hull becomes one
  // solid black blob while a near one shows nothing.
  float depthScale = 1.0 / max(c.w, 0.002);

  float nLine = smoothstep(uNormalThreshold, uNormalThreshold + 0.5, normalEdge);
  float dLine = smoothstep(uDepthThreshold, uDepthThreshold * 3.0, depthEdge * depthScale * 0.02);

  // Suppress where the inverted hull already inked the silhouette.
  float silhouette = smoothstep(uSilhouetteReject, uSilhouetteReject * 2.5, depthEdge);
  float line = max(nLine, dLine) * (1.0 - silhouette);

  // Fade interior lines out with distance; at 300 m they are sub-pixel noise.
  line *= 1.0 - smoothstep(0.045, 0.16, c.w);

  vec4 col = texture(tColor, vUv);
  col.rgb = mix(col.rgb, uInk, clamp(line * uLineStrength, 0.0, 1.0));
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
  vec3 c = texture(tColor, vUv).rgb * uExposure;

  if (uBloomStrength > 0.0) {
    c += texture(tBloom, vUv).rgb * uBloomStrength;
  }

  // Luminance-only Reinhard: keeps hue and saturation intact in the highlights.
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float lm = l / (1.0 + l * 0.42);
  c *= lm / max(l, 0.0001);

  // Grade
  float g = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(g), c, uSaturation);
  c = (c - 0.5) * uContrast + 0.5;

  // Paper-tinted vignette: darkens towards ink at the corners rather than
  // towards black, which keeps the frame feeling printed.
  vec2 q = vUv - 0.5;
  float vig = 1.0 - dot(q, q) * uVignette * 2.4;
  c = mix(INK * 0.75, c, clamp(vig, 0.0, 1.0));

  // Impact flash
  c = mix(c, uFlashColor, clamp(uFlash, 0.0, 1.0));

  c = clamp(c, 0.0, 1.0);
  outColor = vec4(linearToSRGB(c), 1.0);
}
`;
