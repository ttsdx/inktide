import type { BoatSpec, FrameContext } from '../contracts.ts';
import { BOAT_SPECS } from '../entities/hullSpec.ts';

/**
 * THE WASH — a three-stage solo time-attack on the infinite ocean.
 *
 * Sibling of `RaceDirector`, not a mutation of it. Circuit still owns laps,
 * gates and placement; this owns distance, a run seed, stage index, points
 * and the upgrade catalog. `Game` is the only module that talks to both.
 *
 * A run is exactly three stages. Completing the stated distance always clears
 * the stage. There are no lives. Points never go negative.
 */

export const ROGUE_STAGE_COUNT = 3;
/** In-world name. The title poster says ROGUE; the run itself is The Wash. */
export const ROGUE_RUN_NAME = 'THE WASH';

/** World-space origin of the corridor. Kept far from Windward Reef. */
export const ROGUE_ORIGIN_X = 4200;
export const ROGUE_ORIGIN_Z = 0;
/** Travel is +Z in world space. */
export const ROGUE_HEADING = 0;

/**
 * Playable half-width, metres. Tens of metres: a corridor, not a canal and
 * not the open sea. Soft bounds live outside this.
 */
export const ROGUE_CORRIDOR_HALF = [32, 28, 24];

/** Metres the player must cover along +Z to clear each stage. */
export const ROGUE_STAGE_LENGTH = [520, 680, 860];

/**
 * Par times, seconds. Derived from a competent ~24 / 22 / 20 m/s average
 * through rising clutter, not from a flat-out 34 m/s blast.
 */
export const ROGUE_PAR_TIME = [22, 32, 44];

/** Score orbs grant this many upgrade points each. */
export const ROGUE_ORB_POINTS = 2;

/**
 * Time payout at exactly par. Faster than par pays more, slower pays less,
 * floor is zero:
 *
 *     points = max(0, round(TIME_PAR_PAYOUT * (2 - time / par)))
 *
 * At par: 8. At 0.5× par: 12. At 2× par: 0. HUD and the upgrade screen
 * both print this formula; do not invent a second one.
 */
export const ROGUE_TIME_PAR_PAYOUT = 8;

export type RogueDirectorPhase = 'idle' | 'racing' | 'upgrade' | 'runResults';

export type RogueEvent =
  | { type: 'stageStart'; stage: number; time: number }
  | { type: 'stageClear'; stage: number; time: number; points: number }
  | { type: 'pickup'; kind: 'orb' | 'boost'; time: number }
  | { type: 'upgrade'; id: string; time: number }
  | { type: 'runComplete'; time: number };

export interface RogueUpgrade {
  readonly id: string;
  readonly name: string;
  readonly blurb: string;
  readonly cost: number;
  readonly apply: (spec: BoatSpec) => void;
}

export interface RogueStageRecord {
  stage: number;
  time: number;
  par: number;
  timePoints: number;
  orbs: number;
  orbPoints: number;
  points: number;
  length: number;
}

export interface RogueHudSnapshot {
  stage: number;
  stageCount: number;
  distance: number;
  remaining: number;
  target: number;
  stageTime: number;
  pointsThisStage: number;
  runPoints: number;
  par: number;
  orbsThisStage: number;
  orbValue: number;
  timeFormula: string;
}

