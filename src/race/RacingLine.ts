import {
  AdditiveBlending,
  BufferGeometry,
  Float32BufferAttribute,
  GLSL3,
  Mesh,
  ShaderMaterial,
  Uint32BufferAttribute,
  Vector2,
  type IUniform,
  type Vector3,
} from 'three';
import { PALETTE } from '../core/Palette.ts';
import { CEL_COMMON } from '../render/shaderLib.ts';
import { LAYER_OVERLAY } from '../render/layers.ts';
import { GERSTNER_GLSL, oceanParams } from '../world/gerstner.ts';
import type { Course } from './Course.ts';

/**
 * THE RACING LINE
 *
 * A closed ribbon strip that lies on the water, rides the swell with it, and
 * carries a scrolling chevron pattern plus a corner-preview colour band.
 *
 * WHY IT IS DISPLACED ON THE GPU
 *
 * The ribbon is ~1500 segments long. Re-uploading 3000 displaced vertices every
 * frame would cost more bus bandwidth than the entire rest of the frame, and it
 * would guarantee the ribbon lags the water by exactly one frame. Doing it in
 * the vertex shader from the same `GERSTNER_GLSL` the ocean uses means the two
 * surfaces are evaluated from identical code at identical `t`, so they cannot
 * disagree.
 *
 * WHY IT HAS TO MOVE HORIZONTALLY TOO
 *
 * Gerstner waves displace the surface horizontally as well as vertically — that
 * pinch is what makes the crests sharp. A ribbon that only moved in Y would be
 * at the right *height* but the water would visibly slide sideways underneath
 * it at every crest. So each vertex takes a fraction (`uHorizontalFollow`) of
 * the local horizontal displacement field.
 *
 * It is a fraction and not all of it on purpose. The horizontal field peaks
 * around 3 m for this wave table, and the racing line is a navigational aid:
 * if it wandered 3 m off the true corridor centre it would be actively lying to
 * the player about where the course is. At 0.35 the eye reads it as welded to
 * the water while the line stays within about a metre of centre. When a vertex
 * does move off its sampled water column, its height is corrected to first
 * order using the surface gradient recovered from the analytic normal, so it
 * still cannot punch through.
 *
 * WHY IT REPLICATES THE OCEAN'S DISTANCE FADE
 *
 * `Ocean.ts` rolls wave amplitude down to 55% and choppiness to 35% past ~90 m
 * to stop far-field triangles shimmering. A ribbon evaluated at full amplitude
 * would therefore float above its own water at range. The same fade curve is
 * duplicated here, driven off `uCameraXZ`, so the ribbon tracks whatever the
 * ocean is actually drawing.
 */

/** Number of curvature samples in the corner-preview window. */
export const PREVIEW_SAMPLES = 24;

/**
 * Curvature thresholds for the three preview states, in 1/m. Exported so the
 * HUD's corner arrow can use the same numbers as the ribbon and never disagree
 * with it about whether a corner is amber or red.
 *
 *   flat out : R > 285 m  — the sweeper and both fast straights
 *   ease off : R 105..285 — Reef Bend, Coral Turn, the salt kinks
 *   hard     : R < 105 m  — the hairpin and every chicane element
 */
export const PREVIEW_CURV_WARN = 0.0035;
export const PREVIEW_CURV_DANGER = 0.0095;

export interface RacingLineOptions {
  /** Half-width of the ribbon in metres. 1.8 gives a 3.6 m strip. */
  halfWidth?: number;
  /** Target spacing of ribbon segments in metres. */
  segmentLength?: number;
  /** Height above the water surface, along the surface normal. */
  lift?: number;
  /** Metres covered by the corner-preview colour band. */
  previewDistance?: number;
}

export class RacingLine {
  /** The ribbon body. The additive halo is parented to it. */
  readonly mesh: Mesh;
  /** Additive glow shell, a child of `mesh`. */
  readonly glow: Mesh;
  readonly material: ShaderMaterial;
  readonly glowMaterial: ShaderMaterial;

  /** Metres covered by the corner-preview band. */
  readonly previewDistance: number;
  /** Spacing between the curvature samples the preview band reads. */
  readonly previewSpacing: number;

  private geometry: BufferGeometry;
  private readonly shared: Record<string, IUniform>;
  private readonly curvature = new Float32Array(PREVIEW_SAMPLES);
  private readonly course: Course;
  private readonly halfWidth: number;
  private segmentLength: number;

