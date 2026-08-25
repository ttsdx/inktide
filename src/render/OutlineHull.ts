import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Mesh,
  Object3D,
  Vector3,
  type Material,
} from 'three';
import { OutlineMaterial } from './materials/CelMaterial.ts';
import { PALETTE } from '../core/Palette.ts';

/**
 * INVERTED-HULL INK OUTLINES
 *
 * The classic trick — duplicate the mesh, push it out along its normals, render
 * backfaces — falls apart on hard-edged geometry because the duplicated shell
 * splits open wherever the shading normals are split. A boat hull is nothing
 * but hard edges, so we precompute a second normal set that is smoothed across
 * *position*, not across shading islands, and push along that instead.
 */

const _a = new Vector3();
const _b = new Vector3();
const _c = new Vector3();
const _ab = new Vector3();
const _ac = new Vector3();
const _n = new Vector3();

/**
 * Compute area-weighted normals averaged over every vertex that shares a world
 * position, and store them as the `outlineNormal` attribute.
 *
 * Positions are bucketed on a quantised grid so vertices that were split for
 * UV or shading reasons still merge. The quantisation is relative to the mesh's
 * bounding sphere so it works for a 0.3 m buoy and a 6 m hull alike.
 */
export function computeSmoothedNormals(geometry: BufferGeometry): BufferGeometry {
  const pos = geometry.getAttribute('position') as BufferAttribute;
  const count = pos.count;

  geometry.computeBoundingSphere();
  const radius = geometry.boundingSphere?.radius ?? 1;
  const q = Math.max(radius * 1e-4, 1e-5);
  const key = (i: number) => {
    const x = Math.round(pos.getX(i) / q);
    const y = Math.round(pos.getY(i) / q);
    const z = Math.round(pos.getZ(i) / q);
    return `${x},${y},${z}`;
  };

  // Bucket duplicate positions.
  const buckets = new Map<string, number[]>();
  for (let i = 0; i < count; i++) {
    const k = key(i);
    const list = buckets.get(k);
    if (list) list.push(i);
    else buckets.set(k, [i]);
  }

  const accum = new Float32Array(count * 3);
  const index = geometry.getIndex();
  const triCount = index ? index.count / 3 : count / 3;

  for (let t = 0; t < triCount; t++) {
    const i0 = index ? index.getX(t * 3 + 0) : t * 3 + 0;
    const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;

    _a.fromBufferAttribute(pos, i0);
    _b.fromBufferAttribute(pos, i1);
    _c.fromBufferAttribute(pos, i2);
    _ab.subVectors(_b, _a);
    _ac.subVectors(_c, _a);
    // Cross product magnitude is 2x the triangle area, giving area weighting
    // for free — large faces should dominate the smoothed direction.
    _n.crossVectors(_ab, _ac);

    for (const i of [i0, i1, i2]) {
      accum[i * 3 + 0] += _n.x;
      accum[i * 3 + 1] += _n.y;
      accum[i * 3 + 2] += _n.z;
    }
  }

  // Share each bucket's summed normal across all its split copies.
  const out = new Float32Array(count * 3);
  for (const indices of buckets.values()) {
    let sx = 0;
    let sy = 0;
    let sz = 0;
    for (const i of indices) {
      sx += accum[i * 3 + 0];
      sy += accum[i * 3 + 1];
      sz += accum[i * 3 + 2];
    }
    const len = Math.hypot(sx, sy, sz) || 1;
    sx /= len;
    sy /= len;
    sz /= len;
    for (const i of indices) {
      out[i * 3 + 0] = sx;
      out[i * 3 + 1] = sy;
      out[i * 3 + 2] = sz;
    }
  }

  geometry.setAttribute('outlineNormal', new BufferAttribute(out, 3));
  return geometry;
}

export interface OutlineOptions {
  /** Line width in pixels at 1080p framebuffer height. */
  widthPx?: number;
  color?: Color;
  /** 0 = line vanishes with distance, 1 = perfectly constant screen width. */
  distanceTaper?: number;
  renderOrder?: number;
}

/** All live outline materials, so the engine can push viewport uniforms once. */
const registry = new Set<OutlineMaterial>();

export function updateOutlineViewport(viewportHeight: number, projScaleY: number, far: number): void {
  for (const m of registry) {
    m.uniforms.uViewportHeight.value = viewportHeight;
    m.uniforms.uProjScaleY.value = projScaleY;
    m.uniforms.uCameraFar.value = far;
  }
}

export function setOutlineHaze(near: number, far: number): void {
  for (const m of registry) {
    m.uniforms.uFogNear.value = near;
    m.uniforms.uFogFar.value = far;
  }
}

/**
 * Build the ink shell for a mesh and parent it to that mesh, so it inherits the
 * transform automatically and needs no per-frame sync.
 */
export function attachOutline(mesh: Mesh, opts: OutlineOptions = {}): Mesh {
  const geo = mesh.geometry as BufferGeometry;
  if (!geo.getAttribute('outlineNormal')) computeSmoothedNormals(geo);

  const mat = new OutlineMaterial({
    color: opts.color ?? PALETTE.ink,
    widthPx: opts.widthPx ?? 2.4,
  });
  mat.uniforms.uDistanceTaper.value = opts.distanceTaper ?? 0.62;
  registry.add(mat);

  const shell = new Mesh(geo, mat);
  shell.name = `${mesh.name || 'mesh'}_ink`;
  shell.renderOrder = opts.renderOrder ?? (mesh.renderOrder - 1);
  shell.frustumCulled = mesh.frustumCulled;
  // The shell must not cast/receive anything or be picked up by raycasts.
  shell.raycast = () => {};
  shell.userData.isOutline = true;
  mesh.add(shell);
  return shell;
}

/** Recursively outline every Mesh under a root, skipping opted-out nodes. */
export function outlineHierarchy(root: Object3D, opts: OutlineOptions = {}): Mesh[] {
  const created: Mesh[] = [];
  const meshes: Mesh[] = [];
  root.traverse((o) => {
    if ((o as Mesh).isMesh && !o.userData.isOutline && !o.userData.noOutline) {
      meshes.push(o as Mesh);
    }
  });
  for (const m of meshes) {
    const per = (m.userData.outline ?? {}) as OutlineOptions;
    created.push(attachOutline(m, { ...opts, ...per }));
  }
  return created;
}

/** Free every outline material this module created. */
export function disposeOutlines(): void {
  for (const m of registry) (m as Material).dispose();
  registry.clear();
}
