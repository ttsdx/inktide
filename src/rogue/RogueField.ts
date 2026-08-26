import {
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  Matrix4,
  Quaternion,
  ShaderMaterial,
  Uint32BufferAttribute,
  Vector3,
} from 'three';
import { PALETTE } from '../core/Palette.ts';
import { computeSmoothedNormals } from '../render/OutlineHull.ts';
import { LAYER_OPAQUE, LAYER_OVERLAY } from '../render/layers.ts';
import {
  makeInstancedCel,
  makeInstancedOutline,
  setInstancedOutlineViewport,
} from '../render/materials/instancedCel.ts';
import { detailAt, sampleOcean, type OceanSample } from '../world/gerstner.ts';
import type { FrameContext } from '../contracts.ts';

/**
 * Seeded, instanced clutter for The Wash.
 *
 * Four obstacle silhouettes and two pickup silhouettes, all lofted in code
 * and drawn through the shared instanced cel + inverted-hull path. Far props
 * drop ink and skip the Gerstner solve — the same budget the corridor buoys
 * already use.
 */

export type HazardKind = 'rock' | 'post' | 'reef' | 'wreck';
export type PickupKind = 'orb' | 'boost';

export interface HazardHit {
  x: number;
  z: number;
  radius: number;
  kind: HazardKind;
}

const KIND_ROCK = 0;
const KIND_POST = 1;
const KIND_REEF = 2;
const KIND_WRECK = 3;
const KIND_NAMES: HazardKind[] = ['rock', 'post', 'reef', 'wreck'];

const MAX_HAZARD = 96;
const MAX_ORB = 40;
const MAX_BOOST = 12;
const MAX_EDGE = 72;

const NEAR_RADIUS = 140;
const FAR_STRIDE = 8;
const INK_RADIUS = 90;

const _m = new Matrix4();
const _pos = new Vector3();
const _q = new Quaternion();
const _scale = new Vector3();
const _up = new Vector3(0, 1, 0);
const _sample: OceanSample = { height: 0, nx: 0, ny: 1, nz: 0, jacobian: 1 };

interface Pool {
  body: InstancedMesh;
  ink: InstancedMesh;
  count: number;
  x: Float32Array;
  z: Float32Array;
  y: Float32Array;
  scale: Float32Array;
  yaw: Float32Array;
  radius: Float32Array;
  live: Uint8Array;
  kind?: Int8Array;
}

export class RogueField {
  readonly root = new Group();

  private readonly rocks: Pool;
  private readonly posts: Pool;
  private readonly reefs: Pool;
  private readonly wrecks: Pool;
  private readonly orbs: Pool;
  private readonly boosts: Pool;
  private readonly edges: Pool;
  private readonly pools: Pool[];
  private readonly inkMaterials: ShaderMaterial[] = [];

  private originX = 0;
  private originZ = 0;
  private halfWidth = 32;
  private length = 520;
  private readonly eye = new Vector3();
  private fadeStart = 150;
  private fadeEnd = 900;
  private frame = 0;
  private elapsed = 0;

  constructor() {
    this.rocks = this.makePool('Rocks', buildRockGeometry(), MAX_HAZARD, PALETTE.inkSoft, 2.1);
    this.posts = this.makePool('Posts', buildPostGeometry(), MAX_HAZARD, PALETTE.waterDeep, 1.8);
    this.reefs = this.makePool('Reefs', buildReefGeometry(), MAX_HAZARD, PALETTE.waterMid, 1.7);
    this.wrecks = this.makePool('Wrecks', buildWreckGeometry(), MAX_HAZARD, PALETTE.warn, 2.0);
    this.orbs = this.makePool(
      'Orbs',
      buildOrbGeometry(),
      MAX_ORB,
      PALETTE.foam,
      1.6,
      PALETTE.racer[3],
      1.8,
      LAYER_OVERLAY,
    );
    this.boosts = this.makePool(
      'Boosts',
      buildBoostGeometry(),
      MAX_BOOST,
      PALETTE.foam,
      1.6,
      PALETTE.racingLine,
      2.2,
      LAYER_OVERLAY,
    );
    this.edges = this.makePool('WashEdge', buildEdgeGeometry(), MAX_EDGE, PALETTE.foam, 1.6);
    this.pools = [this.rocks, this.posts, this.reefs, this.wrecks, this.orbs, this.boosts, this.edges];
    this.root.name = 'RogueField';
    this.root.visible = false;
  }