  constructor(course: Course, opts: RacingLineOptions = {}) {
    this.course = course;
    this.halfWidth = opts.halfWidth ?? 1.8;
    this.segmentLength = opts.segmentLength ?? 1.8;
    const halfWidth = this.halfWidth;
    const segmentLength = this.segmentLength;
    this.previewDistance = opts.previewDistance ?? 230;
    this.previewSpacing = this.previewDistance / (PREVIEW_SAMPLES - 1);

    this.geometry = buildRibbon(course, halfWidth, segmentLength);

    // One set of IUniform objects, referenced by both materials, so a single
    // write in update() feeds the body and the halo.
    this.shared = {
      uTime: { value: 0 },
      uAmplitude: { value: oceanParams.amplitude },
      uChoppiness: { value: oceanParams.choppiness },
      uCameraXZ: { value: new Vector2() },
      uLift: { value: opts.lift ?? 0.12 },
      uHorizontalFollow: { value: 0.35 },
      // Matches Ocean.ts. If those change, these must change with them.
      uDetailFadeStart: { value: 90 },
      uDetailFadeEnd: { value: 700 },

      uLineColor: { value: PALETTE.racingLine.clone() },
      uLineDim: { value: PALETTE.racingLineDim.clone() },
      uWarnColor: { value: PALETTE.uiAmber.clone() },
      uDangerColor: { value: PALETTE.warn.clone() },

      // A chevron every 6.4 m, scrolling forward at 15 m/s. Fast enough to read
      // as flow at 33 m/s of closing speed, slow enough not to strobe when the
      // boat is stopped on the grid.
      uChevronPeriod: { value: 6.4 },
      uChevronSpeed: { value: 15 },
      /** Fraction of each period the chevron ink covers. */
      uChevronDuty: { value: 0.42 },
      /** Sweep-back of the arrowhead, in chevron periods across the half-width. */
      uChevronSkew: { value: 0.34 },

      uPlayerT: { value: 0 },
      uPreviewSpan: { value: this.previewDistance / course.length },
      uCurvAhead: { value: this.curvature },
      uCurvWarn: { value: PREVIEW_CURV_WARN },
      uCurvDanger: { value: PREVIEW_CURV_DANGER },
      uPreviewStrength: { value: 1 },

      uCameraFar: { value: 4000 },
      uCameraNear: { value: 0.1 },
      uFogNear: { value: 420 },
      uFogFar: { value: 2600 },
    };

    this.material = new ShaderMaterial({
      name: 'RacingLine',
      glslVersion: GLSL3,
      uniforms: {
        ...this.shared,
        uWidthScale: { value: 1 },
        uHaloMode: { value: 0 },
      },
      vertexShader: RIBBON_VERT,
      fragmentShader: RIBBON_FRAG,
      transparent: true,
      // The ribbon must not occlude spray or the boats' own overlay effects, and
      // it must not write depth over the water it is lying on.
      depthWrite: false,
      depthTest: true,
    });

    this.glowMaterial = new ShaderMaterial({
      name: 'RacingLineHalo',
      glslVersion: GLSL3,
      uniforms: {
        ...this.shared,
        // Wider than the body so the halo reads as light spilling onto the
        // water rather than as a second, thicker line.
        uWidthScale: { value: 2.6 },
        uHaloMode: { value: 1 },
      },
      vertexShader: RIBBON_VERT,
      fragmentShader: RIBBON_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: AdditiveBlending,
    });

    this.glow = new Mesh(this.geometry, this.glowMaterial);
    this.glow.name = 'RacingLineHalo';
    this.glow.renderOrder = 11;
    this.glow.frustumCulled = false;
    this.glow.userData.noOutline = true;
    this.glow.layers.set(LAYER_OVERLAY);
    this.glow.raycast = () => {};

    this.mesh = new Mesh(this.geometry, this.material);
    this.mesh.name = 'RacingLine';
    // The ribbon spans the whole 2.7 km circuit in one draw, so a bounding
    // sphere test can only ever return "visible"; skipping it also removes the
    // chance of the wave displacement pushing a vertex outside a stale sphere.
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 12;
    this.mesh.userData.noOutline = true;
    this.mesh.layers.set(LAYER_OVERLAY);
    this.mesh.raycast = () => {};
    this.mesh.add(this.glow);
  }

