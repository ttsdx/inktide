import {
  BufferGeometry,
  Color,
  CylinderGeometry,
  Float32BufferAttribute,
  GLSL3,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Mesh,
  Quaternion,
  ShaderMaterial,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { PALETTE } from '../core/Palette.ts';
import { CelMaterial, OutlineMaterial, makeGlowMaterial } from '../render/materials/CelMaterial.ts';
import { MRT_OUTPUTS } from '../render/shaderLib.ts';
import { computeSmoothedNormals, outlineHierarchy } from '../render/OutlineHull.ts';
import { LAYER_OPAQUE, LAYER_OVERLAY } from '../render/layers.ts';
import { detailAt, sampleOcean, type OceanSample } from '../world/gerstner.ts';
import type { Checkpoint, Course } from '../race/Course.ts';
import type { FrameContext } from '../contracts.ts';

/**
 * CHECKPOINT GATES
 *
 * Two floating pylons with a lit arch between them, straddling the racing line.
 *
 * HOW IT FLOATS
 *
 * The naive approach — sample the ocean at the gate's centre and set Y — makes
 * a 30 m wide object hover with one pylon buried and the other in the air,
 * because a 30 m span covers a quarter of the dominant swell's wavelength. So
 * each pylon base is sampled independently and the gate is *fitted* to those
 * samples: the midpoint gives the height, the height difference across the span
 * gives the roll, and the ocean normal at the centre gives the pitch. That is
 * three CPU wave evaluations per gate per frame, which at twelve gates is
 * cheaper than a single boat's buoyancy solve.
 *
 * Roll is deliberately damped to 80% of the geometric tilt. A gate that matched
 * the surface exactly looked like it was hinged; real moored structures lag the
 * water because their inertia and their mooring lines both resist it.
 *
 * PITCH is taken from the surface normal rather than from a fore/aft sample
 * pair because the gate is only ~2 m deep in its forward axis, which is far
 * inside even the shortest chop wavelength — a sample pair that close together
 * is all numerical noise and no signal.
 */

export interface GateOptions {
  /** Half-width of the opening in metres. Pylons sit at +-this. */
  halfWidth?: number;
  /** Pylon height above the waterline. */
  height?: number;
  /** Radius of the flotation collar. */
  floatRadius?: number;
  /** Colour of the arch glow. */
  glowColor?: typeof PALETTE.gateGlow;
  /** Shared opaque materials. One kit for the whole field. */
  kit?: GateKit;
  /**
   * Skip collar/pylon/arch/ink — GateField draws those as InstancedMeshes.
   * Overlay lamps and the pulsing banner stay per-gate because they animate.
   */
  instanceShell?: boolean;
}

/**
 * The three cel materials every gate shares. Twelve copies of the same shader
 * program was twelve compile-and-bind costs for a colour that never changes.
 */
export interface GateKit {
  hull: CelMaterial;
  collar: CelMaterial;
  arch: CelMaterial;
}

export function makeGateKit(): GateKit {
  return {
    hull: new CelMaterial({
      color: PALETTE.foam,
      rampTint: PALETTE.skyMid,
      rimColor: PALETTE.skyHigh,
      rimStrength: 0.7,
      specStrength: 0.5,
      matcapStrength: 0.2,
      name: 'GatePylon',
    }),
    collar: new CelMaterial({
      color: PALETTE.warn,
      rampTint: PALETTE.warn,
      specStrength: 0.4,
      matcapStrength: 0.16,
      name: 'GateCollar',
    }),
    arch: new CelMaterial({
      color: PALETTE.uiAmber,
      rampTint: PALETTE.skyHorizon,
      ambientWrap: 0.86,
      rimColor: PALETTE.skyHaze,
      rimStrength: 0.85,
      specStrength: 0.5,
      matcapStrength: 0.2,
      name: 'GateArch',
    }),
  };
}

const blankSample = (): OceanSample => ({ height: 0, nx: 0, ny: 1, nz: 0, jacobian: 1 });

// Shared scratch: gates are updated one at a time, so three samples suffice for
// the whole field.
const _left = blankSample();
const _right = blankSample();
const _mid = blankSample();
const _q = new Quaternion();
const _axis = new Vector3();
const _fwd = new Vector3();
const _side = new Vector3();

export class Gate {
  readonly group = new Group();
  readonly index: number;
  /** World XZ of the gate centre. Fixed; only Y and rotation move. */
  readonly centre = new Vector3();
  /** Unit tangent of the racing line through the gate. */
  readonly tangent = new Vector3();
  /** Left-hand normal, i.e. the pylon-to-pylon axis. */
  readonly across = new Vector3();
  readonly halfWidth: number;
  readonly mastHeight: number;

  overlayOn = false;
  lampGlow = 1.4;
  bannerGlow = 0.75;

  private readonly banner: Mesh | null;
  private readonly bannerMaterial: CelMaterial | null;
  private readonly lamp: Mesh | null;
  private readonly lampMaterial: CelMaterial | null;

  private active = false;
  /** Seconds remaining on the pass flash. */
  private flash = 0;
  private pulsePhase = 0;
  /** Smoothed roll so the gate lags the water instead of snapping to it. */
  private roll = 0;
  private pitch = 0;
  private readonly ownsKit: boolean;
  private readonly kit: GateKit;

  constructor(index: number, position: Vector3, tangent: Vector3, opts: GateOptions = {}) {
    this.index = index;
    this.halfWidth = opts.halfWidth ?? 15;
    const height = opts.height ?? 8.4;
    this.mastHeight = height;
    const floatRadius = opts.floatRadius ?? 2.1;
    const glowColor = opts.glowColor ?? PALETTE.gateGlow;

    this.centre.set(position.x, 0, position.z);
    this.tangent.copy(tangent).setY(0).normalize();
    this.across.set(this.tangent.z, 0, -this.tangent.x);

    this.group.name = `Gate${index}`;
    // The group is authored in its own frame: +X across the gate, +Z along the
    // racing line. The yaw is baked once here; only the wave tilt changes.
    this.group.position.copy(this.centre);
    this.group.rotation.y = Math.atan2(this.tangent.x, this.tangent.z);

    this.ownsKit = !opts.kit;
    this.kit = opts.kit ?? makeGateKit();
    const hullMat = this.kit.hull;
    const collarMat = this.kit.collar;
    const archMat = this.kit.arch;

    const lamps: BufferGeometry[] = [];
    for (const side of [-1, 1]) {
      const x = side * this.halfWidth;
      lamps.push(placedCylinder(0.62, 0.86, 1.1, 8, x, height + 1.2, 0));
    }

    // Regular gates share one instanced shell. Overlay lamps/banners are
    // instanced too, with per-instance glow packed from each gate's pulse.
    if (!opts.instanceShell) {
      const shell = buildGateShell(this.halfWidth, height, floatRadius);
      const collar = new Mesh(shell.collar, collarMat);
      collar.name = 'collars';
      this.group.add(collar);
      const pylon = new Mesh(shell.pylon, hullMat);
      pylon.name = 'pylons';
      this.group.add(pylon);
      const arch = new Mesh(shell.arch, archMat);
      this.group.add(arch);
    }

    this.lampMaterial = null;
    this.lamp = null;
    this.bannerMaterial = null;
    this.banner = null;

    if (!opts.instanceShell) {
      this.lampMaterial = makeGlowMaterial(glowColor.clone(), 2.1);
      this.lamp = new Mesh(mergeOrThrow(lamps), this.lampMaterial);
      this.lamp.name = 'lamps';
      this.lamp.userData.noOutline = true;
      this.lamp.layers.set(LAYER_OVERLAY);
      this.group.add(this.lamp);

      this.bannerMaterial = makeGlowMaterial(glowColor.clone(), 1.35, 0.92);
      this.banner = new Mesh(
        buildBanner(this.halfWidth * 0.92, height + 0.55, this.halfWidth * 0.24, 2.3),
        this.bannerMaterial,
      );
      this.banner.userData.noOutline = true;
      this.banner.renderOrder = 4;
      this.group.add(this.banner);
    } else {
      for (const g of lamps) g.dispose();
    }

    if (!opts.instanceShell) {
      outlineHierarchy(this.group, { widthPx: 2.2, distanceTaper: 0.9 });
      this.group.traverse((o) => {
        if (!o.userData.noOutline) o.layers.set(LAYER_OPAQUE);
      });
      this.lamp!.layers.set(LAYER_OVERLAY);
      this.banner!.layers.set(LAYER_OVERLAY);
    }

    // Deterministic per-gate phase so the twelve gates do not pulse in unison.
    this.pulsePhase = index * 1.37;
    this.setActive(false);
  }

  /** Mark this gate as the player's next checkpoint. Drives the pulse. */
  setActive(active: boolean): void {
    this.active = active;
  }

  /** One-shot bright flash, played when a racer passes through. */
  flashPassed(): void {
    this.flash = 0.42;
  }

  /**
   * Float and light the gate.
   *
   * Called with the frame context so the wave field time matches every other
   * consumer of `sampleOcean` exactly; a gate one frame out of step with the
   * water is immediately obvious because the collar rides visibly proud.
   */
  update(ctx: FrameContext, eye: Vector3, fadeStart: number, fadeEnd: number): void {
    const t = ctx.elapsed;
    const dt = ctx.dt;

    // Far gates are not drawn and not sampled. Three Gerstner solves each, on
    // twelve gates, is cheap next to a boat — but the draw calls are not: each
    // gate is a handful of meshes plus ink shells, and they were all submitted
    // every frame from 3 km away. Hide past the water's own detail fade plus a
    // small pad so a gate never pops in already floating.
    const dist = Math.hypot(this.centre.x - eye.x, this.centre.z - eye.z);
    if (dist > fadeEnd + 90) {
      this.group.visible = false;
      return;
    }
    this.group.visible = true;

    // Overlay lamps and banners are additive and fill-bound. Past ~120 m they
    // are a few pixels of cyan and still a draw. The start/finish gate keeps
    // them longer so the main straight still reads from the pack.
    const overlayRange = this.mastHeight > 10 ? 220 : 120;
    this.overlayOn = dist < overlayRange;
    if (this.lamp) this.lamp.visible = this.overlayOn;
    if (this.banner) this.banner.visible = this.overlayOn;

    _side.copy(this.across);
    const lx = this.centre.x + _side.x * this.halfWidth;
    const lz = this.centre.z + _side.z * this.halfWidth;
    const rx = this.centre.x - _side.x * this.halfWidth;
    const rz = this.centre.z - _side.z * this.halfWidth;

    // Each base gets the surface as the shader draws it *there*. One gate is
    // 30 m across, so on a long straight its two pylons can sit in visibly
    // different parts of the fade and a single shared factor would tilt it.
    const dl = detailAt(Math.hypot(lx - eye.x, lz - eye.z), fadeStart, fadeEnd);
    const dr = detailAt(Math.hypot(rx - eye.x, rz - eye.z), fadeStart, fadeEnd);
    const dm = detailAt(
      Math.hypot(this.centre.x - eye.x, this.centre.z - eye.z),
      fadeStart,
      fadeEnd,
    );

    sampleOcean(lx, lz, t, _left, dl);
    sampleOcean(rx, rz, t, _right, dr);
    sampleOcean(this.centre.x, this.centre.z, t, _mid, dm);

    // Height: mean of the two pylon bases, biased towards the centre sample so
    // a gate spanning a full crest does not sit in the trough of it.
    const span = this.halfWidth * 2;
    const height = (_left.height + _right.height) * 0.35 + _mid.height * 0.3;

    // Roll about the gate's forward axis, from the slope across the span.
    // 0.8 because a moored structure resists the water; see the header.
    const targetRoll = Math.atan2(_right.height - _left.height, span) * 0.8;
    // Pitch from the surface normal projected onto the forward axis.
    _fwd.copy(this.tangent);
    const targetPitch =
      Math.asin(
        Math.max(-1, Math.min(1, -(_mid.nx * _fwd.x + _mid.nz * _fwd.z) / Math.max(_mid.ny, 0.2))),
      ) * 0.7;

    // Critically-damped-ish first order lag. 6 Hz is fast enough to track the
    // 8.5 s swell without any visible lag and slow enough to filter the 8 m
    // chop, which a 30 m structure physically cannot follow.
    const k = Math.min(1, 6 * dt);
    this.roll += (targetRoll - this.roll) * k;
    this.pitch += (targetPitch - this.pitch) * k;

    this.group.position.set(this.centre.x, height, this.centre.z);

    // Compose the tilt as two axis rotations on top of the baked yaw. Building
    // it from quaternions rather than Euler order avoids the gimbal snap that
    // shows up when the gate is near-vertical on a steep face.
    this.group.quaternion.setFromAxisAngle(_axis.set(0, 1, 0), Math.atan2(this.tangent.x, this.tangent.z));
    _q.setFromAxisAngle(_axis.set(0, 0, 1), -this.roll);
    this.group.quaternion.multiply(_q);
    _q.setFromAxisAngle(_axis.set(1, 0, 0), this.pitch);
    this.group.quaternion.multiply(_q);

    // --- lighting -------------------------------------------------------
    if (this.flash > 0) this.flash = Math.max(0, this.flash - dt);
    // Two-frequency pulse: a slow breath plus a hard on/off blink, so the
    // active gate reads at a glance without strobing.
    const breath = 0.5 + 0.5 * Math.sin(t * 2.4 + this.pulsePhase);
    const blink = Math.sin(t * 6.1 + this.pulsePhase) > 0.35 ? 1 : 0;
    const activeLift = this.active ? 0.9 + breath * 0.75 + blink * 0.5 : 0;
    // Quantised so the glow steps rather than fading — same rule as every other
    // surface in the game.
    const flashLift = this.flash > 0 ? Math.ceil((this.flash / 0.42) * 3) * 1.5 : 0;

    const strength = 0.75 + activeLift + flashLift;
    this.bannerGlow = strength;
    this.lampGlow = 1.4 + activeLift * 0.8 + flashLift;
    if (this.bannerMaterial) this.bannerMaterial.uniforms.uEmissiveStrength.value = strength;
    if (this.lampMaterial) this.lampMaterial.uniforms.uEmissiveStrength.value = this.lampGlow;
  }

  dispose(): void {
    const seen = new Set<BufferGeometry>();
    this.group.traverse((o) => {
      const m = o as Mesh;
      if (!m.isMesh) return;
      if (!seen.has(m.geometry)) {
        seen.add(m.geometry);
        m.geometry.dispose();
      }
    });
    if (this.bannerMaterial) this.bannerMaterial.dispose();
    if (this.lampMaterial) this.lampMaterial.dispose();
    if (this.ownsKit) {
      this.kit.hull.dispose();
      this.kit.collar.dispose();
      this.kit.arch.dispose();
    }
  }
}

// ---------------------------------------------------------------------------
// Procedural geometry
// ---------------------------------------------------------------------------

function placedCylinder(
  top: number,
  bottom: number,
  height: number,
  radial: number,
  x: number,
  y: number,
  z: number,
): BufferGeometry {
  const g = new CylinderGeometry(top, bottom, height, radial, 1);
  g.translate(x, y, z);
  return g;
}

function mergeOrThrow(parts: BufferGeometry[]): BufferGeometry {
  const merged = mergeGeometries(parts, false);
  for (const g of parts) g.dispose();
  if (!merged) throw new Error('Gate: mergeGeometries returned null');
  return merged;
}

/** Canonical shell used by both unique gates and the instanced field. */
function buildGateShell(
  halfWidth: number,
  height: number,
  floatRadius = 2.1,
): { collar: BufferGeometry; pylon: BufferGeometry; arch: BufferGeometry } {
  const collars: BufferGeometry[] = [];
  const pylons: BufferGeometry[] = [];
  for (const side of [-1, 1]) {
    const x = side * halfWidth;
    collars.push(placedCylinder(floatRadius * 0.8, floatRadius, 1.4, 12, x, -0.25, 0));
    pylons.push(placedCylinder(floatRadius * 0.52, floatRadius * 0.3, height, 10, x, height * 0.5 + 0.1, 0));
  }
  return {
    collar: mergeOrThrow(collars),
    pylon: mergeOrThrow(pylons),
    arch: buildArch(halfWidth, height + 1.0, halfWidth * 0.26),
  };
}

/**
 * A square-section beam swept along a shallow arc from (-halfWidth, y) to
 * (+halfWidth, y + rise). Extruding a quad along sampled chord points keeps the
 * triangle count at ~120 and gives the ink shell a clean, faceted silhouette.
 */
function buildArch(halfWidth: number, y: number, rise: number): BufferGeometry {
  const steps = 14;
  const thick = 0.62;
  const positions: number[] = [];
  const indices: number[] = [];

  for (let i = 0; i <= steps; i++) {
    const f = i / steps;
    const x = (f * 2 - 1) * halfWidth;
    // Sine profile rather than a circular arc: it lands tangent-flat on the
    // pylons instead of meeting them at an angle.
    const h = y + Math.sin(f * Math.PI) * rise;

    // Four corners of the beam cross-section, in the group's XY plane with the
    // beam depth along Z.
    positions.push(x, h - thick, -thick);
    positions.push(x, h + thick, -thick);
    positions.push(x, h + thick, thick);
    positions.push(x, h - thick, thick);

    if (i > 0) {
      const a = (i - 1) * 4;
      const b = i * 4;
      for (let c = 0; c < 4; c++) {
        const c1 = (c + 1) % 4;
        indices.push(a + c, b + c, a + c1);
        indices.push(a + c1, b + c, b + c1);
      }
    }
  }

  // Caps, so the ink shell has no open ends to leak through.
  const last = steps * 4;
  indices.push(0, 2, 1, 0, 3, 2);
  indices.push(last, last + 1, last + 2, last, last + 2, last + 3);

  return finish(positions, indices);
}

/**
 * A flat, slightly bowed banner panel hanging under the arch. Double-sided
 * geometry (two wound quads) rather than a DoubleSide material, so the ink
 * shell has a closed volume to invert.
 */
function buildBanner(halfWidth: number, y: number, rise: number, depth: number): BufferGeometry {
  const steps = 10;
  const positions: number[] = [];
  const indices: number[] = [];

  for (let i = 0; i <= steps; i++) {
    const f = i / steps;
    const x = (f * 2 - 1) * halfWidth;
    const top = y + Math.sin(f * Math.PI) * rise;
    // The bottom edge sags slightly more than the top, which reads as fabric.
    const bottom = top - depth - Math.sin(f * Math.PI) * 0.35;
    positions.push(x, top, 0.02);
    positions.push(x, bottom, 0.02);
    positions.push(x, top, -0.02);
    positions.push(x, bottom, -0.02);

    if (i > 0) {
      const a = (i - 1) * 4;
      const b = i * 4;
      indices.push(a + 0, b + 0, a + 1);
      indices.push(a + 1, b + 0, b + 1);
      indices.push(a + 2, a + 3, b + 2);
      indices.push(a + 3, b + 3, b + 2);
    }
  }

  return finish(positions, indices);
}

function finish(positions: number[], indices: number[]): BufferGeometry {
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

// ---------------------------------------------------------------------------
// Gate field
// ---------------------------------------------------------------------------

/**
 * Owns one gate per checkpoint and ticks them together.
 *
 * Regular gates share six InstancedMeshes (collar, mast, arch, and an ink
 * shell for each). The start/finish gate is a unique mesh: it is taller and
 * a different colour. Overlay lamps and banners stay per-gate because they
 * pulse.
 *
 * `RaceDirector` drives `setActiveIndex` from the player's `nextCheckpoint`, and
 * `flashPassed` from the gate-pass event, so the visual layer never has to know
 * anything about lap validation.
 */
const SHELL_HW = 15;
const SHELL_H = 8.4;
const _inst = new Matrix4();
const _scale = new Matrix4();

export class GateField {
  readonly root = new Group();
  readonly gates: Gate[] = [];
  private readonly kit: GateKit;
  private readonly batch: Gate[] = [];
  private readonly shells: InstancedMesh[] = [];
  private readonly shellGeos: BufferGeometry[] = [];
  private readonly inkMats: OutlineMaterial[] = [];
  private readonly overlays: InstancedMesh[] = [];
  private readonly overlayGlow: InstancedBufferAttribute[] = [];
  private readonly overlayMats: ShaderMaterial[] = [];

  constructor(course: Course, opts: GateOptions = {}) {
    this.root.name = 'Gates';
    this.kit = opts.kit ?? makeGateKit();

    for (const cp of course.checkpoints) {
      const instanced = !cp.startFinish;
      const gate = new Gate(cp.index, cp.position, cp.tangent, {
        ...opts,
        kit: this.kit,
        halfWidth: opts.halfWidth ?? gateHalfWidth(cp),
        height: cp.startFinish ? 11.5 : (opts.height ?? 8.4),
        glowColor: cp.startFinish ? PALETTE.racingLine : (opts.glowColor ?? PALETTE.gateGlow),
        instanceShell: instanced,
      });
      this.gates.push(gate);
      this.root.add(gate.group);
      if (instanced) this.batch.push(gate);
    }

    if (this.batch.length > 0) {
      const n = this.batch.length;
      const proto = buildGateShell(SHELL_HW, SHELL_H, opts.floatRadius ?? 2.1);
      const parts: Array<[BufferGeometry, CelMaterial, string]> = [
        [proto.collar, this.kit.collar, 'GateCollars'],
        [proto.pylon, this.kit.hull, 'GatePylons'],
        [proto.arch, this.kit.arch, 'GateArches'],
      ];
      for (const [geo, mat, name] of parts) {
        computeSmoothedNormals(geo);
        this.shellGeos.push(geo);
        const mesh = new InstancedMesh(geo, mat, n);
        mesh.name = name;
        mesh.frustumCulled = false;
        mesh.layers.set(LAYER_OPAQUE);
        this.root.add(mesh);
        this.shells.push(mesh);

        const inkMat = new OutlineMaterial({ widthPx: 2.2 });
        inkMat.uniforms.uDistanceTaper.value = 0.9;
        geo.computeBoundingBox();
        const bb = geo.boundingBox;
        if (bb) {
          const dims = [bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z].sort(
            (a, b) => a - b,
          );
          inkMat.uniforms.uMaxPushWorld.value = Math.max(dims[1] * 0.34, 1e-4);
        }
        this.inkMats.push(inkMat);
        const ink = new InstancedMesh(geo, inkMat, n);
        ink.name = `${name}Ink`;
        ink.frustumCulled = false;
        ink.userData.isOutline = true;
        ink.layers.set(LAYER_OPAQUE);
        ink.renderOrder = -1;
        this.root.add(ink);
        this.shells.push(ink);
      }

      const glowColor = opts.glowColor ?? PALETTE.gateGlow;
      const lampParts: BufferGeometry[] = [];
      for (const side of [-1, 1]) {
        lampParts.push(placedCylinder(0.62, 0.86, 1.1, 8, side * SHELL_HW, SHELL_H + 1.2, 0));
      }
      const lampGeo = mergeOrThrow(lampParts);
      const bannerGeo = buildBanner(SHELL_HW * 0.92, SHELL_H + 0.55, SHELL_HW * 0.24, 2.3);
      this.shellGeos.push(lampGeo, bannerGeo);

      const overlaySpecs: Array<[BufferGeometry, number, string]> = [
        [lampGeo, 1, 'GateLamps'],
        [bannerGeo, 0.92, 'GateBanners'],
      ];
      for (const [geo, opacity, name] of overlaySpecs) {
        const glow = new InstancedBufferAttribute(new Float32Array(n), 1);
        geo.setAttribute('aGlow', glow);
        this.overlayGlow.push(glow);
        const mat = makeInstancedGlow(glowColor, opacity);
        this.overlayMats.push(mat);
        const mesh = new InstancedMesh(geo, mat, n);
        mesh.name = name;
        mesh.frustumCulled = false;
        mesh.userData.noOutline = true;
        mesh.layers.set(LAYER_OVERLAY);
        mesh.count = 0;
        this.root.add(mesh);
        this.overlays.push(mesh);
      }
    }
  }

  /** Highlight the gate the player must pass next. Pass -1 for none. */
  setActiveIndex(index: number): void {
    for (const g of this.gates) g.setActive(g.index === index);
  }

  flashPassed(index: number): void {
    this.gates[index]?.flashPassed();
  }

  update(ctx: FrameContext, eye: Vector3, fadeStart: number, fadeEnd: number): void {
    for (const g of this.gates) g.update(ctx, eye, fadeStart, fadeEnd);
    const n = this.batch.length;
    if (n === 0 || this.shells.length === 0) return;
    let written = 0;
    for (let i = 0; i < n; i++) {
      const g = this.batch[i];
      if (!g.group.visible) continue;
      g.group.updateMatrix();
      _scale.makeScale(g.halfWidth / SHELL_HW, g.mastHeight / SHELL_H, 1);
      _inst.multiplyMatrices(g.group.matrix, _scale);
      for (const mesh of this.shells) mesh.setMatrixAt(written, _inst);
      written++;
    }
    for (const mesh of this.shells) {
      mesh.count = written;
      mesh.instanceMatrix.needsUpdate = true;
    }

    if (this.overlays.length === 2) {
      let shown = 0;
      const lampGlow = this.overlayGlow[0];
      const bannerGlow = this.overlayGlow[1];
      for (let i = 0; i < n; i++) {
        const g = this.batch[i];
        if (!g.group.visible || !g.overlayOn) continue;
        g.group.updateMatrix();
        _scale.makeScale(g.halfWidth / SHELL_HW, g.mastHeight / SHELL_H, 1);
        _inst.multiplyMatrices(g.group.matrix, _scale);
        for (const mesh of this.overlays) mesh.setMatrixAt(shown, _inst);
        lampGlow.setX(shown, g.lampGlow);
        bannerGlow.setX(shown, g.bannerGlow);
        shown++;
      }
      for (let o = 0; o < this.overlays.length; o++) {
        const mesh = this.overlays[o];
        mesh.count = shown;
        mesh.instanceMatrix.needsUpdate = true;
        this.overlayGlow[o].needsUpdate = true;
      }
    }
  }

  dispose(): void {
    for (const g of this.gates) g.dispose();
    this.gates.length = 0;
    this.batch.length = 0;
    for (const mesh of this.overlays) {
      mesh.removeFromParent();
      mesh.dispose();
    }
    this.overlays.length = 0;
    this.overlayGlow.length = 0;
    for (const m of this.overlayMats) m.dispose();
    this.overlayMats.length = 0;
    for (const mesh of this.shells) {
      mesh.removeFromParent();
      mesh.dispose();
    }
    this.shells.length = 0;
    for (const g of this.shellGeos) g.dispose();
    this.shellGeos.length = 0;
    for (const m of this.inkMats) m.dispose();
    this.inkMats.length = 0;
    this.root.clear();
    this.kit.hull.dispose();
    this.kit.collar.dispose();
    this.kit.arch.dispose();
  }
}

/**
 * Gate opening derived from the corridor. Clamped at the bottom so the chicane
 * gates, where the corridor pinches to 8.5 m, still leave enough room to take a
 * bad line through without being disqualified for it.
 */
function gateHalfWidth(cp: Checkpoint): number {
  return Math.max(13, Math.min(26, cp.width));
}

function makeInstancedGlow(color: Color, opacity: number): ShaderMaterial {
  return new ShaderMaterial({
    name: 'GateGlow',
    glslVersion: GLSL3,
    transparent: opacity < 1,
    depthWrite: false,
    uniforms: {
      uColor: { value: color.clone() },
      uOpacity: { value: opacity },
      uCameraFar: { value: 4000 },
      uCameraNear: { value: 0.35 },
    },
    vertexShader: INSTANCED_GLOW_VERT,
    fragmentShader: INSTANCED_GLOW_FRAG,
  });
}

const INSTANCED_GLOW_VERT = /* glsl */ `
precision highp float;
in float aGlow;
out float vGlow;
void main() {
  vGlow = aGlow;
  mat4 model = modelMatrix * instanceMatrix;
  vec4 world = model * vec4(position, 1.0);
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const INSTANCED_GLOW_FRAG = /* glsl */ `
precision highp float;
${MRT_OUTPUTS}
uniform vec3 uColor;
uniform float uOpacity;
in float vGlow;
void main() {
  outColor = vec4(uColor * vGlow, uOpacity);
  outNormalDepth = vec4(0.5, 0.5, 0.5, 1.0);
}
`;