  buildStage(
    seed: number,
    stage: number,
    originX: number,
    originZ: number,
    length: number,
    halfWidth: number,
  ): void {
    this.originX = originX;
    this.originZ = originZ;
    this.length = length;
    this.halfWidth = halfWidth;
    for (const p of this.pools) {
      p.count = 0;
      p.live.fill(0);
    }

    const rng = mulberry(seed ^ ((stage + 1) * 0x9e3779b9));
    placeHazards(this, rng, stage, originX, originZ, length, halfWidth);
    placePickups(this, rng, stage, originX, originZ, length, halfWidth);
    placeEdges(this, originX, originZ, length, halfWidth);
    this.root.visible = true;
  }

  hide(): void {
    this.root.visible = false;
    for (const p of this.pools) {
      p.count = 0;
      p.body.count = 0;
      p.ink.count = 0;
    }
  }

  setViewer(eye: Vector3, fadeStart: number, fadeEnd: number): void {
    this.eye.copy(eye);
    this.fadeStart = fadeStart;
    this.fadeEnd = fadeEnd;
  }

  setOutlineViewport(viewportHeight: number, projScaleY: number, far: number): void {
    for (const m of this.inkMaterials) setInstancedOutlineViewport(m, viewportHeight, projScaleY, far);
  }

  update(ctx: FrameContext): void {
    if (!this.root.visible) return;
    this.frame++;
    this.elapsed = ctx.elapsed;
    const near2 = NEAR_RADIUS * NEAR_RADIUS;
    const ink2 = INK_RADIUS * INK_RADIUS;
    const hide2 = (this.fadeEnd + 60) * (this.fadeEnd + 60);

    for (const pool of this.pools) {
      let written = 0;
      let inkWritten = 0;
      for (let i = 0; i < pool.count; i++) {
        if (!pool.live[i]) continue;
        const dx = pool.x[i] - this.eye.x;
        const dz = pool.z[i] - this.eye.z;
        const d2 = dx * dx + dz * dz;
        if (d2 > hide2) continue;

        let sample = true;
        let dt = ctx.dt;
        if (d2 > near2) {
          if ((this.frame + i) % FAR_STRIDE !== 0) sample = false;
          else dt = ctx.dt * FAR_STRIDE;
        }
        if (sample) {
          const dist = Math.sqrt(d2);
          const detail = d2 > near2 ? 0 : detailAt(dist, this.fadeStart, this.fadeEnd);
          sampleOcean(pool.x[i], pool.z[i], ctx.elapsed, _sample, detail);
          pool.y[i] += (_sample.height - pool.y[i]) * Math.min(1, 12 * dt);
        }

        let y = pool.y[i];
        let yaw = pool.yaw[i];
        if (pool === this.orbs || pool === this.boosts) {
          y += 0.85 + Math.sin(ctx.elapsed * 3.2 + i * 1.7) * 0.16;
          yaw += ctx.elapsed * (pool === this.orbs ? 1.4 : 2.1);
        }

        _pos.set(pool.x[i], y, pool.z[i]);
        _q.setFromAxisAngle(_up, yaw);
        _scale.setScalar(pool.scale[i]);
        if (pool === this.reefs) _scale.set(pool.scale[i] * 1.6, pool.scale[i] * 0.55, pool.scale[i] * 1.1);
        _m.compose(_pos, _q, _scale);
        pool.body.setMatrixAt(written, _m);
        written++;
        if (d2 <= ink2) {
          pool.ink.setMatrixAt(inkWritten, _m);
          inkWritten++;
        }
      }
      pool.body.count = written;
      pool.ink.count = inkWritten;
      if (written > 0) pool.body.instanceMatrix.needsUpdate = true;
      if (inkWritten > 0) pool.ink.instanceMatrix.needsUpdate = true;
    }
  }

  /** Hazards whose circles overlap a query disc. Used by Game for contacts. */
  queryHazards(x: number, z: number, extra = 4): HazardHit[] {
    const out: HazardHit[] = [];
    const groups: Array<[Pool, HazardKind]> = [
      [this.rocks, 'rock'],
      [this.posts, 'post'],
      [this.reefs, 'reef'],
      [this.wrecks, 'wreck'],
    ];
    for (const [pool, kind] of groups) {
      for (let i = 0; i < pool.count; i++) {
        if (!pool.live[i]) continue;
        const dx = pool.x[i] - x;
        const dz = pool.z[i] - z;
        const reach = pool.radius[i] + extra;
        if (dx * dx + dz * dz <= reach * reach) {
          out.push({ x: pool.x[i], z: pool.z[i], radius: pool.radius[i], kind });
        }
      }
    }
    return out;
  }