  /** Per-frame wave sync. `cameraPosition` drives the ocean-matching fade. */
  update(elapsed: number, cameraPosition?: Vector3): void {
    const u = this.shared;
    u.uTime.value = elapsed * oceanParams.timeScale;
    u.uAmplitude.value = oceanParams.amplitude;
    u.uChoppiness.value = oceanParams.choppiness;
    if (cameraPosition) {
      (u.uCameraXZ.value as Vector2).set(cameraPosition.x, cameraPosition.z);
    }
  }

  /**
   * Point the corner-preview band at the player.
   *
   * `curvatureAhead` is signed curvature in 1/m sampled every
   * `previewSpacing` metres from `t` forward — i.e. exactly what
   * `Course.curvatureProfile(t, PREVIEW_SAMPLES, previewSpacing, buf)` writes.
   * Because the band is indexed by distance ahead of the player rather than by
   * screen position, the amber and red patches sit *on* the corners and simply
   * get revealed as the player closes on them, instead of sliding along the
   * ribbon like a loading bar.
   */
  setPlayerProgress(t: number, curvatureAhead: Float32Array | readonly number[]): void {
    this.shared.uPlayerT.value = t - Math.floor(t);
    const n = Math.min(PREVIEW_SAMPLES, curvatureAhead.length);
    for (let i = 0; i < n; i++) this.curvature[i] = curvatureAhead[i];
    // Hold the last valid sample rather than zeroing the tail, which would show
    // a false "flat out" green patch at the far end of the band.
    for (let i = n; i < PREVIEW_SAMPLES; i++) this.curvature[i] = this.curvature[n - 1] ?? 0;
  }

  /** 0 disables the corner-preview colouring; 1 is full strength. */
  setPreviewStrength(v: number): void {
    this.shared.uPreviewStrength.value = v;
  }

  setCameraPlanes(near: number, far: number): void {
    this.shared.uCameraNear.value = near;
    this.shared.uCameraFar.value = far;
  }

  /**
   * Segment density. The ribbon is one draw either way; what scales is the
   * six Gerstner evaluations per vertex, ~1500 of them at 1.8 m spacing on a
   * 2.7 km lap. Low/medium coarsen the strip. Chevrons are in UV along the
   * spline, so they do not stretch with the segment length.
   */
  setQuality(tier: 'low' | 'medium' | 'high' | 'ultra'): void {
    const spacing = tier === 'low' ? 3.6 : tier === 'medium' ? 2.5 : tier === 'high' ? 2.4 : 1.8;
    if (spacing === this.segmentLength) return;
    this.segmentLength = spacing;
    const next = buildRibbon(this.course, this.halfWidth, spacing);
    this.mesh.geometry = next;
    this.glow.geometry = next;
    this.geometry.dispose();
    this.geometry = next;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.glowMaterial.dispose();
  }
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/**
 * Build the flat ribbon strip.
 *
 * `position` holds the *centreline* point, not the offset rail vertex: the
 * lateral offset is applied in the vertex shader from `aLeft`/`aSide` so the
 * additive halo can be a wider version of the same buffer instead of a second
 * copy of it.
 */
function buildRibbon(course: Course, halfWidth: number, segmentLength: number): BufferGeometry {
  const segments = Math.max(64, Math.round(course.length / segmentLength));

  const position = new Float32Array(segments * 2 * 3);
  const left = new Float32Array(segments * 2 * 2);
  const side = new Float32Array(segments * 2);
  const half = new Float32Array(segments * 2);
  const trackT = new Float32Array(segments * 2);
  const along = new Float32Array(segments * 2);
  const indices = new Uint32Array(segments * 6);

  const p = course.sample(0);

  for (let i = 0; i < segments; i++) {
    const t = i / segments;
    course.sampleInto(t, p);

    for (let s = 0; s < 2; s++) {
      const v = i * 2 + s;
      position[v * 3 + 0] = p.position.x;
      position[v * 3 + 1] = 0;
      position[v * 3 + 2] = p.position.z;
      left[v * 2 + 0] = p.normal.x;
      left[v * 2 + 1] = p.normal.z;
      side[v] = s === 0 ? -1 : 1;
      half[v] = halfWidth;
      trackT[v] = t;
      along[v] = t * course.length;
    }

    // Wrap the final quad onto vertex 0/1 so the ribbon is a closed loop with
    // no seam vertex to get the chevron phase wrong.
    const a = i * 2;
    const b = i * 2 + 1;
    const c = ((i + 1) % segments) * 2;
    const d = ((i + 1) % segments) * 2 + 1;
    const o = i * 6;
    indices[o + 0] = a;
    indices[o + 1] = c;
    indices[o + 2] = b;
    indices[o + 3] = b;
    indices[o + 4] = c;
    indices[o + 5] = d;
  }

  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(position, 3));
  geo.setAttribute('aLeft', new Float32BufferAttribute(left, 2));
  geo.setAttribute('aSide', new Float32BufferAttribute(side, 1));
  geo.setAttribute('aHalf', new Float32BufferAttribute(half, 1));
  geo.setAttribute('aTrackT', new Float32BufferAttribute(trackT, 1));
  geo.setAttribute('aAlong', new Float32BufferAttribute(along, 1));
  geo.setIndex(new Uint32BufferAttribute(indices, 1));
  geo.boundingSphere = null;
  return geo;
}

