import { Color, Group, MathUtils, Matrix4, Mesh, Object3D, Vector3 } from 'three';
import type { BufferGeometry, Material } from 'three';
import type { BoatSpec, BoatState } from '../contracts.ts';
import { PALETTE } from '../core/Palette.ts';
import { LAYER_OPAQUE } from '../render/layers.ts';
import { CelMaterial, makeGlowMaterial } from '../render/materials/CelMaterial.ts';
import type { CelMaterialOptions } from '../render/materials/CelMaterial.ts';
import { outlineHierarchy } from '../render/OutlineHull.ts';
import {
  buildCowlingGeometry,
  buildDeckGeometry,
  buildEngineGeometry,
  buildFinGeometry,
  buildHandlebarGeometry,
  buildHullGeometry,
  buildIntakeGlowGeometry,
  buildRudderGeometry,
  buildSponsonGeometry,
  ENGINE_NOZZLE,
  RUDDER_PIVOT,
} from './boatGeometry.ts';
import { HANDLEBAR_POINT, RIDER_MOUNT } from './hullSpec.ts';

/**
 * BOAT — the visual half of a racer. Owns meshes and nothing else.
 *
 * The physics writes a `BoatState` and this reads it. There is no shared
 * mutable state and no back-channel, which is what lets the hull be replaced,
 * hidden or drawn at a different time step without the simulation noticing.
 *
 * Two transform levels, and the split matters:
 *
 *   root    carries exactly what the physics said: position, and an orientation
 *           built from the state's own basis vectors.
 *   visual  carries the lies. Squat under power, and anything else added later
 *           that should move the boat's *look* without moving the frame the
 *           camera, the AI and the buoyancy probes all reason about.
 *
 * Fold the two together and every visual flourish silently becomes physics.
 */

const clamp = MathUtils.clamp;

/** Frame-rate independent exponential approach; `rate` is e-folds per second. */
function expApproach(current: number, target: number, rate: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-rate * dt));
}

/** About 2.3 degrees. Any more and it reads as a bug in the physics. */
const SQUAT_MAX = 0.04;
/** Full lock deflection of the rudder blade, radians. */
const RUDDER_LOCK = 0.5;

const _fwd = new Vector3();
const _up = new Vector3();
const _right = new Vector3();
const _basis = new Matrix4();

export class Boat {
  readonly root: Group;
  /**
   * Parent a `Rider` here. The rider is authored facing +Z and so is the hull,
   * so no facing correction is needed.
   */
  readonly riderMount: Object3D;
  /**
   * The centre of the handlebar crossbar, for anything that needs the bars in
   * world space. The rider does not: `RiderRig` solves its hands in rider-root
   * space, and HANDLEBAR_POINT is derived from RIDER_MOUNT plus that same grip
   * offset, so the two agree by construction rather than by this object.
   */
  readonly handlebar: Object3D;

  readonly spec: BoatSpec;

  private readonly visual: Group;
  private readonly rudder: Object3D;
  private readonly glow: Mesh;
  private readonly glowMaterial: CelMaterial;
  private readonly geometries: BufferGeometry[] = [];
  private readonly materials: Material[] = [];
  private readonly outlines: Mesh[] = [];

  /** Smoothed drives. All of these are integrated, never assigned from input. */
  private steer = 0;
  private squat = 0;
  private heat = 0;
  private prevForwardSpeed = 0;
  private boostOverride = false;

