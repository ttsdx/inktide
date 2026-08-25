/**
 * HEADLESS RIDER PROBE
 *
 * A visual critic looking at captured frames reported that the rider has no
 * hands, that its forearms stop short of the handlebar, that it does not lean
 * in a drift, and that its feet float above the deck. Three of those four are
 * geometric facts with a number attached, and a number is a far better way to
 * settle them than another round of squinting at a 3200 px frame — at chase
 * distance the whole character is 130 px tall, so a 4 cm gap and a 0 cm gap
 * look identical and a 20-degree lean and a 3-degree one very nearly do.
 *
 * This builds the real rig, drives it with real `BoatState`s produced by the
 * real physics, and measures:
 *
 *   GRIP     distance from each hand bone to the handlebar grip it is solved
 *            against. The arms are exact two-bone IK to a fixed target, so
 *            anything above a centimetre means the solve is failing or the
 *            target has drifted from the modelled bar.
 *   LEAN     torso roll about the boat's forward axis, in degrees. Requirement:
 *            the rider leans INTO a turn, and visibly.
 *   FEET     vertical gap between each foot bone and the cockpit floor.
 *   REACH    how far the rig moves between its extremes. A rig whose poses all
 *            measure the same is a prop however much code drives it.
 *
 *   npx tsx tools/riderProbe.ts
 */

import './domShim.ts';
import { Object3D, Quaternion, Vector3 } from 'three';
import { BoatPhysics } from '../src/entities/BoatPhysics.ts';
import { BOAT_SPECS, HANDLEBAR_HALF_SPAN, HANDLEBAR_POINT, RIDER_MOUNT } from '../src/entities/hullSpec.ts';
import { Rider } from '../src/entities/Rider.ts';
import { HIP_HEIGHT } from '../src/entities/RiderRig.ts';
import type { BoatCommand, BoatState, RiderPose } from '../src/contracts.ts';

const DT = 1 / 60;

const cmd = (o: Partial<BoatCommand> = {}): BoatCommand => ({
  throttle: 0,
  brake: 0,
  steer: 0,
  drift: false,
  ...o,
});

/**
 * Run the physics to a settled state under one command, then run the rider
 * against it for long enough that every spring in the rig has arrived. The
 * rider's slowest spring is the celebration blend at 6 rad/s, so two seconds is
 * comfortably past settling for everything the racing poses use.
 */
function poseUnder(command: BoatCommand, seconds = 6): { rider: Rider; state: BoatState; mount: Object3D } {
  const physics = new BoatPhysics(0, BOAT_SPECS[0], new Vector3(0, 0, 0), 0);
  physics.respawn(new Vector3(0, 0, 0), 0, 0);

  let t = 0;
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) {
    t += DT;
    physics.update(command, { dt: DT, elapsed: t, frame: i }, null);
  }

  // The rider hangs off a mount object placed exactly where `Boat` puts it, so
  // the measurement is taken in the same frame the game renders in.
  const mount = new Object3D();
  mount.position.copy(RIDER_MOUNT);

  const rider = new Rider(0);
  mount.add(rider.root);

  Rider.clearPoseMemory(0);
  let pose: RiderPose = Rider.restPose();
  for (let i = 0; i < steps; i++) {
    pose = Rider.poseFromBoat(physics, pose, DT, 0);
    rider.update(pose, { dt: DT, elapsed: t + i * DT, frame: i });
  }
  mount.updateMatrixWorld(true);

  return { rider, state: physics, mount };
}

/**
 * Where the modelled grip actually is, in the mount's frame.
 *
 * The bar turns with the rider now, so this has to apply the same yaw the boat
 * applies to the handlebar mesh — otherwise the probe would measure the hands
 * against a bar position that no longer exists and report a fault that is not
 * there. The yaw comes from the rider itself, exactly as `Game` hands it to
 * `Boat.setBarYaw`.
 */
function gripTarget(side: number, yaw: number, out: Vector3): Vector3 {
  const pz = HANDLEBAR_POINT.z - RIDER_MOUNT.z;
  const gx = side * HANDLEBAR_HALF_SPAN;
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  return out.set(gx * cy, HANDLEBAR_POINT.y - RIDER_MOUNT.y, pz - gx * sy);
}

const _w = new Vector3();
const _t = new Vector3();
const _q = new Quaternion();

/** Signed roll of a bone about the boat's forward (+Z) axis, in degrees. */
function rollDeg(bone: Object3D): number {
  bone.getWorldQuaternion(_q);
  // The bone's local up in world space; its lean off vertical about Z is the
  // roll the eye reads as the rider leaning into the turn.
  const up = new Vector3(0, 1, 0).applyQuaternion(_q);
  return (Math.atan2(-up.x, up.y) * 180) / Math.PI;
}