// ---------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------

const RIBBON_VERT = /* glsl */ `
precision highp float;

${GERSTNER_GLSL}

uniform float uTime;
uniform float uAmplitude;
uniform float uChoppiness;
uniform vec2 uCameraXZ;
uniform float uLift;
uniform float uHorizontalFollow;
uniform float uWidthScale;
uniform float uDetailFadeStart;
uniform float uDetailFadeEnd;

in vec2 aLeft;
in float aSide;
in float aHalf;
in float aTrackT;
in float aAlong;

out float vAcross;
out float vAlong;
out float vTrackT;
out float vViewDepth;
out float vCrest;
out float vDetail;
out vec3 vWorldPos;

void main() {
  // Rail vertex in the plane: centreline plus the left normal times the signed
  // half-width. Widened for the halo pass.
  vec2 flatXZ = position.xz + aLeft * (aSide * aHalf * uWidthScale);

  // Match the ocean's far-field damping exactly, or the ribbon rides a taller
  // wave field than the water it is supposed to be lying on. "Exactly" now
  // means calling the same function with the same arguments: this used to
  // reimplement the fade with its own constants, which differed from the
  // ocean's, so the ribbon and the water disagreed by tens of centimetres from
  // a hundred metres out.
  float dist = length(flatXZ - uCameraXZ);
  float detail = gerstnerDetail(dist, uDetailFadeStart, uDetailFadeEnd);

  // Invert the horizontal pinch to find the source grid point whose displaced
  // position lands on our authored world XZ, then evaluate the surface there.
  // g.position.xz comes back equal to flatXZ to within the inversion residual,
  // so this gives the water height at the *true* course centreline rather than
  // at wherever the pinch happened to carry a naive sample.
  vec2 src = gerstnerUnproject(flatXZ, uTime, uAmplitude, uChoppiness, detail);
  GerstnerResult g = gerstnerEval(src, uTime, uAmplitude, uChoppiness, detail);

  // The local horizontal displacement field. Following a fraction of it makes
  // the ribbon drift with the crests instead of the crests sliding under it.
  vec2 disp = (g.position.xz - src) * uHorizontalFollow;

  // Moving off the sampled water column changes the surface height; recover the
  // gradient from the analytic normal (dh/dx = -n.x/n.y) and correct to first
  // order. Without this the ribbon submerges on the steep face of every crest.
  vec3 n = g.normal;
  float dh = -(n.x * disp.x + n.z * disp.y) / max(n.y, 0.25);

  vec3 world = vec3(g.position.x + disp.x, g.position.y + dh, g.position.z + disp.y);
  // Lift mostly along the surface normal so the clearance is perpendicular to a
  // steep face, with a vertical bias so it never collapses on a near-vertical
  // crest where n.y is small.
  world += n * uLift + vec3(0.0, uLift * 0.35, 0.0);

  vWorldPos = world;
  vAcross = aSide * uWidthScale;
  vAlong = aAlong;
  vTrackT = aTrackT;
  vCrest = g.crest;
  vDetail = detail;

  vec4 viewPos = viewMatrix * vec4(world, 1.0);
  vViewDepth = -viewPos.z;
  gl_Position = projectionMatrix * viewPos;
}
`;

