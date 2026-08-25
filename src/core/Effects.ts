import { Color } from 'three';
import type { EffectsBus, SprayRequest } from '../contracts.ts';

/**
 * The effects bus.
 *
 * Gameplay systems request effects; they never reach into the spray pool, the
 * post chain or the camera. That indirection is what lets the boat physics stay
 * a pure simulation module with no rendering dependencies, and it means the
 * screenshot harness can swap in a null bus to capture a frame with no
 * particles when it wants to isolate the water.
 */
export class Effects implements EffectsBus {
  /** Bound by Game once the spray system exists. */
  spraySink: ((req: SprayRequest) => void) | null = null;
  flashSink: ((color: Color, strength: number) => void) | null = null;
  shakeSink: ((amount: number, freq?: number) => void) | null = null;

  /**
   * Effect requests are rate-limited per source kind. Physics runs substepped
   * and can legitimately fire three landing impacts inside one frame; without
   * this the camera shake stacks into a seizure and the spray pool empties.
   */
  private lastFlash = -1;
  private lastShake = -1;
  private now = 0;

  tick(elapsed: number): void {
    this.now = elapsed;
  }

  spray(req: SprayRequest): void {
    this.spraySink?.(req);
  }

  flash(color: Color, strength: number): void {
    if (this.now - this.lastFlash < 0.08) return;
    this.lastFlash = this.now;
    this.flashSink?.(color, strength);
  }

  shake(amount: number, freq = 24): void {
    if (this.now - this.lastShake < 0.05) return;
    this.lastShake = this.now;
    this.shakeSink?.(amount, freq);
  }
}

/** A bus that swallows everything, for headless simulation and isolation shots. */
export const NULL_EFFECTS: EffectsBus = {
  spray: () => {},
  flash: () => {},
  shake: () => {},
};