  constructor(spec: BoatSpec) {
    this.spec = spec;
    const ci = clamp(Math.floor(spec.colorIndex), 0, PALETTE.racer.length - 1);

    this.root = new Group();
    this.root.name = `boat_${spec.name}`;
    this.visual = new Group();
    this.visual.name = 'boatVisual';
    this.root.add(this.visual);

    // Neither material sets `rampTint`. The cel shader already multiplies the
    // ramp by the base colour, so tinting the ramp to the paint squares it and
    // the shadow side goes muddy — the shared neutral ramp keeps the hull's
    // shadow the same temperature as the rider sitting in it.
    const paint = this.material({
      color: PALETTE.racer[ci],
      vertexColors: true,
      rimColor: PALETTE.uiCyan,
      rimStrength: 0.42,
      rimPower: 2.6,
      // A hull is a lacquered surface and should say so: a tight, bright
      // specular is most of what separates painted fibreglass from plastic.
      specStrength: 0.78,
      specSize: 0.24,
      matcapStrength: 0.26,
      name: 'BoatPaint',
    });
    const trim = this.material({
      color: PALETTE.racerDark[ci],
      vertexColors: true,
      rimColor: PALETTE.uiCyan,
      rimStrength: 0.3,
      rimPower: 3.0,
      specStrength: 0.5,
      specSize: 0.4,
      matcapStrength: 0.4,
      name: 'BoatTrim',
    });

    this.part(buildHullGeometry(), paint, this.visual, 'hull');
    this.part(buildDeckGeometry(), paint, this.visual, 'deck');
    this.part(buildCowlingGeometry(), paint, this.visual, 'cowling');
    this.part(buildSponsonGeometry(-1), paint, this.visual, 'sponsonPort');
    this.part(buildSponsonGeometry(1), paint, this.visual, 'sponsonStarboard');

    // Fine ink on the small parts. A 2.6 px line is right for a 5 m hull and
    // completely swallows a 7 cm rudder blade, which at race distance turns
    // into a black smudge behind the boat.
    const fine = { outline: { widthPx: 1.8 } };
    this.part(buildFinGeometry(), paint, this.visual, 'fin', fine);
    this.part(buildEngineGeometry(), trim, this.visual, 'engine', fine);
    this.part(buildHandlebarGeometry(), trim, this.visual, 'handlebar', fine);

    // The rudder is authored about its own pivot, so the pivot object carries
    // the position and the mesh sits at its origin. That is the whole reason
    // for the exception to "all geometry is in hull space".
    this.rudder = new Object3D();
    this.rudder.name = 'rudderPivot';
    this.rudder.position.copy(RUDDER_PIVOT);
    this.visual.add(this.rudder);
    this.part(buildRudderGeometry(), trim, this.rudder, 'rudder', fine);

    this.riderMount = new Object3D();
    this.riderMount.name = 'riderMount';
    this.riderMount.position.copy(RIDER_MOUNT);
    this.visual.add(this.riderMount);

    this.handlebar = new Object3D();
    this.handlebar.name = 'handlebarTarget';
    this.handlebar.position.copy(HANDLEBAR_POINT);
    this.visual.add(this.handlebar);

    // Ink shells first, because they have to inherit `userData.outline`, then
    // the glow, because it must not get one: an emissive plate with a black
    // outline around it stops reading as light and starts reading as a sticker.
    this.outlines = outlineHierarchy(this.visual, { widthPx: 2.6 });

    this.glowMaterial = makeGlowMaterial(PALETTE.uiCyan, 0.25, 1);
    this.materials.push(this.glowMaterial);
    const glowGeo = buildIntakeGlowGeometry();
    this.geometries.push(glowGeo);
    this.glow = new Mesh(glowGeo, this.glowMaterial);
    this.glow.name = 'engineGlow';
    this.glow.position.copy(ENGINE_NOZZLE);
    this.glow.userData.noOutline = true;
    this.visual.add(this.glow);

    this.root.traverse((o) => {
      o.layers.set(LAYER_OPAQUE);
      // Four boats is twenty-odd draw calls either way, and a hull whose ink
      // shell pushes past its own bounding sphere popping at the screen edge
      // is a far worse trade than the culling test it saves.
      o.frustumCulled = false;
    });
  }

  private material(opts: CelMaterialOptions): CelMaterial {
    const m = new CelMaterial(opts);
    this.materials.push(m);
    return m;
  }

  private part(
    geo: BufferGeometry,
    mat: Material,
    parent: Object3D,
    name: string,
    userData?: Record<string, unknown>,
  ): Mesh {
    const mesh = new Mesh(geo, mat);
    mesh.name = `${this.spec.name}_${name}`;
    if (userData) Object.assign(mesh.userData, userData);
    this.geometries.push(geo);
    parent.add(mesh);
    return mesh;
  }

  // -------------------------------------------------------------------------
  // Per-frame
  // -------------------------------------------------------------------------

  /**
   * Force the boost look on or off independently of `state.boostTime`.
   *
   * Exists for the intro flyby and the results podium, where the boats are not
   * being simulated at all but still have to look like they are running.
   */
  setBoosting(active: boolean): void {
    this.boostOverride = active;
  }

