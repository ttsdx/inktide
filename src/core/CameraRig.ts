import { MathUtils, PerspectiveCamera, Quaternion, Vector3 } from 'three';

/**
 * CAMERA
 *
 * A critically-damped spring chase cam with speed-driven FOV, impact shake and
 * a set of cinematic modes for the countdown, the results screen and the
 * screenshot harness.
 *
 * The spring is integrated with an exact analytic solution rather than an Euler
 * step, so its behaviour does not change with frame rate — at 30 fps and at
 * 144 fps the camera lags by exactly the same amount of *time*. A lerp-based
 * chase cam fails this and feels different on every machine.
 */

export type CameraMode = 'chase' | 'orbit' | 'onboard' | 'heli' | 'flyby' | 'free' | 'results';

export interface ChaseTarget {
  position: Vector3;
  /** Forward direction of the boat (unit, world space). */
  forward: Vector3;
  /** Boat up vector, so the camera rolls slightly with the hull. */
  up: Vector3;
  /** Speed in m/s, drives FOV kick and camera distance. */
  speed: number;
  /** 0..1 how hard the boat is drifting; swings the camera wide. */
  drift: number;
  /** Signed lateral slip, used to lead the camera into the slide. */
  slip: number;
  /** True while airborne. */
  airborne: boolean;
}

interface Spring3 {
  value: Vector3;
  velocity: Vector3;
}

function springStep(s: Spring3, target: Vector3, omega: number, dt: number): void {
  // Critically damped analytic solution (Game Programming Gems 4, "Critically
  // Damped Ease-In/Ease-Out Smoothing").
  const exp = Math.exp(-omega * dt);
  _t1.subVectors(s.value, target);
  _t2.copy(s.velocity).addScaledVector(_t1, omega).multiplyScalar(dt);
  s.velocity.sub(_t2.clone().multiplyScalar(omega)).multiplyScalar(exp);
  s.value.copy(target).add(_t1.add(_t2).multiplyScalar(exp));
}

const _t1 = new Vector3();
const _t2 = new Vector3();
const _desired = new Vector3();
const _lookAt = new Vector3();
const _tmp = new Vector3();
const _q = new Quaternion();

export interface CameraTuning {
  /** Distance behind the boat at rest. */
  distance: number;
  /** Extra distance at top speed. */
  distanceSpeedGain: number;
  height: number;
  /** How far ahead of the boat the camera looks. */
  lookAhead: number;
  fovBase: number;
  fovSpeedGain: number;
  /** Spring frequency for position; higher = tighter. */
  posOmega: number;
  /** Spring frequency for the look target. */
  lookOmega: number;
}

/**
 * Chase tuning.
 *
 * `posOmega` is the number that matters and it is not a free choice: a
 * critically-damped spring tracking a target moving at v settles with a steady
 * lag of v/omega. At 34 m/s and omega 6.2 that is 5.5 m of permanent lag on top
 * of the nominal distance, and measurement showed it drifting out past 25 m as
 * the boat kept accelerating — far enough that the boat became a speck. At 9.5
 * the lag is 3.6 m, which still reads as weight without losing the subject.
 *
 * `fovSpeedGain` was similarly overdrawn: 15 degrees on top of 57 put the
 * camera at 72 degrees flat out, which is a fisheye. It shrinks everything in
 * frame at exactly the moment the player most needs to read the boat's
 * attitude. 9 degrees still gives the speed rush.
 */
export const DEFAULT_TUNING: CameraTuning = {
  distance: 10.2,
  distanceSpeedGain: 2.4,
  height: 3.9,
  lookAhead: 8.0,
  fovBase: 56,
  fovSpeedGain: 9,
  posOmega: 9.5,
  lookOmega: 11.0,
};

export class CameraRig {
  readonly camera: PerspectiveCamera;
  tuning: CameraTuning = { ...DEFAULT_TUNING };
  mode: CameraMode = 'chase';

