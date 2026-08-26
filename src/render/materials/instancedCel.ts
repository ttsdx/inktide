import { BackSide, Color, GLSL3, ShaderMaterial, type IUniform } from 'three';
import { PALETTE } from '../../core/Palette.ts';
import {
  CEL_COMMON,
  CEL_FOG,
  CEL_LIGHTING,
  MRT_OUTPUTS,
  celUniformDefaults,
} from '../shaderLib.ts';
import { celMatcap, defaultCelRamp } from './proceduralTextures.ts';

/**
 * Instanced variants of the cel / inverted-hull materials.
 *
 * Three only injects instancing into its own chunks; raw ShaderMaterials have
 * to multiply `instanceMatrix` themselves. Buoys and rogue clutter share this
 * so neither forks a second lighting model.
 */

export interface InstancedCelOptions {
  color: Color;
  emissive?: Color;
  emissiveStrength?: number;
  specStrength?: number;
  matcapStrength?: number;
  vertexColors?: boolean;
  name?: string;
}

export function makeInstancedCel(opts: InstancedCelOptions): ShaderMaterial {
  const uniforms: Record<string, IUniform> = {
    ...celUniformDefaults(),
    uRamp: { value: defaultCelRamp() },
    uMatcap: { value: celMatcap() },
    uBaseColor: { value: opts.color.clone() },
    uEmissive: { value: (opts.emissive ?? new Color(0, 0, 0)).clone() },
    uEmissiveStrength: { value: opts.emissiveStrength ?? 0 },
    uOpacity: { value: 1 },
  };
  if (opts.specStrength !== undefined) uniforms.uSpecStrength.value = opts.specStrength;
  if (opts.matcapStrength !== undefined) uniforms.uMatcapStrength.value = opts.matcapStrength;

  return new ShaderMaterial({
    name: opts.name ?? 'InstancedCel',
    glslVersion: GLSL3,
    vertexColors: opts.vertexColors ?? false,
    uniforms,
    vertexShader: INSTANCED_CEL_VERT,
    fragmentShader: INSTANCED_CEL_FRAG,
  });
}

export function makeInstancedOutline(widthPx: number, taper: number): ShaderMaterial {
  return new ShaderMaterial({
    name: 'InstancedOutline',
    glslVersion: GLSL3,
    side: BackSide,
    uniforms: {
      uInk: { value: PALETTE.ink.clone() },
      uWidthPx: { value: widthPx },
      uViewportHeight: { value: 1080 },
      uProjScaleY: { value: 1.0 },
      uDistanceTaper: { value: taper },
      uCameraFar: { value: 4000 },
      uCameraNear: { value: 0.1 },
      uFogNear: { value: 260 },
      uFogFar: { value: 1500 },
    },
    vertexShader: INSTANCED_OUTLINE_VERT,
    fragmentShader: INSTANCED_OUTLINE_FRAG,
  });
}

export function setInstancedOutlineViewport(
  material: ShaderMaterial,
  viewportHeight: number,
  projScaleY: number,
  far: number,
): void {
  const u = material.uniforms;
  if (u.uViewportHeight) u.uViewportHeight.value = viewportHeight;
  if (u.uProjScaleY) u.uProjScaleY.value = projScaleY;
  if (u.uCameraFar) u.uCameraFar.value = far;
}

const INSTANCED_CEL_VERT = /* glsl */ `
precision highp float;

out vec3 vWorldPos;
out vec3 vWorldNormal;
out vec3 vViewNormal;
out vec3 vColorAttr;
out float vViewDepth;

void main() {
  mat4 model = modelMatrix * instanceMatrix;
  vec4 world = model * vec4(position, 1.0);
  vWorldPos = world.xyz;
  mat3 rot = mat3(model);
  vWorldNormal = normalize(rot * normal);
  vViewNormal = normalize(mat3(viewMatrix) * vWorldNormal);
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

const INSTANCED_CEL_FRAG = /* glsl */ `
precision highp float;

${MRT_OUTPUTS}
${CEL_COMMON}
${CEL_LIGHTING}
${CEL_FOG}

uniform vec3 uEmissive;
uniform float uEmissiveStrength;
uniform float uOpacity;

in vec3 vWorldPos;
in vec3 vWorldNormal;
in vec3 vViewNormal;
in vec3 vColorAttr;
in float vViewDepth;

void main() {
  vec3 V = normalize(cameraPosition - vWorldPos);
  vec3 N = normalize(vWorldNormal);
  if (!gl_FrontFacing) N = -N;
  CelInput s;
  s.normal = N;
  s.viewDir = V;
  s.baseColor = uBaseColor * vColorAttr;
  s.ao = 1.0;
  s.shadow = 1.0;
  vec3 col = celShade(s);
  col += uEmissive * uEmissiveStrength;
  col = applyCelHaze(col, vViewDepth, -V);
  outColor = vec4(col, uOpacity);
  writeNormalDepth(vViewNormal, vViewDepth);
}
`;

const INSTANCED_OUTLINE_VERT = /* glsl */ `
precision highp float;

in vec3 outlineNormal;

uniform float uWidthPx;
uniform float uViewportHeight;
uniform float uProjScaleY;
uniform float uDistanceTaper;

out float vViewDepth;
out vec3 vViewNormal;

void main() {
  mat4 model = modelMatrix * instanceMatrix;
  vec4 viewPos = viewMatrix * model * vec4(position, 1.0);
  float depth = max(-viewPos.z, 0.001);
  vViewDepth = depth;
  vec3 nView = normalize(mat3(viewMatrix) * mat3(model) * outlineNormal);
  vViewNormal = nView;
  float unitsPerPixel = (2.0 * depth) / (uProjScaleY * uViewportHeight);
  float taper = mix(1.0, clamp(28.0 / depth, 0.35, 1.0), 1.0 - uDistanceTaper);
  vec3 offset = nView * (uWidthPx * unitsPerPixel * taper);
  offset.z *= 0.35;
  viewPos.xyz += offset;
  gl_Position = projectionMatrix * viewPos;
}
`;

const INSTANCED_OUTLINE_FRAG = /* glsl */ `
precision highp float;

${MRT_OUTPUTS}
${CEL_COMMON}
${CEL_FOG}

uniform vec3 uInk;

in float vViewDepth;
in vec3 vViewNormal;

void main() {
  vec3 col = applyCelHaze(uInk, vViewDepth, vec3(0.0, 0.2, -1.0));
  outColor = vec4(col, 1.0);
  writeNormalDepth(-vViewNormal, vViewDepth);
}
`;
