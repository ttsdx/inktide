/**
 * Input abstraction: keyboard, gamepad and touch all collapse to one small
 * analogue state object so nothing downstream has to know where a value came
 * from — including the screenshot harness, which drives the game by writing
 * directly into `Input.scripted`.
 */

export interface ControlState {
  /** -1 (full left) .. 1 (full right) */
  steer: number;
  /** 0..1 */
  throttle: number;
  /** 0..1 */
  brake: number;
  /** Held drift/powerslide. */
  drift: boolean;
  /** Edge-triggered actions, cleared after each read. */
  boostPressed: boolean;
  resetPressed: boolean;
  cameraPressed: boolean;
  pausePressed: boolean;
  anyPressed: boolean;
}

const KEY_MAP: Record<string, keyof RawKeys> = {
  ArrowUp: 'up',
  KeyW: 'up',
  ArrowDown: 'down',
  KeyS: 'down',
  ArrowLeft: 'left',
  KeyA: 'left',
  ArrowRight: 'right',
  KeyD: 'right',
  Space: 'drift',
  ShiftLeft: 'drift',
  ShiftRight: 'drift',
  KeyR: 'reset',
  KeyC: 'camera',
  Escape: 'pause',
  Enter: 'confirm',
};

interface RawKeys {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  drift: boolean;
  reset: boolean;
  camera: boolean;
  pause: boolean;
  confirm: boolean;
}

export class Input {
  readonly state: ControlState = {
    steer: 0,
    throttle: 0,
    brake: 0,
    drift: false,
    boostPressed: false,
    resetPressed: false,
    cameraPressed: false,
    pausePressed: false,
    anyPressed: false,
  };

  /**
   * When non-null this completely overrides live input. The Playwright harness
   * sets it so a captured frame is deterministic rather than depending on
   * whatever key happened to be down.
   */
  scripted: Partial<ControlState> | null = null;

  private keys: RawKeys = {
    up: false,
    down: false,
    left: false,
    right: false,
    drift: false,
    reset: false,
    camera: false,
    pause: false,
    confirm: false,
  };
  private edge = { reset: false, camera: false, pause: false, confirm: false, any: false };

  /** Smoothed analogue steer so keyboard input is not a square wave. */
  private steerSmooth = 0;
  private throttleSmooth = 0;
  private touchSteer = 0;
  private touchThrottle = 0;
  private touchActive = false;

  private gamepadIndex: number | null = null;

  constructor(private readonly target: HTMLElement = document.body) {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    window.addEventListener('gamepadconnected', this.onGamepad);
    window.addEventListener('gamepaddisconnected', this.onGamepadLost);
    target.addEventListener('pointerdown', this.onPointerDown, { passive: false });
    target.addEventListener('pointermove', this.onPointerMove, { passive: false });
    target.addEventListener('pointerup', this.onPointerUp, { passive: false });
    target.addEventListener('pointercancel', this.onPointerUp, { passive: false });
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    const k = KEY_MAP[e.code];
    if (!k) return;
    if (!this.keys[k]) {
      if (k === 'reset') this.edge.reset = true;
      if (k === 'camera') this.edge.camera = true;
      if (k === 'pause') this.edge.pause = true;
      if (k === 'confirm') this.edge.confirm = true;
      this.edge.any = true;
    }
    this.keys[k] = true;
    if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    const k = KEY_MAP[e.code];
    if (k) this.keys[k] = false;
  };

  private onBlur = (): void => {
    for (const k of Object.keys(this.keys) as Array<keyof RawKeys>) this.keys[k] = false;
    this.touchActive = false;
    this.touchSteer = 0;
    this.touchThrottle = 0;
  };

  private onGamepad = (e: GamepadEvent): void => {
    this.gamepadIndex = e.gamepad.index;
  };

  private onGamepadLost = (): void => {
    this.gamepadIndex = null;
  };

  // --- Touch: left half steers, right half is throttle/brake -----------------
  private pointers = new Map<number, { x: number; y: number; startX: number; side: 'l' | 'r' }>();

