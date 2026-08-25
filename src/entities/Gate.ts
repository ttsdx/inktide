import {
  BufferGeometry,
  CylinderGeometry,
  Float32BufferAttribute,
  Group,
  Mesh,
  Quaternion,
  Vector3,
} from 'three';
import { PALETTE } from '../core/Palette.ts';
import { CelMaterial, makeGlowMaterial } from '../render/materials/CelMaterial.ts';
import { outlineHierarchy } from '../render/OutlineHull.ts';
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

  private readonly banner: Mesh;
  private readonly bannerMaterial: CelMaterial;
  private readonly lamps: Mesh[] = [];
  private readonly lampMaterials: CelMaterial[] = [];

  private active = false;
  /** Seconds remaining on the pass flash. */
  private flash = 0;
  private pulsePhase = 0;
  /** Smoothed roll so the gate lags the water instead of snapping to it. */
  private roll = 0;
  private pitch = 0;

  constructor(index: number, position: Vector3, tangent: Vector3, opts: GateOptions = {}) {
    this.index = index;
    this.halfWidth = opts.halfWidth ?? 15;
    const height = opts.height ?? 8.4;
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

    const hullMat = new CelMaterial({
      color: PALETTE.skyHorizon,
      rampTint: PALETTE.foam,
      rimColor: PALETTE.skyHaze,
      rimStrength: 0.7,
      specStrength: 0.55,
      matcapStrength: 0.22,
      name: 'GatePylon',
    });
    const collarMat = new CelMaterial({
      color: PALETTE.warn,
      rampTint: PALETTE.warn,
      specStrength: 0.4,
      matcapStrength: 0.16,
      name: 'GateCollar',
    });

    for (const side of [-1, 1]) {
      const x = side * this.halfWidth;

      // Flotation collar: a squat drum sitting at the waterline. Cut low enough
      // that the waterline foam ring from the ocean shader lands on it.
      const collar = new Mesh(
        new CylinderGeometry(floatRadius, floatRadius * 0.78, 1.5, 12, 1),
        collarMat,
      );
      collar.position.set(x, 0.15, 0);
      this.group.add(collar);

      // Pylon: a tapered mast. 10 radial segments keeps the silhouette faceted,
      // which the ink outline needs in order to read as drawn rather than
      // extruded.
      const pylon = new Mesh(
        new CylinderGeometry(floatRadius * 0.52, floatRadius * 0.30, height, 10, 1),
        hullMat,
      );
      pylon.position.set(x, height * 0.5 + 0.6, 0);
      this.group.add(pylon);

      // Lamp on top of each pylon.
      const lampMat = makeGlowMaterial(glowColor.clone(), 2.1);
      const lamp = new Mesh(new CylinderGeometry(0.62, 0.86, 1.1, 8, 1), lampMat);
      lamp.position.set(x, height + 1.2, 0);
      lamp.userData.noOutline = true;
      lamp.layers.set(LAYER_OVERLAY);
      this.group.add(lamp);
      this.lamps.push(lamp);
      this.lampMaterials.push(lampMat);
    }

    // The arch. Built as a chord-sampled tube rather than a TorusGeometry
    // segment so the sag is a controllable catenary-ish curve and the ends land
    // exactly on the pylon tops at any half-width.
    // Warm, not near-ink.
    //
    // The arch was painted `inkSoft`, which made it the heaviest black mass in
    // any frame containing a gate — heavier than the hero boat's own contour,
    // so a course marker out-ranked the racer in the reading order. It is also
    // the only large object in the game that is neither sky nor water, so a
    // warm tone both fixes the weight problem and turns gates into legible
    // landmarks against an otherwise entirely blue frame.
    const archMat = new CelMaterial({
      color: PALETTE.uiAmber,
      rampTint: PALETTE.skyHorizon,
      specStrength: 0.5,
      matcapStrength: 0.2,
      name: 'GateArch',
    });
    const arch = new Mesh(buildArch(this.halfWidth, height + 1.0, this.halfWidth * 0.26), archMat);
    this.group.add(arch);

    // The banner is the thing that glows and pulses. A separate mesh so its
    // emissive strength can be driven without touching the arch.
    this.bannerMaterial = makeGlowMaterial(glowColor.clone(), 1.35, 0.92);
    this.banner = new Mesh(
      buildBanner(this.halfWidth * 0.92, height + 0.55, this.halfWidth * 0.24, 2.3),
      this.bannerMaterial,
    );
    this.banner.userData.noOutline = true;
    this.banner.renderOrder = 4;
    this.group.add(this.banner);

    // Props sit below the racers in the ink hierarchy. A captured frame
    // measured a 14 px stroke on a near gate — wider than the tube it was
    // outlining — against no line at all on the boats.
    outlineHierarchy(this.group, { widthPx: 2.2, distanceTaper: 0.9 });
    this.group.traverse((o) => {
      if (!o.userData.noOutline) o.layers.set(LAYER_OPAQUE);
    });
    // The lamps and the banner belong on the overlay slice so their additive
    // glow composites over the water rather than being written into it.
    for (const l of this.lamps) l.layers.set(LAYER_OVERLAY);
    this.banner.layers.set(LAYER_OVERLAY);

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
    this.bannerMaterial.uniforms.uEmissiveStrength.value = strength;
    for (const m of this.lampMaterials) {
      m.uniforms.uEmissiveStrength.value = 1.4 + activeLift * 0.8 + flashLift;
    }
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
    this.bannerMaterial.dispose();
    for (const m of this.lampMaterials) m.dispose();
  }
}

// ---------------------------------------------------------------------------
// Procedural geometry
// ---------------------------------------------------------------------------

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
 * `RaceDirector` drives `setActiveIndex` from the player's `nextCheckpoint`, and
 * `flashPassed` from the gate-pass event, so the visual layer never has to know
 * anything about lap validation.
 */
export class GateField {
  readonly root = new Group();
  readonly gates: Gate[] = [];

  constructor(course: Course, opts: GateOptions = {}) {
    this.root.name = 'Gates';
    for (const cp of course.checkpoints) {
      const gate = new Gate(cp.index, cp.position, cp.tangent, {
        ...opts,
        halfWidth: opts.halfWidth ?? gateHalfWidth(cp),
        // The start/finish gate is taller and reads in a different colour so it
        // is unmistakable from a kilometre away down the main straight.
        height: cp.startFinish ? 11.5 : (opts.height ?? 8.4),
        glowColor: cp.startFinish ? PALETTE.racingLine : (opts.glowColor ?? PALETTE.gateGlow),
      });
      this.gates.push(gate);
      this.root.add(gate.group);
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
  }

  dispose(): void {
    for (const g of this.gates) g.dispose();
    this.gates.length = 0;
    this.root.clear();
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