  /**
   * Magnet-pull then collect. Returns the kinds gathered this frame.
   * Collected pickups are flagged dead and dropped from the instance list.
   */
  collectPickups(x: number, z: number, magnet: number): PickupKind[] {
    const got: PickupKind[] = [];
    this.gather(this.orbs, 'orb', x, z, magnet, 2.15, got);
    this.gather(this.boosts, 'boost', x, z, magnet, 2.3, got);
    return got;
  }

  private gather(
    pool: Pool,
    kind: PickupKind,
    x: number,
    z: number,
    magnet: number,
    touch: number,
    got: PickupKind[],
  ): void {
    const mag = Math.max(0, magnet);
    for (let i = 0; i < pool.count; i++) {
      if (!pool.live[i]) continue;
      let dx = pool.x[i] - x;
      let dz = pool.z[i] - z;
      let d2 = dx * dx + dz * dz;
      if (mag > 0 && d2 < mag * mag && d2 > 1e-4) {
        const d = Math.sqrt(d2);
        const pull = Math.min(1, ((mag - d) / mag) * 0.22);
        pool.x[i] -= dx * pull;
        pool.z[i] -= dz * pull;
        dx = pool.x[i] - x;
        dz = pool.z[i] - z;
        d2 = dx * dx + dz * dz;
      }
      if (d2 <= touch * touch) {
        pool.live[i] = 0;
        got.push(kind);
      }
    }
  }

  dispose(): void {
    for (const p of this.pools) {
      p.body.geometry.dispose();
      (p.body.material as ShaderMaterial).dispose();
      (p.ink.material as ShaderMaterial).dispose();
      p.body.dispose();
      p.ink.dispose();
    }
  }

  // --- allocation helpers used by the placers ------------------------------

  pushHazard(kind: number, x: number, z: number, scale: number, yaw: number, radius: number): void {
    const pool =
      kind === KIND_POST
        ? this.posts
        : kind === KIND_REEF
          ? this.reefs
          : kind === KIND_WRECK
            ? this.wrecks
            : this.rocks;
    const i = pool.count;
    if (i >= pool.x.length) return;
    pool.x[i] = x;
    pool.z[i] = z;
    pool.y[i] = 0;
    pool.scale[i] = scale;
    pool.yaw[i] = yaw;
    pool.radius[i] = radius * scale;
    pool.live[i] = 1;
    pool.count = i + 1;
  }

  pushPickup(kind: PickupKind, x: number, z: number, scale: number): void {
    const pool = kind === 'boost' ? this.boosts : this.orbs;
    const i = pool.count;
    if (i >= pool.x.length) return;
    pool.x[i] = x;
    pool.z[i] = z;
    pool.y[i] = 0;
    pool.scale[i] = scale;
    pool.yaw[i] = 0;
    pool.radius[i] = 0.9;
    pool.live[i] = 1;
    pool.count = i + 1;
  }

  pushEdge(x: number, z: number, scale: number, yaw: number): void {
    const pool = this.edges;
    const i = pool.count;
    if (i >= pool.x.length) return;
    pool.x[i] = x;
    pool.z[i] = z;
    pool.y[i] = 0;
    pool.scale[i] = scale;
    pool.yaw[i] = yaw;
    pool.radius[i] = 0.4;
    pool.live[i] = 1;
    pool.count = i + 1;
  }

  private makePool(
    name: string,
    geometry: BufferGeometry,
    max: number,
    color: Color,
    inkWidth: number,
    emissive?: Color,
    emissiveStrength = 0,
    layer = LAYER_OPAQUE,
  ): Pool {
    computeSmoothedNormals(geometry);
    const bodyMat = makeInstancedCel({
      color: new Color(1, 1, 1),
      vertexColors: true,
      specStrength: emissive ? 0.15 : 0.55,
      matcapStrength: emissive ? 0.08 : 0.2,
      emissive,
      emissiveStrength,
      name: `${name}Cel`,
    });
    if (!emissive) bodyMat.uniforms.uBaseColor.value = color.clone();
    const inkMat = makeInstancedOutline(inkWidth, 0.55);
    this.inkMaterials.push(inkMat);

    const body = new InstancedMesh(geometry, bodyMat, max);
    body.name = name;
    body.frustumCulled = false;
    body.raycast = () => {};
    body.layers.set(layer);
    body.count = 0;

    const ink = new InstancedMesh(geometry, inkMat, max);
    ink.name = `${name}Ink`;
    ink.frustumCulled = false;
    ink.raycast = () => {};
    ink.layers.set(layer);
    ink.renderOrder = -1;
    ink.count = 0;

    this.root.add(ink, body);

    return {
      body,
      ink,
      count: 0,
      x: new Float32Array(max),
      z: new Float32Array(max),
      y: new Float32Array(max),
      scale: new Float32Array(max),
      yaw: new Float32Array(max),
      radius: new Float32Array(max),
      live: new Uint8Array(max),
    };
  }
}

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Lane weave. Stage 1 blocks one of three lanes; stage 3 blocks two and
 * jogs the open lane so a competent driver still has a line, just not a
 * straight one.
 */
