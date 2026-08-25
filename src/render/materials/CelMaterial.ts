import {
  BackSide,
  Color,
  DoubleSide,
  FrontSide,
  GLSL3,
  ShaderMaterial,
  Vector2,
  type IUniform,
  type Texture,
} from 'three';
import { PALETTE } from '../../core/Palette.ts';
import {
  CEL_COMMON,
  CEL_FOG,
  CEL_LIGHTING,
  MRT_OUTPUTS,
  celUniformDefaults,
  glslVec3,
} from '../shaderLib.ts';
import { celMatcap, defaultCelRamp, makeCelRamp } from './proceduralTextures.ts';

export interface CelMaterialOptions {
  color?: Color;
  /** Per-material ramp; omit to share the global 4-band ramp. */
  ramp?: Texture;
  /** Tint the ramp to this colour instead of using the neutral shared one. */
  rampTint?: Color;
  rimColor?: Color;
  /** Cool sky rim on the shadow side. */
  rimStrength?: number;
  /** Warm key rim on the sun side. */
  keyRimStrength?: number;
  rimPower?: number;
  /** Threshold on the fresnel term; larger = thinner rim. */
  rimWidth?: number;
  specStrength?: number;
  specSize?: number;
  matcapStrength?: number;
  ambientWrap?: number;
  /** Emissive lift, added flat after shading. Used for glowing gates/lines. */
  emissive?: Color;
  emissiveStrength?: number;
  transparent?: boolean;
  opacity?: number;
  side?: typeof FrontSide | typeof BackSide | typeof DoubleSide;
  /** Vertex colours multiply the base colour (used for baked AO / paint stripes). */
  vertexColors?: boolean;
  /**
   * Surface id written to the edge buffer. Distinct ids get an interior line
   * between them; matching ids stay continuous.
   */
  fog?: boolean;
  name?: string;
}

/**
 * The workhorse material: ramp-banded diffuse, hard specular shapes, matcap
 * fake reflection, fresnel rim, stylised haze, and an MRT normal/depth write.
 */
export class CelMaterial extends ShaderMaterial {
  declare uniforms: Record<string, IUniform>;