  /** Orbit/flyby parameters, also used by the screenshot harness. */
  orbitCenter = new Vector3();
  orbitRadius = 26;
  orbitHeight = 9;
  orbitAngle = 0;
  orbitSpeed = 0.22;

  /** Free-camera state, used by the harness for fixed angles. */
  freePosition = new Vector3(0, 12, 30);
  freeTarget = new Vector3(0, 0, 0);

  private posSpring: Spring3 = { value: new Vector3(0, 6, 20), velocity: new Vector3() };
  private lookSpring: Spring3 = { value: new Vector3(), velocity: new Vector3() };
  private fov: number;
  private roll = 0;
  private shakeAmount = 0;
  private shakeTime = 0;
  private shakeFreq = 24;

  constructor(camera: PerspectiveCamera) {
    this.camera = camera;
    this.fov = this.tuning.fovBase;
  }

  /** Kick the camera. `amount` is roughly metres of displacement at the peak. */
  shake(amount: number, freq = 24): void {
    this.shakeAmount = Math.max(this.shakeAmount, amount);
    this.shakeFreq = freq;
    this.shakeTime = 0;
  }

  /** Snap the springs so the camera does not fly in from the last position. */
  snapTo(target: ChaseTarget): void {
    this.computeDesired(target, _desired, _lookAt);
    this.posSpring.value.copy(_desired);
    this.posSpring.velocity.set(0, 0, 0);
    this.lookSpring.value.copy(_lookAt);
    this.lookSpring.velocity.set(0, 0, 0);
    this.camera.position.copy(_desired);
    this.camera.lookAt(_lookAt);
  }

  private computeDesired(t: ChaseTarget, outPos: Vector3, outLook: Vector3): void {
    const tu = this.tuning;
    const speedT = MathUtils.clamp(t.speed / 34, 0, 1.35);

    // Sit behind the boat's *heading*, but blend towards its velocity direction
    // when drifting so a powerslide shows the boat's flank instead of hiding it.
    _tmp.copy(t.forward);
    const dist = tu.distance + tu.distanceSpeedGain * speedT;
    const driftSwing = t.drift * 0.42 + MathUtils.clamp(t.slip * 0.06, -0.5, 0.5);

    outPos.copy(t.position);
    outPos.addScaledVector(_tmp, -dist);
    // Swing sideways into the slide.
    outPos.x += -_tmp.z * driftSwing * 4.2;
    outPos.z += _tmp.x * driftSwing * 4.2;
    outPos.y += tu.height + speedT * 0.9 + (t.airborne ? 1.3 : 0);

    outLook.copy(t.position);
    outLook.addScaledVector(_tmp, tu.lookAhead * (0.6 + speedT * 0.7));
    outLook.y += 1.5;
  }

