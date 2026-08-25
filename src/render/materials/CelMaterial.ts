import {
  BackSide,
  Color,
  DoubleSide,
  FrontSide,
  GLSL3,
  ShaderMaterial,
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
  rimStrength?: number;
  rimPower?: number;
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
    if (opts.rimPower !== undefined) this.uniforms.uRimPower.value = opts.rimPower;
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
uniform float uViewportHeight;
uniform float uProjScaleY;
uniform float uDistanceTaper;

out float vViewDepth;
out vec3 vViewNormal;

void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vec4 viewPos = viewMatrix * world;
  float depth = max(-viewPos.z, 0.001);
  vViewDepth = depth;

  // Smoothed normal in view space — pushing in view space keeps the line width
  // uniform even on geometry that is scaled non-uniformly.
  vec3 nView = normalize(normalMatrix * outlineNormal);
  vViewNormal = nView;

  // World units per pixel at this depth:
  //   halfHeightAtDepth = depth / projScaleY   (projScaleY = 1/tan(fov/2))
  //   unitsPerPixel     = 2 * halfHeightAtDepth / viewportHeight
  float unitsPerPixel = (2.0 * depth) / (uProjScaleY * uViewportHeight);

  // Taper: at uDistanceTaper = 1 the line is exactly uWidthPx everywhere. Below
  // 1 the line narrows with distance, which reads better in a crowded frame.
  float taper = mix(1.0, clamp(28.0 / depth, 0.35, 1.0), 1.0 - uDistanceTaper);
  float push = uWidthPx * unitsPerPixel * taper;

  // Flatten the z component of the push slightly so silhouettes facing the
  // camera do not balloon towards the viewer and clip through the surface.
  vec3 offset = nView * push;
  offset.z *= 0.35;

  viewPos.xyz += offset;
  gl_Position = projectionMatrix * viewPos;
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
  // Outlines participate in the depth buffer but must not generate a *second*
  // interior line: write the same normal as the surface behind them by flipping
  // the backface normal, and mark them with full depth so Sobel skips them.
  writeNormalDepth(-vViewNormal, vViewDepth);
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