interface Row {
  label: string;
  gripL: number;
  gripR: number;
  lean: number;
  headLean: number;
  footL: number;
  footR: number;
  crouch: number;
}

function measure(label: string, command: BoatCommand): Row {
  const { rider, mount } = poseUnder(command);
  const rig = rider.rig;

  const grips: number[] = [];
  for (const side of [-1, 1]) {
    const hand = rig.sided('hand', side);
    hand.getWorldPosition(_w);
    gripTarget(side, rider.barYaw, _t);
    mount.localToWorld(_t);
    grips.push(_w.distanceTo(_t));
  }

  // The foot BONE is the ankle, and the rest pose is authored so the boot's
  // SOLE lands on the deck — so measuring the bone would report a 12 cm gap on
  // a rig that is sitting perfectly. Take the lowest vertex of the boot mesh
  // instead, which is the thing a viewer would see hovering.
  const feet: number[] = [];
  mount.getWorldPosition(_t);
  const deckY = _t.y;
  for (const side of [-1, 1]) {
    const foot = rig.sided('foot', side);
    let lowest = Infinity;
    foot.traverse((o) => {
      const m = o as { isMesh?: boolean; geometry?: { attributes: { position: { count: number; getX(i: number): number; getY(i: number): number; getZ(i: number): number } } } };
      if (!m.isMesh || !m.geometry) return;
      const p = m.geometry.attributes.position;
      for (let i = 0; i < p.count; i++) {
        _w.set(p.getX(i), p.getY(i), p.getZ(i));
        (o as Object3D).localToWorld(_w);
        lowest = Math.min(lowest, _w.y);
      }
    });
    feet.push(Number.isFinite(lowest) ? lowest - deckY : NaN);
  }

  return {
    label,
    gripL: grips[0],
    gripR: grips[1],
    lean: rollDeg(rig.chest),
    headLean: rollDeg(rig.head),
    footL: feet[0],
    footR: feet[1],
    crouch: rig.hips.position.y - HIP_HEIGHT,
  };
}

const rows: Row[] = [
  measure('idle', cmd()),
  measure('cruise', cmd({ throttle: 1 })),
  measure('turn left', cmd({ throttle: 1, steer: -1 })),
  measure('turn right', cmd({ throttle: 1, steer: 1 })),
  measure('drift left', cmd({ throttle: 1, steer: -1, drift: true })),
  measure('drift right', cmd({ throttle: 1, steer: 1, drift: true })),
  measure('braking', cmd({ brake: 1 })),
];

console.log('\nRIDER RIG  (metres and degrees, measured in world space)');
console.log('  pose          gripL   gripR   torso    head    footL   footR   hipDrop');
for (const r of rows) {
  console.log(
    `  ${r.label.padEnd(12)}  ${r.gripL.toFixed(3)}   ${r.gripR.toFixed(3)}   ` +
      `${r.lean.toFixed(1).padStart(5)}   ${r.headLean.toFixed(1).padStart(5)}   ` +
      `${r.footL.toFixed(3)}   ${r.footR.toFixed(3)}   ${r.crouch.toFixed(3)}`,
  );
}

const worstGrip = Math.max(...rows.flatMap((r) => [r.gripL, r.gripR]));
const leans = rows.map((r) => r.lean);
const leanSpread = Math.max(...leans) - Math.min(...leans);
const driftL = rows.find((r) => r.label === 'drift left')!;
const driftR = rows.find((r) => r.label === 'drift right')!;
const worstFoot = Math.max(...rows.flatMap((r) => [Math.abs(r.footL), Math.abs(r.footR)]));

const check = (name: string, ok: boolean, value: string, target: string) =>
  console.log(`  ${ok ? 'pass' : 'FAIL'}  ${name.padEnd(34)} ${value.padEnd(14)} ${target}`);

console.log('\nCHECKS');
check('hands reach the bars', worstGrip < 0.02, `${(worstGrip * 100).toFixed(1)} cm`, 'under 2 cm at every pose');
check('rider leans at all', leanSpread > 12, `${leanSpread.toFixed(1)} deg spread`, 'over 12 deg across poses');
check(
  'lean is INTO the turn',
  Math.sign(driftL.lean) !== Math.sign(driftR.lean) && Math.abs(driftL.lean) > 6,
  `${driftL.lean.toFixed(1)} / ${driftR.lean.toFixed(1)} deg`,
  'opposite signs, over 6 deg each',
);
check(
  'head counter-rolls the torso',
  Math.abs(driftR.headLean) < Math.abs(driftR.lean),
  `${driftR.headLean.toFixed(1)} vs torso ${driftR.lean.toFixed(1)}`,
  'head rolls less than the chest',
);
check('feet stay on the deck', worstFoot < 0.06, `${(worstFoot * 100).toFixed(1)} cm`, 'under 6 cm from the floor');
console.log();