  update(dt: number, target: ChaseTarget | null, elapsed: number): void {
    const tu = this.tuning;

    switch (this.mode) {
      case 'chase': {
        if (!target) break;
        this.computeDesired(target, _desired, _lookAt);
        springStep(this.posSpring, _desired, tu.posOmega, dt);
        springStep(this.lookSpring, _lookAt, tu.lookOmega, dt);
        this.camera.position.copy(this.posSpring.value);
        this.camera.lookAt(this.lookSpring.value);

        // Roll: a fraction of the boat's own roll, plus a lean into the drift.
        const boatRoll = Math.asin(MathUtils.clamp(-target.up.x, -1, 1));
        const targetRoll = boatRoll * 0.32 + target.slip * -0.012;
        this.roll += (targetRoll - this.roll) * Math.min(1, 4.5 * dt);
        this.camera.rotateZ(this.roll);

        const speedT = MathUtils.clamp(target.speed / 34, 0, 1.4);
        const targetFov = tu.fovBase + tu.fovSpeedGain * speedT * speedT;
        this.fov += (targetFov - this.fov) * Math.min(1, 3.2 * dt);
        break;
      }

      case 'onboard': {
        if (!target) break;
        // Sat behind and just above the rider's head, not on the bow. Placing
        // the eye ahead of the cockpit shows nothing but water and throws away
        // the two things that make a bow camera worth having: the hull pitching
        // against the horizon, and the rider working in front of you.
        _tmp.copy(target.forward);
        this.camera.position
          .copy(target.position)
          .addScaledVector(_tmp, -1.55)
          .addScaledVector(target.up, 1.95);
        _lookAt.copy(target.position).addScaledVector(_tmp, 20).setY(target.position.y + 2.4);
        this.camera.lookAt(_lookAt);
        const speedT = MathUtils.clamp(target.speed / 34, 0, 1.4);
        this.fov += (tu.fovBase + 8 + 18 * speedT * speedT - this.fov) * Math.min(1, 4 * dt);
        break;
      }

      case 'orbit':
      case 'results': {
        this.orbitAngle += this.orbitSpeed * dt;
        const c = this.orbitCenter;
        this.camera.position.set(
          c.x + Math.cos(this.orbitAngle) * this.orbitRadius,
          c.y + this.orbitHeight,
          c.z + Math.sin(this.orbitAngle) * this.orbitRadius,
        );
        this.camera.lookAt(c);
        this.fov += (tu.fovBase - 6 - this.fov) * Math.min(1, 3 * dt);
        this.roll *= 1 - Math.min(1, 4 * dt);
        break;
      }

      case 'heli': {
        if (!target) break;
        _tmp.copy(target.forward);
        this.camera.position
          .copy(target.position)
          .addScaledVector(_tmp, -26)
          .add(new Vector3(0, 19, 0));
        this.camera.lookAt(target.position);
        this.fov += (tu.fovBase - 4 - this.fov) * Math.min(1, 3 * dt);
        break;
      }

      case 'flyby': {
        if (!target) break;
        // A low, fast pass across the boat's path — used for the countdown.
        const a = elapsed * 0.55;
        this.camera.position.set(
          target.position.x + Math.cos(a) * 17,
          target.position.y + 2.6 + Math.sin(a * 1.7) * 1.1,
          target.position.z + Math.sin(a) * 17,
        );
        this.camera.lookAt(target.position.x, target.position.y + 1.1, target.position.z);
        this.fov += (tu.fovBase + 4 - this.fov) * Math.min(1, 3 * dt);
        break;
      }

      case 'free': {
        this.camera.position.copy(this.freePosition);
        this.camera.lookAt(this.freeTarget);
        this.fov += (tu.fovBase - this.fov) * Math.min(1, 6 * dt);
        break;
      }
    }

    // --- shake -------------------------------------------------------------
    if (this.shakeAmount > 0.0005) {
      this.shakeTime += dt;
      // Decaying multi-frequency wobble; two incommensurate frequencies stop it
      // reading as a sine wave.
      const decay = Math.exp(-this.shakeTime * 6.5);
      const a = this.shakeAmount * decay;
      const s1 = Math.sin(this.shakeTime * this.shakeFreq);
      const s2 = Math.sin(this.shakeTime * this.shakeFreq * 1.63 + 1.1);
      const s3 = Math.sin(this.shakeTime * this.shakeFreq * 0.71 + 2.3);
      this.camera.position.x += s1 * a * 0.5;
      this.camera.position.y += s2 * a * 0.62;
      this.camera.position.z += s3 * a * 0.36;
      this.camera.rotateZ(s2 * a * 0.02);
      this.shakeAmount *= Math.exp(-dt * 4.2);
      if (decay < 0.02) this.shakeAmount = 0;
    }

    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }

  /** Immediately set a fixed camera (harness / debugging). */
  setFree(position: Vector3, target: Vector3): void {
    this.mode = 'free';
    this.freePosition.copy(position);
    this.freeTarget.copy(target);
    this.camera.position.copy(position);
    this.camera.lookAt(target);
  }
}