function placeHazards(
  field: RogueField,
  rng: () => number,
  stage: number,
  ox: number,
  oz: number,
  length: number,
  half: number,
): void {
  const lanes = 3;
  const laneX = (i: number) => ((i - 1) / 1) * half * 0.55;
  const rowGap = [38, 24, 15][stage] ?? 15;
  const blockCount = stage === 0 ? 1 : 2;
  // Stage 1 teaches: keep the centre lane open and weave gently. Stage 3
  // jogs the hole so a straight blast is no longer a line.
  let open = stage === 0 ? 1 : Math.floor(rng() * lanes);
  let z = oz + (stage === 0 ? 90 : 55);
  const end = oz + length - 28;
  let row = 0;
  while (z < end) {
    if (rng() < (stage === 0 ? 0.16 : 0.38 + stage * 0.1)) {
      open = Math.max(0, Math.min(lanes - 1, open + (rng() < 0.5 ? -1 : 1)));
    }
    const blocked: number[] = [];
    for (let i = 0; i < lanes; i++) if (i !== open) blocked.push(i);
    while (blocked.length > blockCount) blocked.splice(Math.floor(rng() * blocked.length), 1);
    // Stage 1 sometimes leaves a row empty so the first minute teaches the
    // corridor rather than the clutter.
    const skipRow = stage === 0 && rng() < 0.42;
    if (!skipRow) {
      for (const li of blocked) {
        const kind = pickKind(rng, stage);
        const jitter = (rng() - 0.5) * 4.5;
        const x = ox + laneX(li) + jitter;
        const scale =
          kind === KIND_REEF ? 1.1 + rng() * 0.5 : kind === KIND_POST ? 0.9 + rng() * 0.25 : 0.85 + rng() * 0.45;
        const radius = kind === KIND_REEF ? 2.4 : kind === KIND_POST ? 0.85 : kind === KIND_WRECK ? 1.35 : 1.7;
        field.pushHazard(kind, x, z + (rng() - 0.5) * 3, scale, rng() * Math.PI * 2, radius);
      }
    }
    z += rowGap * (0.82 + rng() * 0.4);
    row++;
    void row;
  }
}

function pickKind(rng: () => number, stage: number): number {
  const r = rng();
  if (stage === 0) {
    if (r < 0.4) return KIND_ROCK;
    if (r < 0.7) return KIND_WRECK;
    if (r < 0.88) return KIND_POST;
    return KIND_REEF;
  }
  if (stage === 1) {
    if (r < 0.32) return KIND_ROCK;
    if (r < 0.52) return KIND_POST;
    if (r < 0.78) return KIND_REEF;
    return KIND_WRECK;
  }
  if (r < 0.28) return KIND_ROCK;
  if (r < 0.55) return KIND_POST;
  if (r < 0.82) return KIND_REEF;
  return KIND_WRECK;
}

function placePickups(
  field: RogueField,
  rng: () => number,
  stage: number,
  ox: number,
  oz: number,
  length: number,
  half: number,
): void {
  const orbGap = [22, 42, 64][stage] ?? 64;
  const boostOdds = [0.22, 0.14, 0.08][stage] ?? 0.08;
  let z = oz + 40;
  const end = oz + length - 20;
  while (z < end) {
    // Stage 1 hangs orbs on the open centre line so a first run can actually
    // bank a shop visit. Later stages scatter them into the clutter.
    const x =
      stage === 0 ? ox + (rng() - 0.5) * 6 : ox + (rng() - 0.5) * half * 1.15;
    if (Math.abs(x - ox) < half * 0.92) {
      if (rng() < boostOdds) field.pushPickup('boost', x, z, 0.85 + rng() * 0.2);
      else field.pushPickup('orb', x, z, 0.75 + rng() * 0.2);
    }
    z += orbGap * (0.7 + rng() * 0.7);
  }
}

