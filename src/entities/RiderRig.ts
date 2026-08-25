import { Euler, Object3D, Quaternion, Vector3 } from 'three';
import { RIDER_DIMS } from './riderGeometry.ts';

/**
 * RIDER RIG — the skeleton, and the rest pose that gives it its character.
 *
 * This is a rigid-part hierarchy, not a skinned mesh: every body part is a
 * child `Object3D` whose geometry origin already sits at its joint, so posing is
 * pure `Object3D.quaternion` writes with no bind matrices and no per-vertex
 * work. For a character that is 40-120 px tall and never seen without a helmet
 * that is the right trade; skinning would buy deformation nobody can resolve at
 * a cost of a skeleton update per frame per racer.
 *
 * THE REST POSE IS THE MOST IMPORTANT CODE IN THE SUBSYSTEM.
 *
 * Every animation layer in `Rider.ts` is expressed as a small offset from these
 * numbers, so if the rest pose is wrong the animation cannot rescue it — it will
 * just be a wrong pose that moves. It is a committed racing crouch: hips low,
 * knees folded up and forward into the footwells, torso pitched 25 degrees over
 * the bars, shoulders rolled slightly in, and the neck and head rotated *back*
 * by very nearly the amount the spine is rotated forward.
 *
 * That last part is the trick. The head chain's rest rotation (-0.16 at the neck,
 * -0.30 at the head) sums to -0.46 against the spine chain's +0.44, so the skull
 * ends up level with the horizon while the body is folded over. A rider whose
 * head follows their spine reads as a crash-test dummy; a rider whose head
 * stays locked on the horizon reads as someone driving.
 *
 * Angles are radians. Positive X pitches a bone's own +Y towards +Z (forward),
 * so limbs that hang down -Y take the opposite sign to the spine — that is not a
 * mistake anywhere below, it falls out of the parts pointing opposite ways.
 */

/** Rider's own left. See the facing note in `riderGeometry.ts`: left is +X. */
export const SIDE_LEFT = 1;
/** Rider's own right, at -X. This is the hand on the throttle. */
export const SIDE_RIGHT = -1;

/**
 * Hip joint height above the rider root, in metres. Chosen so that the boots
 * end up just touching the root's Y=0 plane in the rest crouch — mount the
 * rider at deck level and the feet land in the footwells with no fiddling.
 */
export const HIP_HEIGHT = 0.74;

/**
 * Where the wrists want to be, in rider-root space, when the bars are centred.
 *
 * These are *root* space and not bone space on purpose: the handlebars belong to
 * the boat, so their position must not move when the rider's spine does. Every
 * arm pose in `Rider.ts` is an IK solve back to a point in this space, which is
 * the only way the hands stay welded to the bars while the shoulders swing.
 */
export const GRIP = Object.freeze({ x: 0.212, y: 1.02, z: 0.545 });

/**
 * Radians of bar-assembly yaw per unit of rider lean.
 *
 * A rider steering into a turn pulls the inside grip back and pushes the
 * outside one forward, which is a rotation of the whole bar about its steering
 * stem. `Rider` rotates its hand IK targets by this, and `Boat` rotates the
 * modelled handlebar by the same amount from the same signal — that is the only
 * reason the hands stay on the bars.
 *
 * They used to disagree. The rider displaced its grip targets along Z by up to
 * 55 mm per hand while the boat's handlebar mesh was parented to the hull at a
 * fixed transform and never moved at all, so in any turn the rider was steering
 * an imaginary bar and its hands hung up to 5 cm off the modelled one. A probe
 * measuring hand-to-grip distance found 0.0 cm at rest and 5.0 cm mid-drift,
 * which is exactly the shape of a fault that only exists while turning and so
 * never shows up in a static test.
 *
 * 0.262 rad is 15 degrees, which is what 55 mm of throw subtends at the grips'
 * 212 mm half-span.
 */
export const BAR_YAW_PER_LEAN = 0.262;

/** The bar's steering axis in rider-root space: on the centreline, at the grips. */
export const BAR_PIVOT = Object.freeze({ y: GRIP.y, z: GRIP.z });

interface BoneSpec {
  name: string;
  parent: string | null;
  /** Local offset from the parent joint. */
  pos: [number, number, number];
  /** Rest rotation as XYZ Euler radians. */
  rot: [number, number, number];
}