  private onPointerDown = (e: PointerEvent): void => {
    if (e.pointerType === 'mouse') return;
    this.touchActive = true;
    this.edge.any = true;
    const side = e.clientX < window.innerWidth * 0.5 ? 'l' : 'r';
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, startX: e.clientX, side });
    this.updateTouch();
    e.preventDefault();
  };

  private onPointerMove = (e: PointerEvent): void => {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    p.x = e.clientX;
    p.y = e.clientY;
    this.updateTouch();
    e.preventDefault();
  };

  private onPointerUp = (e: PointerEvent): void => {
    this.pointers.delete(e.pointerId);
    this.updateTouch();
    if (this.pointers.size === 0) this.touchActive = false;
  };

  private updateTouch(): void {
    let steer = 0;
    let throttle = 0;
    for (const p of this.pointers.values()) {
      if (p.side === 'l') {
        steer = Math.max(-1, Math.min(1, (p.x - p.startX) / 90));
      } else {
        throttle = 1;
      }
    }
    this.touchSteer = steer;
    this.touchThrottle = throttle;
  }

  /** Sample all devices into `state`. Call once per frame before simulation. */
  update(dt: number): ControlState {
    const s = this.state;

    if (this.scripted) {
      Object.assign(s, {
        steer: 0,
        throttle: 0,
        brake: 0,
        drift: false,
        boostPressed: false,
        resetPressed: false,
        cameraPressed: false,
        pausePressed: false,
        anyPressed: false,
      });
      Object.assign(s, this.scripted);
      return s;
    }

    let steerTarget = (this.keys.right ? 1 : 0) - (this.keys.left ? 1 : 0);
    let throttleTarget = this.keys.up ? 1 : 0;
    let brake = this.keys.down ? 1 : 0;
    let drift = this.keys.drift;

    if (this.touchActive) {
      steerTarget = this.touchSteer;
      throttleTarget = Math.max(throttleTarget, this.touchThrottle);
    }

    const pad = this.gamepadIndex !== null ? navigator.getGamepads?.()[this.gamepadIndex] : null;
    if (pad) {
      const ax = pad.axes[0] ?? 0;
      if (Math.abs(ax) > 0.14) steerTarget = ax;
      const rt = pad.buttons[7]?.value ?? 0;
      const lt = pad.buttons[6]?.value ?? 0;
      if (rt > 0.03) throttleTarget = rt;
      if (lt > 0.03) brake = Math.max(brake, lt);
      if (pad.buttons[0]?.pressed) drift = true;
      if (pad.buttons[9]?.pressed) this.edge.pause = true;
    }

    // Steering ramps fast into a turn and snaps back quicker on release, which
    // is what makes keyboard steering feel like an analogue stick.
    const towards = Math.abs(steerTarget) > Math.abs(this.steerSmooth) ? 9.5 : 14.0;
    this.steerSmooth += (steerTarget - this.steerSmooth) * Math.min(1, towards * dt);
    this.throttleSmooth += (throttleTarget - this.throttleSmooth) * Math.min(1, 7.5 * dt);

    s.steer = Math.abs(this.steerSmooth) < 0.002 ? 0 : this.steerSmooth;
    s.throttle = this.throttleSmooth;
    s.brake = brake;
    s.drift = drift;
    s.resetPressed = this.edge.reset;
    s.cameraPressed = this.edge.camera;
    s.pausePressed = this.edge.pause;
    s.anyPressed = this.edge.any || this.edge.confirm;
    s.boostPressed = false;

    this.edge.reset = false;
    this.edge.camera = false;
    this.edge.pause = false;
    this.edge.confirm = false;
    this.edge.any = false;
    return s;
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    window.removeEventListener('gamepadconnected', this.onGamepad);
    window.removeEventListener('gamepaddisconnected', this.onGamepadLost);
    this.target.removeEventListener('pointerdown', this.onPointerDown);
    this.target.removeEventListener('pointermove', this.onPointerMove);
    this.target.removeEventListener('pointerup', this.onPointerUp);
    this.target.removeEventListener('pointercancel', this.onPointerUp);
  }
}
