import {
  BackSide,
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  GLSL3,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  Quaternion,
  ShaderMaterial,
  Uint32BufferAttribute,
  Vector3,
  type IUniform,
} from 'three';
import { PALETTE } from '../core/Palette.ts';
import {
  CEL_COMMON,
  CEL_FOG,
  CEL_LIGHTING,
  MRT_OUTPUTS,
  celUniformDefaults,
} from '../render/shaderLib.ts';
import { celMatcap, defaultCelRamp } from '../render/materials/proceduralTextures.ts';
import { computeSmoothedNormals } from '../render/OutlineHull.ts';
import { LAYER_OPAQUE } from '../render/layers.ts';
import { sampleOcean, type OceanSample } from '../world/gerstner.ts';
import type { Course } from '../race/Course.ts';
import type { FrameContext } from '../contracts.ts';

/**
 * CORRIDOR BUOYS
 *
 * Small marker floats down both edges of the drivable corridor. There are ~140
 * of them, so they are drawn as three `InstancedMesh` passes — body, ink shell,
 * lamp — rather than 420 individual objects.
 *
 * WHY THERE ARE HAND-WRITTEN INSTANCED MATERIALS IN HERE
 *
 * `CelMaterial` and `OutlineMaterial` are raw GLSL3 `ShaderMaterial`s, and
 * three only injects the instancing plumbing into its *own* shader chunks. A
 * raw material has to apply `instanceMatrix` itself. Rather than reach into the
 * shared materials and add a branch that every non-instanced surface in the
 * game would then carry, this file builds two local variants from the same
 * `shaderLib` chunks. They are the same lighting model, the same MRT contract
 * and the same ink-width maths — only the vertex transform differs.
 *
 * (`normalMatrix` cannot be used for instanced normals: three computes it from
 * the mesh's model-view matrix, which knows nothing about the per-instance
 * rotation. Since the instances are uniformly scaled, `mat3(view * model *
 * instance)` is exact and no inverse-transpose is needed.)
 *
 * WHY THE PER-FRAME UPDATE IS BUDGETED
 *
 * Each buoy needs one `sampleOcean`, which is three fixed-point inversion
 * iterations plus a six-wave evaluation — around 24 wave evaluations. 140 of
 * those every frame is ~3400, which is affordable but pointless: a buoy 800 m
 * away moves less than a pixel per frame. So buoys inside `NEAR_RADIUS` update
 * every frame, buoys out to `FAR_RADIUS` update on a round-robin, and buoys
 * past that keep whatever matrix they last had.
 */

/** Radial segments in the buoy's body of revolution. Odd, so it reads as hand-cut. */
const RADIAL = 9;

/** Buoys inside this distance from the focus update every frame. */
const NEAR_RADIUS = 260;
/** Buoys between NEAR and FAR update on a 1-in-N round robin. */
const FAR_RADIUS = 900;
const FAR_STRIDE = 6;

export interface BuoyFieldOptions {
  /** Maximum number of instances to allocate. */
  maxCount?: number;
  /** Extra metres outboard of the corridor edge to plant the buoys. */
  outboard?: number;
  /** Body accent colour. Defaults to the warning red. */
  accent?: Color;
  /** Lamp colour. */
  lampColor?: Color;
}

const _m = new Matrix4();
const _pos = new Vector3();
const _q = new Quaternion();
const _scale = new Vector3();
const _up = new Vector3(0, 1, 0);
const _normal = new Vector3();
const _sample: OceanSample = { height: 0, nx: 0, ny: 1, nz: 0, jacobian: 1 };

export class BuoyField {
  readonly root = new Group();
  readonly body: InstancedMesh;
  readonly ink: InstancedMesh;
  readonly lamps: InstancedMesh;
  readonly count: number;