const SPEC: readonly BoneSpec[] = [
  { name: 'hips', parent: null, pos: [0, HIP_HEIGHT, 0], rot: [0, 0, 0] },

  // --- spine: 0.16 + 0.16 + 0.12 = 0.44 rad ~= 25 degrees of forward pitch,
  //     distributed so the curve is strongest low down like a real crouch.
  { name: 'spineLower', parent: 'hips', pos: [0, 0.055, 0], rot: [0.16, 0, 0] },
  { name: 'spineUpper', parent: 'spineLower', pos: [0, RIDER_DIMS.spineLower, 0], rot: [0.16, 0, 0] },
  { name: 'chest', parent: 'spineUpper', pos: [0, RIDER_DIMS.spineUpper, 0], rot: [0.12, 0, 0] },

  // --- head chain: cancels the spine so the eyeline sits on the horizon.
  { name: 'neck', parent: 'chest', pos: [0, RIDER_DIMS.neck, 0], rot: [-0.16, 0, 0] },
  { name: 'head', parent: 'neck', pos: [0, RIDER_DIMS.head, 0], rot: [-0.3, 0, 0] },

  // --- arms. The shoulder bones carry no rest rotation: they exist so the
  //     animation has a clean shrug axis and so the IK has a stable frame to
  //     solve in that is not also being pitched by the chest.
  { name: 'shoulderL', parent: 'chest', pos: [0.105, 0.105, 0.01], rot: [0, 0, 0] },
  { name: 'shoulderR', parent: 'chest', pos: [-0.105, 0.105, 0.01], rot: [0, 0, 0] },
  // Arm rest rotations are an approximation of the racing pose. They are
  // overwritten by the IK solve every frame; they matter only as the base the
  // celebration blend interpolates against, and as a sane fallback pose.
  { name: 'upperArmL', parent: 'shoulderL', pos: [0.1, -0.01, 0], rot: [-0.85, 0, 0.3] },
  { name: 'upperArmR', parent: 'shoulderR', pos: [-0.1, -0.01, 0], rot: [-0.85, 0, -0.3] },
  { name: 'forearmL', parent: 'upperArmL', pos: [0, -RIDER_DIMS.upperArm, 0], rot: [-0.95, 0, 0] },
  { name: 'forearmR', parent: 'upperArmR', pos: [0, -RIDER_DIMS.upperArm, 0], rot: [-0.95, 0, 0] },
  { name: 'handL', parent: 'forearmL', pos: [0, -RIDER_DIMS.forearm, 0], rot: [0.55, 0, 0] },
  { name: 'handR', parent: 'forearmR', pos: [0, -RIDER_DIMS.forearm, 0], rot: [0.55, 0, 0] },

  // --- legs. -1.15 at the hip and +1.35 at the knee folds the shin back under
  //     the thigh; the small Z terms splay the knees apart around the hull.
  { name: 'thighL', parent: 'hips', pos: [0.095, -0.055, 0], rot: [-1.15, 0, 0.1] },
  { name: 'thighR', parent: 'hips', pos: [-0.095, -0.055, 0], rot: [-1.15, 0, -0.1] },
  { name: 'shinL', parent: 'thighL', pos: [0, -RIDER_DIMS.thigh, 0], rot: [1.35, 0, 0] },
  { name: 'shinR', parent: 'thighR', pos: [0, -RIDER_DIMS.thigh, 0], rot: [1.35, 0, 0] },
  { name: 'footL', parent: 'shinL', pos: [0, -RIDER_DIMS.shin, 0], rot: [-0.35, 0, 0] },
  { name: 'footR', parent: 'shinR', pos: [0, -RIDER_DIMS.shin, 0], rot: [-0.35, 0, 0] },
];

const _e = new Euler();

export class RiderRig {
  /** Hips. The root of the skeleton; parent this to the rider's own Group. */
  readonly root: Object3D;

  readonly hips: Object3D;
  readonly spineLower: Object3D;
  readonly spineUpper: Object3D;
  readonly chest: Object3D;
  readonly neck: Object3D;
  readonly head: Object3D;

  readonly shoulderL: Object3D;
  readonly shoulderR: Object3D;
  readonly upperArmL: Object3D;
  readonly upperArmR: Object3D;
  readonly forearmL: Object3D;
  readonly forearmR: Object3D;
  readonly handL: Object3D;
  readonly handR: Object3D;

  readonly thighL: Object3D;
  readonly thighR: Object3D;
  readonly shinL: Object3D;
  readonly shinR: Object3D;
  readonly footL: Object3D;
  readonly footR: Object3D;

  /** Every bone, parents before children. */
  readonly bones: readonly Object3D[];