  constructor(opts: CelMaterialOptions = {}) {
    const base = opts.color ?? PALETTE.waterMid.clone();
    const ramp = opts.ramp ?? (opts.rampTint ? makeCelRamp(opts.rampTint) : defaultCelRamp());

    super({
      name: opts.name ?? 'CelMaterial',
      glslVersion: GLSL3,
      transparent: opts.transparent ?? false,
      side: opts.side ?? FrontSide,
      vertexColors: opts.vertexColors ?? false,
      uniforms: {
        ...celUniformDefaults(),
        uRamp: { value: ramp },
        uMatcap: { value: celMatcap() },
        uBaseColor: { value: base.clone() },
        uEmissive: { value: (opts.emissive ?? new Color(0, 0, 0)).clone() },
        uEmissiveStrength: { value: opts.emissiveStrength ?? 0 },
        uOpacity: { value: opts.opacity ?? 1 },
        uTime: { value: 0 },
        uUseFog: { value: opts.fog === false ? 0 : 1 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
    });

    if (opts.rimColor) (this.uniforms.uRimColor.value as Color).copy(opts.rimColor);
    if (opts.rimStrength !== undefined) this.uniforms.uRimStrength.value = opts.rimStrength;
    if (opts.keyRimStrength !== undefined)
      this.uniforms.uKeyRimStrength.value = opts.keyRimStrength;
    if (opts.rimPower !== undefined) this.uniforms.uRimPower.value = opts.rimPower;
    if (opts.rimWidth !== undefined) this.uniforms.uRimWidth.value = opts.rimWidth;
    if (opts.specStrength !== undefined) this.uniforms.uSpecStrength.value = opts.specStrength;
    if (opts.specSize !== undefined) this.uniforms.uSpecSize.value = opts.specSize;
    if (opts.matcapStrength !== undefined) this.uniforms.uMatcapStrength.value = opts.matcapStrength;
    if (opts.ambientWrap !== undefined) this.uniforms.uAmbientWrap.value = opts.ambientWrap;
  }

  get color(): Color {
    return this.uniforms.uBaseColor.value as Color;
  }

  setColor(c: Color): this {
    (this.uniforms.uBaseColor.value as Color).copy(c);
    return this;
  }
}

const VERT = /* glsl */ `
precision highp float;

out vec3 vWorldPos;
out vec3 vWorldNormal;
out vec3 vViewNormal;
out vec3 vColorAttr;
out float vViewDepth;

void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorldPos = world.xyz;
  vWorldNormal = normalize(mat3(modelMatrix) * normal);
  vViewNormal = normalize(normalMatrix * normal);

  #ifdef USE_COLOR
    vColorAttr = color;
  #else
    vColorAttr = vec3(1.0);
  #endif

  vec4 viewPos = viewMatrix * world;
  vViewDepth = -viewPos.z;
  gl_Position = projectionMatrix * viewPos;
}
`;

const FRAG = /* glsl */ `
precision highp float;

${MRT_OUTPUTS}
${CEL_COMMON}
${CEL_LIGHTING}
${CEL_FOG}

uniform vec3 uEmissive;
uniform float uEmissiveStrength;
uniform float uOpacity;
uniform float uTime;
uniform float uUseFog;

in vec3 vWorldPos;
in vec3 vWorldNormal;
in vec3 vViewNormal;
in vec3 vColorAttr;
in float vViewDepth;

void main() {
  vec3 V = normalize(cameraPosition - vWorldPos);
  vec3 N = normalize(vWorldNormal);
  // Two-sided surfaces (sails, flags, thin panels) flip towards the viewer.
  if (!gl_FrontFacing) N = -N;

  CelInput s;
  s.normal = N;
  s.viewDir = V;
  s.baseColor = uBaseColor * vColorAttr;
  s.ao = 1.0;
  s.shadow = 1.0;

  vec3 col = celShade(s);
  col += uEmissive * uEmissiveStrength;

  if (uUseFog > 0.5) {
    col = applyCelHaze(col, vViewDepth, -V);
  }

  outColor = vec4(col, uOpacity);
  writeNormalDepth(vViewNormal, vViewDepth);
}
`;

// ---------------------------------------------------------------------------
// Inverted-hull outline material
// ---------------------------------------------------------------------------

export interface OutlineMaterialOptions {
  color?: Color;
  /** Line half-width in *pixels* at a 1080p-equivalent framebuffer height. */
  widthPx?: number;
  /** Extra push applied at grazing angles to stop the line collapsing. */
  name?: string;
}

/**
 * Inverted-hull ink outline.
 *
 * The push distance is computed so the resulting line is a constant number of
 * **pixels** wide regardless of distance: we scale the offset by the view-space
 * depth and by the vertical field of view, exactly cancelling the perspective
 * divide. Without this the lines are fat on a nearby hull and gone at 200 m.
 *
 * The vertex normal used for the push is the *smoothed* normal supplied in the
 * `outlineNormal` attribute (see `buildOutline`), because pushing along a hard
 * shading normal splits the hull open at every sharp edge.
 */
export class OutlineMaterial extends ShaderMaterial {
  declare uniforms: Record<string, IUniform>;

  constructor(opts: OutlineMaterialOptions = {}) {
    super({
      name: opts.name ?? 'OutlineMaterial',
      glslVersion: GLSL3,
      side: BackSide,
      // Ink lines must never be occluded-out by their own hull's z-fighting.
      depthWrite: true,
      transparent: false,
      uniforms: {
        uInk: { value: (opts.color ?? PALETTE.ink).clone() },
        uWidthPx: { value: opts.widthPx ?? 2.4 },
        uViewport: { value: new Vector2(1920, 1080) },
        uViewportHeight: { value: 1080 },
        uProjScaleY: { value: 1.0 },
        uCameraFar: { value: 4000 },
        uCameraNear: { value: 0.1 },
        uFogNear: { value: 260 },
        uFogFar: { value: 1500 },
        // Lines thin out with distance a little so a far-off pack of boats does
        // not turn into a black smear; 1.0 = perfectly constant screen width.
        uDistanceTaper: { value: 0.62 },
      },
      vertexShader: OUTLINE_VERT,
      fragmentShader: OUTLINE_FRAG,
    });
  }
}

const OUTLINE_VERT = /* glsl */ `
precision highp float;

in vec3 outlineNormal;

uniform float uWidthPx;
uniform vec2 uViewport;
uniform float uViewportHeight;
uniform float uDistanceTaper;

out float vViewDepth;
out vec3 vViewNormal;

void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vec4 viewPos = viewMatrix * world;
  float depth = max(-viewPos.z, 0.001);
  vViewDepth = depth;

  vec3 nView = normalize(normalMatrix * outlineNormal);
  vViewNormal = nView;

  vec4 clip = projectionMatrix * viewPos;

  // THE PUSH IS DONE IN CLIP SPACE, NOT VIEW SPACE.
  //
  // Pushing along the view-space normal and scaling by depth gets the *depth*
  // half of the problem right, but it still loses width wherever the normal
  // tilts away from the screen plane: at a box's silhouette edge the smoothed
  // normal points diagonally, so only ~60% of the push lands laterally and the
  // line comes out thin. Projecting the normal into clip space and normalising
  // it there gives a displacement that is purely lateral by construction, so
  // the line is exactly uWidthPx wide at every silhouette on every shape.
  vec3 clipNormal = normalize((projectionMatrix * vec4(nView, 0.0)).xyz);
  vec2 dir = clipNormal.xy;
  float len = length(dir);
  // Vertices whose normal points almost straight at or away from the camera are
  // not on a silhouette; nudging them in an arbitrary direction would make the
  // shell poke through the surface, so they are pushed by an amount that falls
  // off with how face-on they are.
  dir = len > 1e-5 ? dir / len : vec2(0.0);
  float facing = smoothstep(0.0, 0.35, len);

  // Taper: at uDistanceTaper = 1 the line is exactly uWidthPx everywhere. Below
  // 1 the line narrows with distance, which stops a distant pack of boats
  // turning into a black smear.
  float taper = mix(1.0, clamp(30.0 / depth, 0.30, 1.0), 1.0 - uDistanceTaper);

  // uWidthPx is quoted against a 1080-tall FRAMEBUFFER, not against the
  // framebuffer actually in use. Without this scale the ink is a fixed number of
  // device pixels, so the same width setting draws a 2.6 px line at the low
  // preset and a 1.3 px line at ultra — measured, on the distance rig, at 1.23
  // device pixels where the setting said 2.6. Turning the quality up made the
  // ink visibly finer, which is not a quality setting, it is a different art
  // style. Scaling by the framebuffer height fixes the line's share of the
  // SCREEN rather than its share of the pixel grid, which is what "constant
  // screen-space width" has to mean if it is to mean anything.
  // Clamped at the bottom because proportionality stops being the right answer
  // once the line drops below about two pixels: a 620-tall framebuffer would get
  // a 1.5 px line and a small window would get less than one, at which point the
  // ink is an antialiasing artefact rather than a drawn contour and the whole
  // look collapses. Below the clamp the ink holds its absolute weight and the
  // frame is simply drawn a little heavier, which is the failure mode to prefer.
  float resScale = clamp(uViewportHeight / 1080.0, 0.8, 3.0);
  vec2 ndcPerPixel = 2.0 / uViewport;
  clip.xy += dir * (uWidthPx * resScale * taper * facing) * ndcPerPixel * clip.w;

  gl_Position = clip;
}
`;

const OUTLINE_FRAG = /* glsl */ `
precision highp float;

${MRT_OUTPUTS}
${CEL_COMMON}
${CEL_FOG}

uniform vec3 uInk;

in float vViewDepth;
in vec3 vViewNormal;

void main() {
  // Ink is tinted towards the haze with distance so far outlines recede rather
  // than punching black holes in the sky.
  vec3 col = applyCelHaze(uInk, vViewDepth, vec3(0.0, 0.2, -1.0));
  outColor = vec4(col, 1.0);
  // Flag the ink so the Sobel pass cannot draw a second line against it — see
  // writeInkNormalDepth. Writing the negated backface normal here (the previous
  // approach) made the ink band a normal discontinuity in its own right.
  writeInkNormalDepth(vViewDepth);
}
`;

/** Emissive, unlit, flat-colour material for glowing UI-ish geometry. */
export function makeGlowMaterial(color: Color, strength = 1.4, opacity = 1): CelMaterial {
  return new CelMaterial({
    color: color.clone().multiplyScalar(0.4),
    emissive: color,
    emissiveStrength: strength,
    rimStrength: 0.9,
    rimColor: color,
    specStrength: 0,
    matcapStrength: 0,
    opacity,
    transparent: opacity < 1,
  });
}

export { BackSide, FrontSide, DoubleSide };