  /** Fixed world XZ of each buoy, and its authored variation. */
  private readonly baseX: Float32Array;
  private readonly baseZ: Float32Array;
  private readonly scale: Float32Array;
  private readonly yaw: Float32Array;
  /** Smoothed surface tilt, so a buoy leans into the swell instead of snapping. */
  private readonly tiltX: Float32Array;
  private readonly tiltZ: Float32Array;
  /** Last computed water height, kept so a skipped buoy does not pop. */
  private readonly height: Float32Array;

  private readonly bodyMaterial: ShaderMaterial;
  private readonly inkMaterial: ShaderMaterial;
  private readonly lampMaterial: ShaderMaterial;

  private readonly focus = new Vector3();
  private frame = 0;

  constructor(course: Course, opts: BuoyFieldOptions = {}) {
    const maxCount = opts.maxCount ?? 220;
    const outboard = opts.outboard ?? 1.6;

    const slots = placeBuoys(course, outboard, maxCount);
    this.count = slots.length;

    this.baseX = new Float32Array(this.count);
    this.baseZ = new Float32Array(this.count);
    this.scale = new Float32Array(this.count);
    this.yaw = new Float32Array(this.count);
    this.tiltX = new Float32Array(this.count);
    this.tiltZ = new Float32Array(this.count);
    this.height = new Float32Array(this.count);

    // Deterministic per-buoy variation. A field of identical floats reads as a
    // decal strip; 15% of scale spread and a random yaw is enough to break it,
    // and being deterministic keeps the screenshot harness reproducible.
    let seed = 0x9e3779b9;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    for (let i = 0; i < this.count; i++) {
      this.baseX[i] = slots[i].x;
      this.baseZ[i] = slots[i].z;
      this.scale[i] = 0.86 + rand() * 0.3;
      this.yaw[i] = rand() * Math.PI * 2;
      this.height[i] = 0;
    }

    const geometry = buildBuoyGeometry(opts.accent ?? PALETTE.warn);
    computeSmoothedNormals(geometry);

    this.bodyMaterial = makeInstancedCel({
      color: new Color(1, 1, 1),
      vertexColors: true,
      specStrength: 0.65,
      matcapStrength: 0.22,
      name: 'BuoyBody',
    });

    this.inkMaterial = makeInstancedOutline(2.0, 0.5);

    this.lampMaterial = makeInstancedCel({
      color: (opts.lampColor ?? PALETTE.gateGlow).clone().multiplyScalar(0.35),
      emissive: (opts.lampColor ?? PALETTE.gateGlow).clone(),
      emissiveStrength: 2.4,
      specStrength: 0,
      matcapStrength: 0,
      name: 'BuoyLamp',
    });

    this.body = new InstancedMesh(geometry, this.bodyMaterial, this.count);
    this.body.name = 'Buoys';
    this.body.frustumCulled = false;
    this.body.raycast = () => {};
    this.body.layers.set(LAYER_OPAQUE);

    this.ink = new InstancedMesh(geometry, this.inkMaterial, this.count);
    this.ink.name = 'BuoysInk';
    this.ink.frustumCulled = false;
    this.ink.raycast = () => {};
    this.ink.layers.set(LAYER_OPAQUE);
    // The ink shell must move with the bodies exactly. Pointing it at the same
    // InstancedBufferAttribute means one write and one GPU upload per frame;
    // three's attribute cache makes the second mesh's upload a no-op because the
    // version has not changed since the first.
    this.ink.instanceMatrix = this.body.instanceMatrix;
    this.ink.renderOrder = -1;

    const lampGeo = new IcosahedronGeometry(0.19, 0);
    lampGeo.translate(0, 1.42, 0);
    this.lamps = new InstancedMesh(lampGeo, this.lampMaterial, this.count);
    this.lamps.name = 'BuoyLamps';
    this.lamps.frustumCulled = false;
    this.lamps.raycast = () => {};
    this.lamps.layers.set(LAYER_OPAQUE);
    this.lamps.userData.noOutline = true;
    this.lamps.instanceMatrix = this.body.instanceMatrix;

    this.root.name = 'BuoyField';
    this.root.add(this.ink, this.body, this.lamps);

    // Seed every matrix once so nothing is at the origin on frame zero.
    for (let i = 0; i < this.count; i++) this.writeInstance(i, 0, 1);
    this.body.instanceMatrix.needsUpdate = true;
  }