  /** Segment lengths the arm IK needs. Read from the same table as the meshes. */
  readonly upperArmLength = RIDER_DIMS.upperArm;
  readonly forearmLength = RIDER_DIMS.forearm;

  private readonly byName = new Map<string, Object3D>();
  /** Rest rotation per bone. Poses are always composed against these. */
  private readonly rest = new Map<Object3D, Quaternion>();
  /** Rest local position per bone, so translation layers are also offsets. */
  private readonly restPos = new Map<Object3D, Vector3>();

  constructor() {
    const built: Object3D[] = [];
    for (const spec of SPEC) {
      const bone = new Object3D();
      bone.name = `rider_${spec.name}`;
      bone.position.set(spec.pos[0], spec.pos[1], spec.pos[2]);
      _e.set(spec.rot[0], spec.rot[1], spec.rot[2], 'XYZ');
      bone.quaternion.setFromEuler(_e);
      // Bones are tiny and always inside the rider's own bounds; culling them
      // individually costs more than it saves and can pop parts off a boat that
      // is only half on screen.
      bone.frustumCulled = false;

      if (spec.parent) {
        const parent = this.byName.get(spec.parent);
        if (!parent) throw new Error(`RiderRig: parent ${spec.parent} declared after ${spec.name}`);
        parent.add(bone);
      }
      this.byName.set(spec.name, bone);
      this.rest.set(bone, bone.quaternion.clone());
      this.restPos.set(bone, bone.position.clone());
      built.push(bone);
    }

    this.bones = built;
    this.hips = this.get('hips');
    this.root = this.hips;
    this.spineLower = this.get('spineLower');
    this.spineUpper = this.get('spineUpper');
    this.chest = this.get('chest');
    this.neck = this.get('neck');
    this.head = this.get('head');
    this.shoulderL = this.get('shoulderL');
    this.shoulderR = this.get('shoulderR');
    this.upperArmL = this.get('upperArmL');
    this.upperArmR = this.get('upperArmR');
    this.forearmL = this.get('forearmL');
    this.forearmR = this.get('forearmR');
    this.handL = this.get('handL');
    this.handR = this.get('handR');
    this.thighL = this.get('thighL');
    this.thighR = this.get('thighR');
    this.shinL = this.get('shinL');
    this.shinR = this.get('shinR');
    this.footL = this.get('footL');
    this.footR = this.get('footR');
  }

  private get(name: string): Object3D {
    const bone = this.byName.get(name);
    if (!bone) throw new Error(`RiderRig: no bone named ${name}`);
    return bone;
  }

  /** Look a bone up by its short name (`'chest'`, `'upperArmR'`, ...). */
  bone(name: string): Object3D {
    return this.get(name);
  }

  /** Pick the left or right member of a mirrored pair. `side` is +1 or -1. */
  sided(base: string, side: number): Object3D {
    return this.get(base + (side >= 0 ? 'L' : 'R'));
  }

  /** The bone's rest rotation. Do not mutate the returned quaternion. */
  restOf(bone: Object3D): Quaternion {
    const q = this.rest.get(bone);
    if (!q) throw new Error(`RiderRig: ${bone.name} is not part of this rig`);
    return q;
  }

  /** The bone's rest local position. Do not mutate. */
  restPositionOf(bone: Object3D): Vector3 {
    const p = this.restPos.get(bone);
    if (!p) throw new Error(`RiderRig: ${bone.name} is not part of this rig`);
    return p;
  }

  /**
   * Compose `rest * euler(x, y, z)` into `out` without touching the bone.
   *
   * Offsets are applied in the bone's own rest frame, which is what makes the
   * animation layers additive: "pitch the chest forward 0.1" means the same
   * thing regardless of what the rest pose happens to be, and two layers that
   * both want to pitch the chest can simply add their numbers together before
   * calling this once.
   */
  composeOffset(bone: Object3D, x: number, y: number, z: number, out: Quaternion): Quaternion {
    _e.set(x, y, z, 'XYZ');
    return out.copy(this.restOf(bone)).multiply(_scratch.setFromEuler(_e));
  }

  /** Write `rest * euler(x, y, z)` straight onto the bone. */
  poseBone(bone: Object3D, x: number, y: number, z: number): void {
    this.composeOffset(bone, x, y, z, bone.quaternion);
  }

  /** Restore every bone to the rest crouch. Used on construction and teardown. */
  resetToRest(): void {
    for (const bone of this.bones) {
      bone.quaternion.copy(this.restOf(bone));
      bone.position.copy(this.restPositionOf(bone));
    }
  }
}

const _scratch = new Quaternion();