export const ROGUE_CATALOG: readonly RogueUpgrade[] = [
  {
    id: 'speed',
    name: 'JET TRIM',
    blurb: 'Top speed +2.4 m/s',
    cost: 6,
    apply: (s) => {
      s.topSpeed += 2.4;
    },
  },
  {
    id: 'accel',
    name: 'INTAKE',
    blurb: 'Acceleration +2.2',
    cost: 5,
    apply: (s) => {
      s.acceleration += 2.2;
    },
  },
  {
    id: 'turn',
    name: 'RUDDER',
    blurb: 'Turn rate +0.14',
    cost: 6,
    apply: (s) => {
      s.turnRate += 0.14;
    },
  },
  {
    id: 'boostCharge',
    name: 'DRIFT COIL',
    blurb: 'Boost charges 40% faster',
    cost: 7,
    apply: (s) => {
      s.boostChargeMul = (s.boostChargeMul ?? 1) * 1.4;
    },
  },
  {
    id: 'boostWindow',
    name: 'AFTERBURN',
    blurb: 'Boost window +30%',
    cost: 7,
    apply: (s) => {
      s.boostWindowMul = (s.boostWindowMul ?? 1) * 1.3;
    },
  },
  {
    id: 'hull',
    name: 'KEEL PLATE',
    blurb: 'Heavier hull, quicker recovery',
    cost: 5,
    apply: (s) => {
      s.mass += 45;
      s.stunMul = (s.stunMul ?? 1) * 0.55;
    },
  },
  {
    id: 'magnet',
    name: 'TIDE HOOK',
    blurb: 'Pickup magnet +5 m',
    cost: 4,
    apply: (s) => {
      s.magnetRadius = (s.magnetRadius ?? 0) + 5;
    },
  },
  {
    id: 'grip',
    name: 'SPONSON',
    blurb: 'Less slide, tighter line',
    cost: 5,
    apply: (s) => {
      s.slidiness = Math.max(0.16, s.slidiness - 0.12);
    },
  },
];

export function cloneStockSpec(): BoatSpec {
  return { ...BOAT_SPECS[0] };
}

export function timePointsFor(time: number, par: number): number {
  if (!(par > 0) || !(time >= 0)) return 0;
  return Math.max(0, Math.round(ROGUE_TIME_PAR_PAYOUT * (2 - time / par)));
}

export function timeFormulaLabel(): string {
  return `PTS = MAX(0, ROUND(${ROGUE_TIME_PAR_PAYOUT} × (2 − T / PAR)))`;
}

export class RogueDirector {
  phase: RogueDirectorPhase = 'idle';
  stage = 0;
  seed = 1;
  runPoints = 0;
  stageOrbs = 0;
  stageTime = 0;
  distance = 0;
  readonly records: RogueStageRecord[] = [];
  readonly owned = new Set<string>();
  spec: BoatSpec = cloneStockSpec();
  onEvent: ((e: RogueEvent) => void) | null = null;

  private phaseTime = 0;
  private originZ = ROGUE_ORIGIN_Z;

  get target(): number {
    return ROGUE_STAGE_LENGTH[this.stage] ?? ROGUE_STAGE_LENGTH[2];
  }

  get par(): number {
    return ROGUE_PAR_TIME[this.stage] ?? ROGUE_PAR_TIME[2];
  }

  get corridorHalf(): number {
    return ROGUE_CORRIDOR_HALF[this.stage] ?? ROGUE_CORRIDOR_HALF[2];
  }

  get remaining(): number {
    return Math.max(0, this.target - this.distance);
  }

  get pointsThisStage(): number {
    return timePointsFor(this.stageTime, this.par) + this.stageOrbs * ROGUE_ORB_POINTS;
  }

  /** Confirmed orb score only — live time payout is not earned until the line. */
  get orbPointsThisStage(): number {
    return this.stageOrbs * ROGUE_ORB_POINTS;
  }

  /** Begin a fresh run from stock Vermillion. */
  startRun(seed: number): void {
    this.seed = seed >>> 0 || 1;
    this.stage = 0;
    this.runPoints = 0;
    this.records.length = 0;
    this.owned.clear();
    this.spec = cloneStockSpec();
    this.beginStage();
  }

  /** Restart the current stage only. Upgrades and prior records stay. */
  restartStage(): void {
    this.beginStage();
  }