const RIBBON_FRAG = /* glsl */ `
precision highp float;

layout(location = 0) out vec4 outColor;
layout(location = 1) out vec4 outNormalDepth;

${CEL_COMMON}

uniform float uTime;
uniform vec3 uLineColor;
uniform vec3 uLineDim;
uniform vec3 uWarnColor;
uniform vec3 uDangerColor;

uniform float uChevronPeriod;
uniform float uChevronSpeed;
uniform float uChevronDuty;
uniform float uChevronSkew;

uniform float uPlayerT;
uniform float uPreviewSpan;
uniform float uCurvAhead[${PREVIEW_SAMPLES}];
uniform float uCurvWarn;
uniform float uCurvDanger;
uniform float uPreviewStrength;

uniform float uHaloMode;
uniform float uFogNear;
uniform float uFogFar;

in float vAcross;
in float vAlong;
in float vTrackT;
in float vViewDepth;
in float vCrest;
in float vDetail;
in vec3 vWorldPos;

void main() {
  float across = abs(vAcross);

  // ----------------------------------------------------------------------
  // 1. CORNER PREVIEW
  //
  // Distance ahead of the player, in lap-normalised units, wrapped so the
  // window works across the start/finish seam. Indexing the curvature array by
  // this distance anchors the colour to the *corner*, so an amber patch sits at
  // the braking point and grows as the player closes on it.
  // ----------------------------------------------------------------------
  float rel = fract(vTrackT - uPlayerT + 1.0);
  float inPreview = step(rel, uPreviewSpan) * uPreviewStrength;

  float fi = clamp(rel / max(uPreviewSpan, 1e-6), 0.0, 1.0) * float(${PREVIEW_SAMPLES - 1});
  int i0 = int(floor(fi));
  int i1 = min(i0 + 1, ${PREVIEW_SAMPLES - 1});
  float kf = fract(fi);
  float kappa = abs(mix(uCurvAhead[i0], uCurvAhead[i1], kf));

  // Three hard states, no interpolation: flat out / ease off / hard corner.
  float warn = step(uCurvWarn, kappa);
  float danger = step(uCurvDanger, kappa);
  vec3 previewCol = mix(uLineColor, uWarnColor, warn);
  previewCol = mix(previewCol, uDangerColor, danger);

  vec3 base = mix(uLineColor, previewCol, inPreview);

  // ----------------------------------------------------------------------
  // 2. CHEVRONS
  //
  // Skewing the along-track coordinate by the across coordinate is what turns a
  // set of transverse stripes into arrowheads. Every threshold here is a hard
  // step(), never a smoothstep(), so the ink edge stays a printed edge.
  // ----------------------------------------------------------------------
  float phase = fract(
    (vAlong - uTime * uChevronSpeed) / uChevronPeriod - across * uChevronSkew
  );
  float chevron = step(phase, uChevronDuty);
  // A thin bright leading edge on each chevron so the direction of travel is
  // unambiguous even in a still frame.
  float chevronTip = step(phase, uChevronDuty * 0.22);

  // ----------------------------------------------------------------------
  // 3. RAILS
  //
  // The two outer rails are brighter than the interior, which is what makes a
  // flat strip read as a glowing extrusion. The 1% margin at the very edge is
  // the only soft term in the shader and exists purely to anti-alias the
  // polygon boundary.
  // ----------------------------------------------------------------------
  float rail = step(0.70, across);
  // A drawn contour at the outermost edge. Every other object in the game is
  // inked and the ribbon was not, which is most of why it read as a light
  // effect laid over the scene rather than as a marking painted on the water.
  // Dark green rather than the shared ink: a near-black keyline around a
  // glowing strip reads as a hole cut in the water.
  float edgeInk = step(0.90, across);
  float margin = 1.0 - smoothstep(0.94, 1.0, across);

  // ----------------------------------------------------------------------
  // 4. COMPOSITE
  // ----------------------------------------------------------------------
  if (uHaloMode > 0.5) {
    // Additive spill. Quantised into three steps so even the glow is banded,
    // and hollowed out so it lies entirely OUTSIDE the ribbon rather than on
    // top of it.
    //
    // The halo mesh is 1.5x the ribbon's width, so the ribbon occupies the
    // inner 0.67 of it. Starting the falloff at 0.34 therefore laid half the
    // glow directly over the body — and since the glow is additive at 0.34 of a
    // fully saturated green while the body between chevrons is only 0.11 alpha
    // of a dim one, the spill was substantially louder than the line it was
    // meant to be spilling from. Cropped to native resolution the ribbon read
    // as a soft green wash with no chevrons visible anywhere in it, which is
    // what a critic called a screen tear: the structure was there and was being
    // painted over by its own glow.
    float falloff = 1.0 - clamp((across - 0.66) / 0.34, 0.0, 1.0);
    falloff = floor(falloff * 3.0 + 0.001) / 3.0;
    float pulse = 0.72 + 0.28 * step(0.5, fract(vAlong / 46.0 - uTime * 0.24));

    // The halo returns early, so it has to apply the ribbon's two fades itself.
    // It did not, and that is why an edge-on stretch still filled a quarter of
    // the frame with flat mint after the main pass had been taught to fade
    // there: the mass in that corner was never the ribbon, it was the ribbon's
    // glow, drawn additively at alpha 1 and answering to neither fade.
    float haloFade = 1.0 - smoothstep(uFogNear, uFogFar, vViewDepth);
    float haloResolved =
      1.0 - smoothstep(uChevronPeriod * 0.6, uChevronPeriod * 2.2, fwidth(vAlong));
    vec3 col = base * falloff * 0.20 * pulse * mix(0.45, 1.0, vDetail)
      * mix(0.10, 1.0, haloFade) * mix(0.08, 1.0, haloResolved);
    outColor = vec4(col, 1.0);
    outNormalDepth = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  // Interior: dim body, chevron ink at full line colour.
  vec3 col = uLineDim * 0.85;
  col = mix(col, base, chevron);
  col = mix(col, base * 1.55 + vec3(0.10), chevronTip);
  // Rails override the chevron so the strip keeps a continuous edge.
  col = mix(col, base * 1.25, rail);
  // Crest lift: the ribbon brightens on the tops of the swell, which is the one
  // cue that tells the player the line is on the water rather than above it.
  col += base * step(0.66, vCrest) * 0.16;
  col = mix(col, uLineDim * 0.30, edgeInk);

  // Alpha: the body is mostly solid so the colours read true against blue
  // water; the interior between chevrons stays translucent so the water bands
  // still show through and the line does not become a painted-on decal.
  // Alpha, rebalanced after a frame audit measured the ribbon at up to 11.5%
  // of frame area in the most saturated colour in the game — brighter and
  // higher-contrast than the player's own boat, which put a navigation aid at
  // the top of the frame's reading order.
  //
  // The structure is what should carry the line: the chevrons and the two
  // rails. The body between them only has to be present enough to connect
  // them, so it drops from 0.30 to 0.11 and the cap comes down from 0.94.
  // Same hue, same brief ("a glowing green racing line"), a third of the ink.
  // The body carries a little more than it used to, now that the halo has been
  // pulled off the top of it: with the spill hollowed out to sit entirely
  // outside the rails, an 0.11 body left the ribbon with nothing between its
  // chevrons at all.
  float alpha = 0.18 + 0.44 * chevron + 0.30 * rail;
  // The contour is the one part that is never translucent. A keyline that fades
  // is not a keyline.
  alpha = max(min(alpha, 0.72), edgeInk * 0.88) * margin;

  // Fade out at extreme range instead of turning the far side of the circuit
  // into a hard green wire across the horizon.
  float fade = 1.0 - smoothstep(uFogNear, uFogFar, vViewDepth);
  alpha *= mix(0.12, 1.0, fade);

  // Fade where the ribbon is edge-on and cannot resolve its own pattern.
  //
  // Distance is not the measure — a nearly edge-on stretch three metres away
  // has a pixel spanning tens of metres along the track, so every chevron
  // inside it integrates to the same value and the ribbon degenerates into a
  // solid mass. Seen from the chase camera looking down the line that mass
  // filled a quarter of the frame with flat mint green. The along-track
  // derivative measures exactly that, and it is the same test the ocean uses
  // to decide when its own bands can no longer be drawn.
  float alongPerPx = fwidth(vAlong);
  float resolved = 1.0 - smoothstep(uChevronPeriod * 0.6, uChevronPeriod * 2.2, alongPerPx);
  alpha *= mix(0.14, 1.0, resolved);

  outColor = vec4(col, alpha);
  // Null normal, full depth: the Sobel edge pass must not trace the ribbon's
  // outline, and it must not lose the waterline it would otherwise find here.
  outNormalDepth = vec4(0.0, 0.0, 0.0, 1.0);
}
`;