function placeEdges(
  field: RogueField,
  ox: number,
  oz: number,
  length: number,
  half: number,
): void {
  const step = 18;
  for (let z = oz + 8; z < oz + length + 10; z += step) {
    field.pushEdge(ox - half - 1.4, z, 0.78, 0);
    field.pushEdge(ox + half + 1.4, z, 0.78, 0);
  }
}

// ---------------------------------------------------------------------------
// Procedural silhouettes — palette vertex colours, no texture files
// ---------------------------------------------------------------------------

function revolution(
  profile: Array<[number, number, Color]>,
  radial: number,
): BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  for (let r = 0; r < profile.length; r++) {
    const [radius, y, col] = profile[r];
    for (let s = 0; s < radial; s++) {
      const a = (s / radial) * Math.PI * 2;
      positions.push(Math.cos(a) * radius, y, Math.sin(a) * radius);
      colors.push(col.r, col.g, col.b);
    }
  }
  for (let r = 0; r + 1 < profile.length; r++) {
    const base = r * radial;
    const next = (r + 1) * radial;
    for (let s = 0; s < radial; s++) {
      const s1 = (s + 1) % radial;
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

function buildRockGeometry(): BufferGeometry {
  const ink = PALETTE.inkSoft;
  const deep = PALETTE.waterDeep;
  const mid = PALETTE.waterMid;
  // Faceted, odd radial count so it reads hand-cut rather than lathed.
  return revolution(
    [
      [0.0, -0.9, deep],
      [0.55, -0.72, deep],
      [1.15, -0.28, ink],
      [1.35, 0.08, mid],
      [0.95, 0.62, ink],
      [0.48, 1.15, deep],
      [0.0, 1.45, ink],
    ],
    7,
  );
}

function buildPostGeometry(): BufferGeometry {
  const wood = PALETTE.inkSoft;
  const foam = PALETTE.foam;
  const deep = PALETTE.waterDeep;
  return revolution(
    [
      [0.0, -1.1, deep],
      [0.38, -0.9, deep],
      [0.42, -0.08, wood],
      [0.58, 0.04, foam],
      [0.4, 0.18, wood],
      [0.34, 2.05, wood],
      [0.22, 2.35, foam],
      [0.0, 2.42, foam],
    ],
    6,
  );
}

function buildReefGeometry(): BufferGeometry {
  const deep = PALETTE.waterDeep;
  const mid = PALETTE.waterMid;
  const crest = PALETTE.waterCrest;
  return revolution(
    [
      [0.0, -0.55, deep],
      [1.6, -0.22, deep],
      [2.1, -0.02, mid],
      [1.7, 0.22, crest],
      [0.6, 0.38, mid],
      [0.0, 0.42, deep],
    ],
    8,
  );
}

function buildWreckGeometry(): BufferGeometry {
  const warn = PALETTE.warn;
  const foam = PALETTE.foam;
  const deep = PALETTE.waterDeep;
  const neck = PALETTE.inkSoft;
  return revolution(
    [
      [0.0, -0.7, deep],
      [0.55, -0.48, deep],
      [0.92, -0.04, foam],
      [0.82, 0.22, warn],
      [0.4, 1.05, warn],
      [0.28, 1.18, neck],
      [0.18, 1.48, neck],
      [0.0, 1.55, neck],
    ],
    9,
  );
}

function buildOrbGeometry(): BufferGeometry {
  const glow = PALETTE.racer[3];
  const foam = PALETTE.foam;
  return revolution(
    [
      [0.0, -0.55, glow],
      [0.38, -0.4, glow],
      [0.55, 0.0, foam],
      [0.38, 0.4, glow],
      [0.0, 0.55, foam],
    ],
    8,
  );
}

function buildBoostGeometry(): BufferGeometry {
  const green = PALETTE.racingLine;
  const foam = PALETTE.foam;
  return revolution(
    [
      [0.0, -0.85, green],
      [0.18, -0.4, green],
      [0.52, 0.0, foam],
      [0.18, 0.4, green],
      [0.0, 0.85, foam],
    ],
    6,
  );
}

function buildEdgeGeometry(): BufferGeometry {
  const foam = PALETTE.foam;
  const cyan = PALETTE.waterCrest;
  const deep = PALETTE.waterDeep;
  return revolution(
    [
      [0.0, -0.45, deep],
      [0.32, -0.28, deep],
      [0.4, 0.0, foam],
      [0.22, 0.55, cyan],
      [0.0, 0.72, foam],
    ],
    7,
  );
}