  /**
   * Point the level-of-detail budget at something — normally the player boat or
   * the camera. Buoys near this position bob at full rate.
   */
  setFocus(position: Vector3): void {
    this.focus.copy(position);
  }

  update(ctx: FrameContext): void {
    this.frame++;
    const near2 = NEAR_RADIUS * NEAR_RADIUS;
    const far2 = FAR_RADIUS * FAR_RADIUS;
    let wrote = false;

    for (let i = 0; i < this.count; i++) {
      const dx = this.baseX[i] - this.focus.x;
      const dz = this.baseZ[i] - this.focus.z;
      const d2 = dx * dx + dz * dz;

      let dt = ctx.dt;
      if (d2 > near2) {
        if (d2 > far2) continue;
        if ((this.frame + i) % FAR_STRIDE !== 0) continue;
        // A round-robin buoy sees FAR_STRIDE frames of water motion at once, so
        // its smoothing has to advance by the same amount or it lags visibly
        // whenever the player drives past.
        dt = ctx.dt * FAR_STRIDE;
      }

      this.writeInstance(i, ctx.elapsed, dt);
      wrote = true;
    }

    if (wrote) this.body.instanceMatrix.needsUpdate = true;
  }

  private writeInstance(i: number, elapsed: number, dt: number): void {
    const x = this.baseX[i];
    const z = this.baseZ[i];
    sampleOcean(x, z, elapsed, _sample);

    // Buoys are ~1.8 m tall and moored, so they follow the swell's *slope* but
    // only partially — 0.62 of the geometric tilt. At 1.0 they looked like
    // weather vanes; well under it they looked welded to the horizon.
    const targetX = _sample.nx * 0.62;
    const targetZ = _sample.nz * 0.62;
    const k = Math.min(1, 5.5 * dt);
    this.tiltX[i] += (targetX - this.tiltX[i]) * k;
    this.tiltZ[i] += (targetZ - this.tiltZ[i]) * k;
    this.height[i] += (_sample.height - this.height[i]) * Math.min(1, 14 * dt);

    _normal.set(this.tiltX[i], 1, this.tiltZ[i]).normalize();
    _q.setFromUnitVectors(_up, _normal);
    // Bake the fixed yaw in after the tilt so the facets face different ways
    // without changing which way the buoy leans.
    _q.multiply(_yawQuat(this.yaw[i]));

    // Sit the collar just at the waterline: the float's widest ring is at y = 0
    // in the source geometry, so drop it a few centimetres to bury the flare.
    _pos.set(x, this.height[i] - 0.06, z);
    _scale.setScalar(this.scale[i]);
    _m.compose(_pos, _q, _scale);
    this.body.setMatrixAt(i, _m);
  }

  dispose(): void {
    this.body.geometry.dispose();
    this.lamps.geometry.dispose();
    this.bodyMaterial.dispose();
    this.inkMaterial.dispose();
    this.lampMaterial.dispose();
    this.body.dispose();
    this.ink.dispose();
    this.lamps.dispose();
  }
}