  applyState(state: BoatState, dt: number): void {
    // A long frame — tab restore, first frame after a shader compile — would
    // otherwise slam every smoother at once and snap the rudder to full lock.
    const h = clamp(dt, 0, 1 / 15);

    this.root.position.copy(state.position);

    // --- orientation -------------------------------------------------------
    // `state.right` is deliberately ignored and re-derived. The three basis
    // vectors come from the physics as three independently integrated
    // quantities, and if they drift out of orthogonality by even a fraction of
    // a degree, `setFromRotationMatrix` reads the shear as a scale and the hull
    // visibly stretches. Rebuilding right from up x forward cannot drift.
    _fwd.copy(state.forward);
    if (_fwd.lengthSq() < 1e-8) _fwd.set(0, 0, 1);
    _fwd.normalize();
    _up.copy(state.up);
    if (_up.lengthSq() < 1e-8) _up.set(0, 1, 0);
    _up.normalize();

    _right.crossVectors(_up, _fwd);
    if (_right.lengthSq() < 1e-8) {
      // Pointing straight up or down: any perpendicular will do, but it has to
      // be a *fixed* choice or the hull spins on numerical noise at the apex
      // of a jump.
      _right.set(_fwd.z, 0, -_fwd.x);
      if (_right.lengthSq() < 1e-8) _right.set(1, 0, 0);
    }
    _right.normalize();
    _up.crossVectors(_fwd, _right).normalize();
    _basis.makeBasis(_right, _up, _fwd);
    this.root.quaternion.setFromRotationMatrix(_basis);

    // --- squat -------------------------------------------------------------
    // Nose DOWN under acceleration, up under braking. That is the opposite of
    // what a real hull does — a real one squats at the stern and lifts its bow
    // — and it is deliberate: the arcade convention reads as the machine
    // digging in and hauling itself forward, and it also keeps the horizon
    // visible over the cowl exactly when the player is going fastest.
    // Clamped before differencing because a collision resolve or a respawn can
    // report thousands of m/s^2 in one step.
    const accel = h > 0 ? clamp((state.forwardSpeed - this.prevForwardSpeed) / h, -60, 60) : 0;
    this.prevForwardSpeed = state.forwardSpeed;
    const squatTarget = clamp(accel / 20, -1, 1) * SQUAT_MAX;
    this.squat = expApproach(this.squat, squatTarget, 5, h);
    this.visual.rotation.x = this.squat;

    // --- rudder ------------------------------------------------------------
    // `steerLevel` steps the instant a key goes down; the blade has mass.
    this.steer = expApproach(this.steer, -clamp(state.steerLevel, -1, 1) * RUDDER_LOCK, 13, h);
    this.rudder.rotation.y = this.steer;

    // --- engine ------------------------------------------------------------
    const boosting = this.boostOverride || state.boostTime > 0;
    const throttle = clamp(state.throttleLevel, 0, 1);
    const target = throttle * 0.6 + (boosting ? 1.4 : 0);
    // Fast attack on boost, slow release, so the flare fires on the frame the
    // player presses it and then decays instead of blinking out.
    this.heat = expApproach(this.heat, target, boosting ? 24 : 5, h);

    this.glowMaterial.uniforms.uEmissiveStrength.value = 0.22 + this.heat * 1.5;
    // The nozzle plate grows as it heats. A flare that only brightens saturates
    // and stops reading; one that also gets bigger keeps registering.
    this.glow.scale.setScalar(1 + this.heat * 0.38);
    // Cyan at idle, blowing out towards foam-white at full boost. Both ends are
    // palette colours, so the flare cannot drift off the game's key.
    (this.glowMaterial.uniforms.uEmissive.value as Color)
      .copy(PALETTE.uiCyan)
      .lerp(PALETTE.foam, clamp(this.heat / 1.7, 0, 1));
  }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    this.geometries.length = 0;
    for (const m of this.materials) m.dispose();
    this.materials.length = 0;
    // Ink shells share their geometry with the mesh they wrap, so only their
    // materials are still outstanding. `disposeOutlines()` would collect them
    // at shutdown too, but a boat can be torn down mid-session on a restart.
    for (const shell of this.outlines) (shell.material as Material).dispose();
    this.outlines.length = 0;
    this.root.removeFromParent();
    this.root.clear();
  }
}