  beginStage(): void {
    this.phase = 'racing';
    this.phaseTime = 0;
    this.stageTime = 0;
    this.stageOrbs = 0;
    this.distance = 0;
    this.originZ = ROGUE_ORIGIN_Z;
    this.emit({ type: 'stageStart', stage: this.stage, time: 0 });
  }

  collectOrb(): void {
    if (this.phase !== 'racing') return;
    this.stageOrbs += 1;
    this.emit({ type: 'pickup', kind: 'orb', time: this.stageTime });
  }

  collectBoost(): void {
    if (this.phase !== 'racing') return;
    this.emit({ type: 'pickup', kind: 'boost', time: this.stageTime });
  }

  canAfford(id: string): boolean {
    const item = ROGUE_CATALOG.find((u) => u.id === id);
    if (!item) return false;
    if (this.owned.has(id)) return false;
    return this.runPoints >= item.cost;
  }

  buy(id: string): boolean {
    if (this.phase !== 'upgrade') return false;
    const item = ROGUE_CATALOG.find((u) => u.id === id);
    if (!item || this.owned.has(id) || this.runPoints < item.cost) return false;
    this.runPoints -= item.cost;
    this.owned.add(id);
    item.apply(this.spec);
    this.emit({ type: 'upgrade', id, time: this.phaseTime });
    return true;
  }

  /**
   * Leave the shop and start the next stage. After stage 3 this is a no-op;
   * `clearStage` already opened run results.
   */
  continueRun(): void {
    if (this.phase !== 'upgrade') return;
    if (this.stage >= ROGUE_STAGE_COUNT - 1) return;
    this.stage += 1;
    this.beginStage();
  }

  update(playerZ: number, ctx: FrameContext): void {
    this.phaseTime += ctx.dt;
    if (this.phase !== 'racing') return;
    this.stageTime += ctx.dt;
    this.distance = Math.max(0, playerZ - this.originZ);
    if (this.distance >= this.target) this.clearStage();
  }

  hud(): RogueHudSnapshot {
    return {
      stage: this.stage + 1,
      stageCount: ROGUE_STAGE_COUNT,
      distance: this.distance,
      remaining: this.remaining,
      target: this.target,
      stageTime: this.stageTime,
      pointsThisStage: this.orbPointsThisStage,
      runPoints: this.runPoints,
      par: this.par,
      orbsThisStage: this.stageOrbs,
      orbValue: ROGUE_ORB_POINTS,
      timeFormula: timeFormulaLabel(),
    };
  }

  verdict(): string {
    const total = this.records.reduce((s, r) => s + r.time, 0);
    const par = this.records.reduce((s, r) => s + r.par, 0);
    if (this.records.length < ROGUE_STAGE_COUNT) return 'RUN CUT SHORT';
    if (total <= par * 0.92) return 'TIDE WALKER';
    if (total <= par) return 'CLEAN WASH';
    if (total <= par * 1.2) return 'THROUGH THE SQUALL';
    return 'BEAT THE SEA';
  }

  private clearStage(): void {
    if (this.phase !== 'racing') return;
    const rec: RogueStageRecord = {
      stage: this.stage,
      time: this.stageTime,
      par: this.par,
      timePoints: timePointsFor(this.stageTime, this.par),
      orbs: this.stageOrbs,
      orbPoints: this.stageOrbs * ROGUE_ORB_POINTS,
      points: 0,
      length: this.target,
    };
    rec.points = rec.timePoints + rec.orbPoints;
    this.records.push(rec);
    this.runPoints += rec.points;
    this.emit({ type: 'stageClear', stage: this.stage, time: this.stageTime, points: rec.points });

    if (this.stage >= ROGUE_STAGE_COUNT - 1) {
      this.phase = 'runResults';
      this.phaseTime = 0;
      this.emit({ type: 'runComplete', time: this.stageTime });
    } else {
      this.phase = 'upgrade';
      this.phaseTime = 0;
    }
  }

  private emit(e: RogueEvent): void {
    this.onEvent?.(e);
  }
}