const _yaw = new Quaternion();
function _yawQuat(angle: number): Quaternion {
  return _yaw.setFromAxisAngle(_up, angle);
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

/**
 * Walk the lap dropping a pair of buoys on the corridor edges.
 *
 * Spacing scales with the corridor width rather than being constant. Where the
 * chicane pinches to 8.5 m the buoys close up to ~22 m apart, which is what
 * tells the player at a glance that the track has narrowed; through the 22 m
 * sweeper they open out to ~55 m so the corner does not read as a fence.
 */
function placeBuoys(
  course: Course,
  outboard: number,
  maxCount: number,
): { x: number; z: number }[] {
  const out: { x: number; z: number }[] = [];
  const p = course.sample(0);

  let distance = 0;
  while (distance < course.length && out.length + 2 <= maxCount) {
    const t = distance / course.length;
    course.sampleInto(t, p);
    const off = p.width + outboard;

    for (const side of [-1, 1]) {
      out.push({
        x: p.position.x + p.normal.x * off * side,
        z: p.position.z + p.normal.z * off * side,
      });
    }

    distance += Math.max(22, Math.min(55, p.width * 2.6));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/**
 * A body of revolution from a fixed profile, with vertex colours baked per ring
 * so the whole buoy — dark underbody, white collar, coloured tower, ink neck —
 * is a single instanced draw against a single material.
 */
function buildBuoyGeometry(accent: Color): BufferGeometry {
  const dark = PALETTE.waterDeep;
  const collar = PALETTE.foam;
  const neck = PALETTE.inkSoft;

  // [radius, y, colour]
  const profile: [number, number, Color][] = [
    [0.0, -0.42, dark],
    [0.58, -0.24, dark],
    [0.88, -0.04, collar],
    [0.9, 0.26, collar],
    [0.5, 0.4, accent],
    [0.36, 0.94, accent],
    [0.32, 1.02, neck],
    [0.24, 1.12, neck],
    [0.16, 1.3, neck],
    [0.0, 1.38, neck],
  ];

  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  for (let r = 0; r < profile.length; r++) {
    const [radius, y, col] = profile[r];
    for (let s = 0; s < RADIAL; s++) {
      const a = (s / RADIAL) * Math.PI * 2;
      positions.push(Math.cos(a) * radius, y, Math.sin(a) * radius);
      colors.push(col.r, col.g, col.b);
    }
  }

  for (let r = 0; r + 1 < profile.length; r++) {
    const base = r * RADIAL;
    const next = (r + 1) * RADIAL;
    for (let s = 0; s < RADIAL; s++) {
      const s1 = (s + 1) % RADIAL;
      indices.push(base + s, next + s, base + s1);
      indices.push(base + s1, next + s, next + s1);
    }
  }

  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geo.setAttribute('color', new Float32BufferAttribute(colors, 3));
  geo.setIndex(new Uint32BufferAttribute(indices, 1));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

// ---------------------------------------------------------------------------
// Instanced materials
// ---------------------------------------------------------------------------

interface InstancedCelOptions {
  color: Color;
  emissive?: Color;
  emissiveStrength?: number;
  specStrength?: number;
  matcapStrength?: number;
  vertexColors?: boolean;
  name?: string;
}

function makeInstancedCel(opts: InstancedCelOptions): ShaderMaterial {
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

function makeInstancedOutline(widthPx: number, taper: number): ShaderMaterial {
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

// `instanceMatrix` is declared for us by three's vertex prefix whenever
// USE_INSTANCING is set, which it is for every InstancedMesh — redeclaring it
// here would be a compile error.
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

  // Uniform per-instance scale, so the upper 3x3 needs no inverse-transpose.
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

  // Identical constant-screen-width maths to OutlineMaterial: world units per
  // pixel at this depth, cancelling the perspective divide.
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

/**
 * Push the viewport-dependent ink uniforms. `OutlineHull`'s registry only knows
 * about materials it created, so the instanced shell has to be fed by hand from
 * wherever the engine already calls `updateOutlineViewport`.
 */
export function updateBuoyOutlineViewport(
  field: BuoyField,
  viewportHeight: number,
  projScaleY: number,
  far: number,
): void {
  const u = (field.ink.material as ShaderMaterial).uniforms;
  u.uViewportHeight.value = viewportHeight;
  u.uProjScaleY.value = projScaleY;
  u.uCameraFar.value = far;
}
