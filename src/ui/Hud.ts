import type { BoatState, FrameContext, RacePhase, RacerProgress } from '../contracts.ts';
import { CSS } from '../core/Palette.ts';
import { Minimap, type MinimapBlip, type MinimapGate, type MinimapPoint } from './Minimap.ts';
import {
  approach,
  clamp,
  clamp01,
  chevron,
  drawText,
  formatDelta,
  formatTime,
  hatch,
  measureText,
  ordinalSuffix,
  panel,
  panelPath,
  Punch,
  racerColor,
  range01,
  segmentedArc,
  segmentedBar,
  Spring1,
  triangle,
  type Ctx2D,
} from './hudPrimitives.ts';

/**
 * HUD
 *
 * One 2D canvas over the scene, redrawn from scratch every frame.
 *
 * Redrawing everything is not a compromise. The HUD has an animating value in
 * almost every element (a lagging needle, a breathing gate, a blinking banner),
 * so a dirty-rect scheme would end up invalidating the whole surface anyway
 * while costing a pile of bookkeeping. A full clear plus ~600 path ops is well
 * under a millisecond and, unlike a DOM tree, it cannot trigger layout on the
 * frame the window is resized.
 *
 * Layout is expressed in CSS pixels and multiplied by one `u` scale factor
 * derived from the viewport, then the whole context is pre-scaled by the device
 * pixel ratio. So the code below never thinks about retina at all, and every
 * size in it is a real on-screen size at 1600x900.
 *
 * Screen regions, kept deliberately disjoint so nothing ever needs a collision
 * rule at odd aspect ratios:
 *
 *     +----------------------------------------------------------+
 *     | POS | LAP                                      [ MINIMAP ]|
 *     | splits                                                    |
 *     | delta            WRONG WAY  /  3 2 1 GO!                   |
 *     |                  <<<   corner preview   >>>                |
 *     |                                                            |
 *     | BOOST ##########                          ( SPEEDO arc )   |
 *     +----------------------------------------------------------+
 */

// ---------------------------------------------------------------------------
// Data contract
// ---------------------------------------------------------------------------

/** Pre-sampled course geometry. The HUD never touches the spline itself. */
export interface HudCourse {
  /** Centreline in world XZ, in travel order, treated as a closed loop. */
  points: readonly MinimapPoint[];
  /** Checkpoint gates, in order. `nx/nz` is the gate axis in world XZ. */
  gates?: readonly MinimapGate[];
  /** Start/finish line. Defaults to `gates[0]`. */
  startLine?: MinimapGate;
}

/** The approaching corner, as measured by whoever owns the racing line. */
export interface HudCorner {
  /** 0..1 how hard it is. Below ~0.25 the HUD stays quiet. */
  severity: number;
  /** -1 for a left-hander, 1 for a right-hander. */
  direction: number;
}

/**
 * Everything the HUD needs for one frame.
 *
 * Almost all of it is optional, and anything derivable is derived here rather
 * than demanded from the caller: lap times, best lap, deltas and the position
 * ordinal all come out of `RacerProgress`, so the race system does not have to
 * keep a parallel set of display fields in sync.
 */
export interface HudData {
  phase: RacePhase;
  /** The player's boat. Null before the grid is built; the HUD then draws zeros. */
  player: BoatState | null;
  /** Every boat, for the minimap. */
  boats?: readonly BoatState[];
  /** Progress rows for every racer, any order. */
  progress?: readonly RacerProgress[];
  /** The player's row. Located by `boatId === player.id` when omitted. */
  playerProgress?: RacerProgress | null;
  totalLaps?: number;
  /**
   * The countdown reading. Either seconds remaining or an integer beat index
   * (3, 2, 1) — the HUD only takes `ceil()` of it for the glyph and times its own
   * animation from the moment that integer changes, so both conventions look the
   * same on screen.
   */
  countdown?: number;
  /** Current (in-progress) lap time. Derived from progress when omitted. */
  currentLapTime?: number;
  lastLapTime?: number;
  bestLapTime?: number;
  wrongWay?: boolean;
  course?: HudCourse | null;
  corner?: HudCorner | null;
  /** Speedometer full-scale in m/s. Defaults to the player's spec top speed. */
  topSpeed?: number;
  paused?: boolean;
  /** Live frame budget. Only set when the game is started with `?perf=1`. */
  perf?: HudPerf | null;
}

export interface HudPerf {
  fps: number;
  draws: number;
  tris: number;
  tier: string;
  pixelRatio: number;
}

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** Speedometer arc, in canvas radians (0 = +x, sweeping clockwise on screen). */
const ARC_START = (202 * Math.PI) / 180;
const ARC_END = (338 * Math.PI) / 180;
const SPEEDO_SEGMENTS = 26;
const BOOST_SEGMENTS = 12;
/** How long a lap delta stays on screen. */
const DELTA_LIFE = 3.6;
/** How long "GO!" holds after the countdown expires. */
const GO_HOLD = 1.05;

export class Hud {
  readonly canvas: HTMLCanvasElement;
  private readonly c: Ctx2D | null;
  private readonly container: HTMLElement;
  private readonly minimap = new Minimap();

  /** CSS-pixel viewport size and the scale every layout number is multiplied by. */
  private w = 1;
  private h = 1;
  private u = 1;
  private dpr = 1;

  // --- animation state ------------------------------------------------------

  /**
   * Speed shown by the gauge. Underdamped, so a throttle stab overshoots and
   * settles: the instrument has to feel like it has a mass on the end of it,
   * otherwise it is just the physics number reprinted at 60 Hz. It also means
   * the digits keep moving for a moment after a collision, which reads as the
   * boat losing speed rather than the number being edited.
   */
  private speedSpring = new Spring1(10.5, 0.52);
  /** Cluster entry animation. Overshoots slightly, hence the spring. */
  private entrySpring = new Spring1(8.5, 0.72);
  private boostSmooth = 0;

  private posPunch = new Punch(9, 24);
  private lapPunch = new Punch(8, 19);
  private countPunch = new Punch(6.5, 15);
  private boostFullPunch = new Punch(5, 13);

  private prevPosition = 0;
  private prevLapCount = -1;
  private prevCountdownStep = -1;
  /** Seconds since the countdown digit last changed, which drives the beat wipe. */
  private countdownAge = 99;
  private sawCountdown = false;
  private prevBoostFull = false;
  /** Last frame's clamped delta, so sub-draws can animate without re-plumbing. */
  private dt = 1 / 60;

  private deltaText = '';
  private deltaLabel = '';
  private deltaColor: string = CSS.foam;
  private deltaAge = DELTA_LIFE + 1;

  private goTimer = GO_HOLD + 1;
  private blink = 0;
  private disposed = false;

  private readonly onResize = (): void => this.resize();

  constructor(container: HTMLElement) {
    this.container = container;
    this.canvas = document.createElement('canvas');
    this.canvas.id = 'hud-canvas';
    // The parent `#hud` is already `pointer-events: none`, but the HUD canvas
    // says so itself too: it must never eat a click meant for the results screen
    // regardless of where it ends up being mounted.
    this.canvas.style.cssText =
      'position:absolute;left:0;top:0;pointer-events:none;display:block;';
    container.appendChild(this.canvas);

    // A missing 2D context is survivable (some headless configurations refuse
    // one). Everything downstream checks `this.c` and turns into a no-op.
    this.c = this.canvas.getContext('2d', { alpha: true });
    window.addEventListener('resize', this.onResize);
    this.resize();
  }

  /** Re-size the backing store to the viewport. Safe to call every frame. */
  resize(): void {
    if (this.disposed) return;
    // Capped at 2: past that the HUD is redrawing four times the pixels for a
    // difference nobody can see, on the same frame budget as the ocean.
    this.dpr = clamp(window.devicePixelRatio || 1, 1, 2);
    this.w = Math.max(1, window.innerWidth);
    this.h = Math.max(1, window.innerHeight);
    const pw = Math.round(this.w * this.dpr);
    const ph = Math.round(this.h * this.dpr);
    if (this.canvas.width !== pw || this.canvas.height !== ph) {
      this.canvas.width = pw;
      this.canvas.height = ph;
    }
    this.canvas.style.width = `${this.w}px`;
    this.canvas.style.height = `${this.h}px`;
    // One scale factor for the whole UI rather than per-element clamping: the
    // composition stays identical at every window size, which is the only way
    // the hand-placed clusters keep their spacing.
    this.u = clamp(Math.min(this.w / 1600, this.h / 900), 0.62, 1.5);
  }

  update(data: HudData, ctx: FrameContext): void {
    const c = this.c;
    if (!c || this.disposed) return;

    const dt = Math.min(0.1, Math.max(0, ctx.dt));
    this.step(data, dt);

    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.clearRect(0, 0, this.w, this.h);

    const shown = this.entrySpring.value;
    if (shown > 0.002) {
      c.save();
      c.globalAlpha = clamp01(shown);
      this.drawRaceClusters(c, data, shown);
      this.drawCentre(c, data);
      c.restore();
    }
    if (data.perf) this.drawPerf(c, data.perf);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener('resize', this.onResize);
    if (this.canvas.parentNode === this.container) this.container.removeChild(this.canvas);
  }

  // -------------------------------------------------------------------------
  // State stepping — all event detection lives here, not in the draw calls
  // -------------------------------------------------------------------------

  private step(data: HudData, dt: number): void {
    this.dt = dt;
    this.blink += dt;
    const player = data.player;
    const pp = resolveProgress(data);

    const visible =
      data.phase === 'countdown' || data.phase === 'racing' || data.phase === 'finished';
    this.entrySpring.step(visible ? 1 : 0, dt);

    this.speedSpring.step(player ? Math.max(0, player.speed) : 0, dt);
    // Boost charge is smoothed only lightly — it is a resource the player is
    // actively watching, so lag here would be a lie about what is available.
    this.boostSmooth = approach(this.boostSmooth, player?.boostCharge ?? 0, 18, dt);

    this.posPunch.step(dt);
    this.lapPunch.step(dt);
    this.countPunch.step(dt);
    this.boostFullPunch.step(dt);
    this.deltaAge += dt;
    this.goTimer += dt;

    // --- position changes ---------------------------------------------------
    if (pp) {
      if (this.prevPosition !== 0 && pp.position !== this.prevPosition) {
        // Gaining places punches harder than losing them: the feedback should
        // reward the overtake, not rub in the loss.
        this.posPunch.trigger(pp.position < this.prevPosition ? 1 : 0.55);
      }
      this.prevPosition = pp.position;

      // --- lap completion --------------------------------------------------
      const laps = pp.lapTimes.length;
      if (this.prevLapCount >= 0 && laps > this.prevLapCount && laps > 0) {
        this.lapPunch.trigger(1);
        const last = pp.lapTimes[laps - 1];
        if (laps >= 2) {
          let bestBefore = Infinity;
          for (let i = 0; i < laps - 1; i++) bestBefore = Math.min(bestBefore, pp.lapTimes[i]);
          const delta = last - bestBefore;
          this.deltaText = formatDelta(delta);
          this.deltaLabel = delta <= 0 ? 'NEW BEST' : 'VS BEST';
          this.deltaColor = delta <= 0 ? CSS.green : CSS.danger;
        } else {
          // No reference on lap one, so show the time itself rather than a
          // meaningless +0.00.
          this.deltaText = formatTime(last);
          this.deltaLabel = 'LAP TIME';
          this.deltaColor = CSS.cyan;
        }
        this.deltaAge = 0;
      }
      this.prevLapCount = laps;
    }

    // --- countdown ---------------------------------------------------------
    const cd = data.countdown ?? 0;
    this.countdownAge += dt;
    if (data.phase === 'countdown') {
      this.sawCountdown = true;
      const step = Math.max(1, Math.ceil(cd));
      if (step !== this.prevCountdownStep) {
        this.countPunch.trigger(1);
        this.prevCountdownStep = step;
        // Timed from here rather than from the fractional part of `countdown`,
        // because the race director reports whole beats: there is no fraction to
        // animate from, and this works for either convention.
        this.countdownAge = 0;
      }
      this.goTimer = GO_HOLD + 1;
    } else if (this.sawCountdown && data.phase === 'racing') {
      // Fires exactly once, on the countdown -> racing edge, which is also the
      // frame the start horn goes off.
      this.sawCountdown = false;
      this.prevCountdownStep = -1;
      this.countPunch.trigger(1.25);
      this.goTimer = 0;
    }

    // --- boost meter filling ------------------------------------------------
    const full = (player?.boostCharge ?? 0) >= 0.995;
    if (full && !this.prevBoostFull) this.boostFullPunch.trigger(1);
    this.prevBoostFull = full;
  }

  // -------------------------------------------------------------------------
  // Corner clusters
  // -------------------------------------------------------------------------

  private drawRaceClusters(c: Ctx2D, data: HudData, shown: number): void {
    const u = this.u;
    const slide = 1 - clamp(shown, 0, 1.2);
    // Title-safe margin. 26 was not enough: the position panel is slanted,
    // which pushes its top-left corner further left than its nominal x, and it
    // is then scale-punched about its own centre on a place change — which took
    // the corner past x = 0 and had the ordinal glyph clipped by the screen edge
    // in every HUD frame captured. 44 keeps the whole cluster inside a ~3%
    // inset even at full punch.
    const m = 44 * u;

    // Each cluster flies in from the edge it lives on, so the composition
    // assembles outwards instead of everything arriving from one direction.
    c.save();
    c.translate(-slide * 380 * u, 0);
    this.drawLeftCluster(c, data, m);
    c.restore();

    c.save();
    c.translate(slide * 380 * u, 0);
    this.drawMinimap(c, data, m);
    c.restore();

    c.save();
    c.translate(slide * 260 * u, slide * 200 * u);
    this.drawSpeedo(c, data, m);
    c.restore();

    c.save();
    c.translate(0, slide * 220 * u);
    this.drawBoost(c, data, m);
    c.restore();

    c.save();
    c.translate(-slide * 480 * u, 0);
    this.drawDelta(c, m);
    c.restore();
  }

  private drawLeftCluster(c: Ctx2D, data: HudData, m: number): void {
    const u = this.u;
    const pp = resolveProgress(data);
    const colorIndex = data.player?.spec.colorIndex ?? 0;
    const color = racerColor(colorIndex);

    // --- position ----------------------------------------------------------
    const pw = 138 * u;
    const ph = 106 * u;
    const px = m;
    const py = 22 * u;
    const punch = 1 + this.posPunch.value * 0.16;
    c.save();
    // Punch about the panel's LEFT edge, not its centre. A left-anchored
    // cluster that grows from its middle grows outward as well as inward, and
    // outward here is off the screen.
    c.translate(px, py + ph * 0.5);
    c.scale(punch, punch);
    c.translate(-px, -(py + ph * 0.5));
    panel(c, px, py, pw, ph, {
      fill: CSS.ink,
      alpha: 0.86,
      slant: 16 * u,
      cut: 24 * u,
      shadow: 5 * u,
      line: 3 * u,
      stripe: color,
      stripeWidth: 9 * u,
    });
    const place = pp?.position ?? 1;
    const numSize = 54 * u;
    // White body, racer-coloured contour, and clear of the stripe.
    //
    // It was drawn in the racer's own colour starting 24 units in, which put it
    // over the 9-unit stripe of the same colour and over the panel's top-left
    // chamfer. The result was the single most important number on the HUD
    // rendered red on red down its left side, spilling past the panel edge onto
    // the sky, with a notch bitten out of its stem by the chamfer.
    //
    // Inverting it keeps the colour coding — the contour still says which racer
    // this is, and so does the stripe — while the number itself is the most
    // legible thing in the cluster, which is what it should have been.
    drawText(c, `${place}`, px + 42 * u, py + 20 * u, {
      size: numSize,
      fill: CSS.foam,
      ink: color,
      weight: 0.19,
      // Enough contour to carry the racer's colour, not so much that the
      // numeral reads as a coloured blob with a hole in it. At 0.16 it did.
      outline: 0.095,
      shadow: 3 * u,
      slant: 0.24,
    });
    const numW = measureText(`${place}`, numSize);
    drawText(c, ordinalSuffix(place), px + 56 * u + numW, py + 26 * u, {
      size: 22 * u,
      fill: CSS.foam,
      weight: 0.22,
      outline: 0.13,
      slant: 0.24,
    });
    drawText(c, 'POS', px + 38 * u + numW, py + 66 * u, {
      size: 15 * u,
      fill: CSS.cyan,
      alpha: 0.85,
      weight: 0.2,
      outline: 0.12,
      tracking: 3.1,
    });
    c.restore();

    // --- lap ---------------------------------------------------------------
    const ly = py + ph + 10 * u;
    const lw = 216 * u;
    const lh = 46 * u;
    const lapPunch = 1 + this.lapPunch.value * 0.12;
    c.save();
    c.translate(m, ly + lh * 0.5);
    c.scale(lapPunch, lapPunch);
    c.translate(-m, -(ly + lh * 0.5));
    panel(c, m, ly, lw, lh, {
      fill: CSS.ink,
      alpha: 0.82,
      slant: 8 * u,
      cut: 14 * u,
      shadow: 4 * u,
      line: 2.5 * u,
    });
    drawText(c, 'LAP', m + 16 * u, ly + 15 * u, {
      size: 17 * u,
      fill: CSS.cyan,
      weight: 0.21,
      outline: 0.12,
      tracking: 3.0,
    });
    const totalLaps = Math.max(1, data.totalLaps ?? 3);
    const lapNow = clamp((pp?.lap ?? 0) + 1, 1, totalLaps);
    drawText(c, `${lapNow}/${totalLaps}`, m + lw - 14 * u, ly + 10 * u, {
      size: 28 * u,
      fill: this.lapPunch.active ? CSS.foam : CSS.amber,
      align: 'right',
      weight: 0.2,
      outline: 0.12,
      shadow: 2.5 * u,
    });
    c.restore();

    // --- splits ------------------------------------------------------------
    const sy = ly + lh + 10 * u;
    const sw = 244 * u;
    const sh = 126 * u;
    panel(c, m, sy, sw, sh, {
      fill: CSS.ink,
      alpha: 0.82,
      slant: 8 * u,
      cut: 14 * u,
      shadow: 4 * u,
      line: 2.5 * u,
    });

    const times = resolveTimes(data, pp);
    // A row with no time yet is a row with NO TIME YET, and it has to look like
    // one. Both placeholders used to be drawn at full weight, and in two
    // different colours — white for LAST and amber for BEST — so on the grid
    // the panel showed three rows of confident dashes in a mix of colours and
    // read as UI that had been wired up wrong. One neutral tone at a third of
    // the opacity says "not set" without the panel having to change size.
    const set = (v: number) => Number.isFinite(v) && v > 0;
    const rows: Array<[string, number, string, number]> = [
      ['CUR', times.current, CSS.foam, 26 * u],
      ['LAST', times.last, CSS.foam, 21 * u],
      ['BEST', times.best, CSS.amber, 21 * u],
    ];
    let ry = sy + 11 * u;
    for (const [label, seconds, litFill, size] of rows) {
      const has = set(seconds);
      const value = formatTime(seconds);
      const fill = has ? litFill : CSS.cyan;
      drawText(c, label, m + 16 * u, ry + (size - 13 * u) * 0.5, {
        size: 13 * u,
        fill: CSS.cyan,
        alpha: 0.8,
        weight: 0.22,
        outline: 0.12,
        tracking: 2.9,
      });
      // Right edge kept clear of the panel's bottom-right chamfer, which the
      // last row would otherwise hang out of.
      drawText(c, value, m + sw - 21 * u, ry, {
        size,
        fill,
        align: 'right',
        weight: has ? 0.19 : 0.13,
        outline: has ? 0.11 : 0.06,
        shadow: has ? 2 * u : 0,
        alpha: has ? 1 : 0.34,
      });
      ry += size + 14 * u;
    }
  }

  private drawDelta(c: Ctx2D, m: number): void {
    if (this.deltaAge > DELTA_LIFE) return;
    const u = this.u;
    const t = this.deltaAge;
    // Snap in over 180 ms, hold, then fall away over the last 800 ms. The exit
    // is a slide *and* a fade so it reads as leaving rather than dissolving.
    const inT = clamp01(t / 0.18);
    const outT = clamp01((t - (DELTA_LIFE - 0.8)) / 0.8);
    const slide = (1 - inT) * -160 * u + outT * 90 * u;
    const alpha = (1 - outT) * (0.3 + 0.7 * inT);

    // Sits directly under the split block: position + lap + splits + gaps.
    const y = (22 + 106 + 10 + 46 + 10 + 126 + 14) * u;
    const label = this.deltaLabel;
    const value = this.deltaText;
    const size = 30 * u;
    const w = Math.max(196 * u, measureText(value, size) + 52 * u);

    c.save();
    c.globalAlpha *= alpha;
    c.translate(slide, 0);
    panel(c, m, y, w, 72 * u, {
      fill: CSS.ink,
      alpha: 0.92,
      slant: 12 * u,
      cut: 18 * u,
      shadow: 4 * u,
      line: 2.5 * u,
      stripe: this.deltaColor,
      stripeWidth: 9 * u,
    });
    drawText(c, label, m + 28 * u, y + 12 * u, {
      size: 12 * u,
      fill: CSS.foam,
      alpha: 0.8,
      weight: 0.24,
      outline: 0.13,
      tracking: 3.2,
    });
    drawText(c, value, m + 26 * u, y + 31 * u, {
      size,
      fill: this.deltaColor,
      weight: 0.2,
      outline: 0.12,
      shadow: 3 * u,
    });
    c.restore();
  }

  private drawMinimap(c: Ctx2D, data: HudData, m: number): void {
    const u = this.u;
    const course = data.course;
    const size = 196 * u;
    const x = this.w - m - size;
    const y = 22 * u;
    if (!course || course.points.length < 2) return;

    const pp = resolveProgress(data);
    const blips: MinimapBlip[] = [];
    const boats = data.boats ?? (data.player ? [data.player] : []);
    for (const boat of boats) {
      const prog = data.progress?.find((p) => p.boatId === boat.id);
      blips.push({
        x: boat.position.x,
        z: boat.position.z,
        fx: boat.forward.x,
        fz: boat.forward.z,
        colorIndex: boat.spec.colorIndex,
        isPlayer: data.player ? boat.id === data.player.id : false,
        finished: prog?.finished === true,
      });
    }

    this.minimap.draw(
      c,
      x,
      y,
      size,
      {
        path: course.points,
        gates: course.gates,
        startLine: course.startLine,
        blips,
        nextCheckpoint: pp?.nextCheckpoint,
      },
      this.dt,
    );
  }

  private drawSpeedo(c: Ctx2D, data: HudData, m: number): void {
    const u = this.u;
    const player = data.player;
    const color = racerColor(player?.spec.colorIndex ?? 0);
    const topSpeed = Math.max(6, data.topSpeed ?? player?.spec.topSpeed ?? 30);

    // The arc's centre sits well clear of the bottom edge. The ring opens
    // upwards, so a centre pinned to the margin leaves the gauge feeling like it
    // fell off the screen even though every tick is technically visible.
    const r = 124 * u;
    const cx = this.w - m - 150 * u;
    const cy = this.h - m - 78 * u;

    // Full scale sits 20% past the hull's top speed so a boosted run has
    // somewhere to go instead of pinning the gauge for the whole straight.
    const shown = this.speedSpring.value;
    const t = clamp(shown / (topSpeed * 1.2), 0, 1.06);
    const boosting = (player?.boostTime ?? 0) > 0;

    // Backing plate: the arc alone does not give the numerals enough contrast
    // against bright foam, and foam is exactly what is behind the bottom-right
    // corner whenever the player is going fast enough to look at this.
    // Sized for three digits with real padding, and tall enough that a 58u
    // numeral does not break its top edge.
    //
    // At 212 by 96 the plate gave a glyph of that size eight units of headroom
    // once its outline and drop shadow were counted, so the digits crossed the
    // top edge into the tick arc and the last one hung out over the right
    // chamfer. It reads as a layout authored against a two-digit test value,
    // which is exactly what it was: the speedo only passes three digits once
    // the boat is over 100 km/h.
    const plate = panelPath(cx - 122 * u, cy - 116 * u, 244 * u, 110 * u, 14 * u, 24 * u);
    c.save();
    c.globalAlpha *= 0.9;
    c.fillStyle = CSS.ink;
    c.fill(plate);
    c.restore();
    c.save();
    c.lineWidth = 2.5 * u;
    c.strokeStyle = CSS.inkSoft;
    c.stroke(plate);
    c.restore();

    segmentedArc(c, cx, cy, r * 0.79, r, ARC_START, ARC_END, {
      value: t,
      segments: SPEEDO_SEGMENTS,
      fill: color,
      hot: CSS.amber,
      hotFrom: 0.8,
      empty: CSS.inkSoft,
      line: 2 * u,
      // Whole ring flashes on boost — the one moment the gauge is allowed to
      // shout, because the speed it is showing is temporary.
      flash: boosting ? 0.35 + 0.35 * Math.sin(this.blink * 26) : 0,
      gapFrac: 0.24,
    });

    // Redline marks, drawn *inside* the ring: outside is where the value cursor
    // travels, and two things sharing that band would collide at top speed.
    for (let i = 0; i < 3; i++) {
      const markT = 0.85 + i * 0.055;
      const a = ARC_START + (ARC_END - ARC_START) * markT;
      // Dim until the value actually reaches the mark. Drawn at full danger red
      // regardless of speed, three saturated marks at the top of the arc read as
      // lit segments — a reviewer looking at a stationary boat saw the needle
      // parked at zero and the gauge apparently showing maximum, and called the
      // instrument broken. A redline should be a warning that arms, not a
      // permanent decoration.
      const armed = t >= markT - 0.02;
      c.save();
      c.globalAlpha = armed ? 1 : 0.28;
      c.strokeStyle = armed ? CSS.danger : CSS.inkSoft;
      c.lineWidth = (armed ? 3.5 : 2.4) * u;
      c.beginPath();
      c.moveTo(cx + Math.cos(a) * r * 0.68, cy + Math.sin(a) * r * 0.68);
      c.lineTo(cx + Math.cos(a) * r * 0.76, cy + Math.sin(a) * r * 0.76);
      c.stroke();
      c.restore();
    }

    // Value cursor: a dart riding the outside of the ring, pointing in.
    //
    // A centre-pivot needle does not work at this size — the readout has to live
    // in the middle of the arc, so a needle spends most of its travel hidden
    // behind the numbers. An outside marker keeps the instrument's single moving
    // part while overlapping nothing.
    const angle = ARC_START + (ARC_END - ARC_START) * clamp01(t);
    triangle(
      c,
      cx + Math.cos(angle) * (r + 17 * u),
      cy + Math.sin(angle) * (r + 17 * u),
      angle + Math.PI,
      12 * u,
      boosting ? CSS.foam : CSS.amber,
      CSS.ink,
      2.5 * u,
    );

    // km/h reads bigger and changes faster than m/s, which is what an arcade
    // speedo is for. The physics stays in m/s everywhere else.
    // Kept clear of the tick arc, whose inner edge is at 0.79 of the gauge
    // radius — 98 units from the centre. Anything drawn above that line near
    // the centreline runs through the ticks, which is what the numerals were
    // doing: the red arc passed straight across the digits and neither could
    // be read against the other.
    // A dash on the grid rather than a number. Before the start the reading is
    // a 1 that never changes, which invites the player to look at it and then
    // tells them nothing; a dash says the instrument is live and waiting.
    const kph = Math.max(0, Math.round(shown * 3.6));
    const reading = data.phase === 'countdown' ? '-' : `${kph}`;
    drawText(c, reading, cx, cy - 92 * u, {
      size: 52 * u,
      fill: boosting ? CSS.amber : CSS.foam,
      align: 'center',
      weight: 0.185,
      outline: 0.1,
      shadow: 4 * u,
      slant: 0.26,
    });
    drawText(c, 'KM/H', cx, cy - 32 * u, {
      size: 15 * u,
      fill: CSS.cyan,
      align: 'center',
      weight: 0.22,
      outline: 0.12,
      tracking: 3.5,
    });
    if (boosting) {
      drawText(c, 'BOOST', cx, cy + 14 * u, {
        size: 17 * u,
        fill: CSS.amber,
        align: 'center',
        weight: 0.24,
        outline: 0.14,
        tracking: 3.3,
        alpha: 0.6 + 0.4 * Math.sin(this.blink * 22),
      });
    }
  }

  private drawBoost(c: Ctx2D, data: HudData, m: number): void {
    const u = this.u;
    const player = data.player;
    const charge = this.boostSmooth;
    const boostTime = player?.boostTime ?? 0;
    const boosting = boostTime > 0;
    const drift = player?.driftAmount ?? 0;

    const w = Math.min(430 * u, this.w * 0.4);
    const barH = 30 * u;
    const x = m;
    const y = this.h - m - barH - 4 * u;

    // Label above the bar, not beside it: the bar then starts at the same left
    // margin as every other cluster and the eye only has one edge to track.
    drawText(c, 'BOOST', x + 2 * u, y - 26 * u, {
      size: 18 * u,
      fill: charge >= 0.995 ? CSS.foam : CSS.cyan,
      weight: 0.22,
      outline: 0.13,
      tracking: 3.5,
      shadow: 2.5 * u,
    });

    const full = charge >= 0.995;
    const flash = full ? 0.35 + 0.35 * Math.sin(this.blink * 18) : 0;
    if (full || boosting) {
      drawText(c, boosting ? 'FIRING' : 'READY', x + w + 12 * u, y - 24 * u, {
        size: 16 * u,
        fill: boosting ? CSS.amber : CSS.green,
        weight: 0.24,
        outline: 0.14,
        tracking: 3.2,
        alpha: 0.55 + 0.45 * Math.sin(this.blink * (boosting ? 26 : 14)),
      });
    }

    // Track behind the segments: gives the empty portion a body and lets the
    // hatch read as "nothing here yet" rather than a missing draw.
    const track = panelPath(x - 5 * u, y - 5 * u, w + 10 * u, barH + 10 * u, barH * 0.34, 10 * u);
    c.save();
    c.globalAlpha *= 0.72;
    c.fillStyle = CSS.ink;
    c.fill(track);
    c.restore();
    hatch(c, track, x - 5 * u, y - 5 * u, w + 10 * u, barH + 10 * u, CSS.inkSoft, 10 * u, 2 * u);
    c.save();
    c.lineWidth = 2.5 * u;
    c.strokeStyle = CSS.ink;
    c.stroke(track);
    c.restore();

    const punch = 1 + this.boostFullPunch.value * 0.1;
    c.save();
    c.translate(x, y + barH * 0.5);
    c.scale(1, punch);
    c.translate(-x, -(y + barH * 0.5));
    // Three distinct states, each one colour, because a meter that mixes hues
    // mid-charge is unreadable at the edge of vision: charging is cyan going
    // green at the top, armed is all green, firing is all amber.
    segmentedBar(c, x, y, w, barH, {
      value: charge,
      segments: BOOST_SEGMENTS,
      fill: boosting ? CSS.amber : full ? CSS.green : CSS.cyan,
      hot: boosting ? CSS.amber : CSS.green,
      hotFrom: boosting || full ? 1.1 : 0.75,
      // The empty state has to be a state, not an absence. At the old
      // rgba(22,41,74,0.55) an unlit cell landed within 20 levels of the ink
      // track under it and its ink contour was the track's own colour, so the
      // uncharged part of an 800 px meter — a quarter of the screen's width —
      // was effectively undrawn. The cells now have a slate body and their own
      // lit edge, so the bar reads as eight empty boxes waiting to fill.
      empty: 'rgba(46,78,116,0.92)',
      emptyLine: '#4a7cb8',
      slant: barH * 0.34,
      gap: 4 * u,
      line: 2 * u,
      flash,
      // Partial lighting while charging: the drift charge is continuous, and a
      // segment that fades up tells the player the charge is still moving.
      partial: !boosting,
    });
    c.restore();

    // Drift charge rate cue: a thin bar under the meter that only exists while
    // the player is actually sliding, so cause and effect stay attached.
    if (drift > 0.02 && !boosting) {
      c.save();
      c.globalAlpha *= 0.6 + 0.4 * drift;
      segmentedBar(c, x, y + barH + 7 * u, w * 0.62, 6 * u, {
        value: drift,
        segments: 20,
        fill: CSS.green,
        empty: 'rgba(22,41,74,0.0)',
        slant: 3 * u,
        gap: 2.5 * u,
        line: 0,
        partial: true,
      });
      c.restore();
    }
  }

  // -------------------------------------------------------------------------
  // Centre-screen overlays
  // -------------------------------------------------------------------------

  private drawCentre(c: Ctx2D, data: HudData): void {
    this.drawCountdown(c, data);
    this.drawWrongWay(c, data);
    this.drawCornerPreview(c, data);
  }

  private drawCountdown(c: Ctx2D, data: HudData): void {
    const u = this.u;
    const counting = data.phase === 'countdown';
    const go = this.goTimer <= GO_HOLD;
    if (!counting && !go) return;

    const cd = data.countdown ?? 0;
    const step = Math.max(1, Math.ceil(cd));
    const label = counting ? `${step}` : 'GO!';
    const fill = counting ? CSS.amber : CSS.green;

    // Two things happen per beat: a scale punch on the glyph, and a band that
    // wipes out behind it. The band is what stops a lone huge digit from
    // floating in the middle of the screen with nothing to sit against.
    const beat = counting
      ? 1 - clamp01(this.countdownAge / 0.85)
      : 1 - clamp01(this.goTimer / GO_HOLD);
    const punch = 1 + this.countPunch.value * 0.3;
    const cx = this.w * 0.5;
    // Sits in the upper third, not the middle.
    //
    // At 0.4 of the height and 220 units it covered the player's own boat and
    // both rivals for the whole countdown — the one moment the grid is worth
    // looking at, and the first thing anyone sees of the game. It is still by
    // far the largest thing on screen at 150; a start countdown does not have
    // to fill the frame to be read, it has to be unmissable, and being alone in
    // the upper third does that without hiding the race.
    const cy = this.h * 0.3;
    const size = (counting ? 150 : 120) * u;

    // Two stacked slabs: a wide dark one for contrast under the glyph, and a
    // thin accent one that wipes outwards faster. The pair gives the beat a
    // direction; a single rectangle just sits there looking like a mistake.
    const bandH = size * 0.66;
    const bandW = this.w * (0.4 + 0.55 * (1 - beat) * (1 - beat));
    c.save();
    c.globalAlpha *= 0.7 * beat;
    c.fillStyle = CSS.ink;
    c.fill(panelPath(cx - bandW * 0.5, cy - bandH * 0.5, bandW, bandH, bandH * 0.28, bandH * 0.36));
    c.restore();
    c.save();
    c.globalAlpha *= 0.85 * beat;
    c.fillStyle = fill;
    const accentH = size * 0.075;
    const accentW = bandW * 1.08;
    c.fill(
      panelPath(
        cx - accentW * 0.5,
        cy + bandH * 0.5 - accentH * 0.5,
        accentW,
        accentH,
        accentH * 1.6,
        0,
      ),
    );
    c.restore();

    c.save();
    c.globalAlpha *= go ? clamp01(1.6 - this.goTimer / GO_HOLD) : 1;
    c.translate(cx, cy);
    c.scale(punch, punch);
    drawText(c, label, 0, 0, {
      size,
      fill,
      baseline: 'middle',
      align: 'center',
      weight: 0.165,
      outline: 0.075,
      shadow: 9 * u,
      slant: 0.3,
      // The one place in the HUD that genuinely needs it: at display size the
      // glyphs' ten-unit grid shows as a staircase down every curve.
      round: 1.7,
    });
    c.restore();
  }

  private drawWrongWay(c: Ctx2D, data: HudData): void {
    const wrong = data.wrongWay === true || resolveProgress(data)?.wrongWay === true;
    if (!wrong || data.phase !== 'racing') return;
    const u = this.u;
    const cx = this.w * 0.5;
    const y = this.h * 0.2;
    const w = 470 * u;
    const h = 66 * u;

    // Hard on/off at ~5 Hz rather than a sine fade: an alarm should strobe, and
    // a smoothly pulsing banner reads as decoration. The *fill* strobes while
    // the silhouette stays opaque — blinking the alpha instead leaves the banner
    // semi-transparent over bright water for half of every cycle, which is when
    // it is least legible and most needed.
    const on = Math.sin(this.blink * 15) > -0.25;
    c.save();
    panel(c, cx - w * 0.5, y, w, h, {
      fill: on ? CSS.danger : CSS.ink,
      slant: 22 * u,
      cut: 24 * u,
      shadow: 6 * u,
      line: 3.5 * u,
    });
    drawText(c, 'WRONG WAY', cx + 6 * u, y + h * 0.5, {
      size: 32 * u,
      fill: on ? CSS.ink : CSS.danger,
      ink: 'none',
      align: 'center',
      baseline: 'middle',
      weight: 0.2,
      tracking: 3.0,
    });
    // Chevrons pointing back the way the player should be going.
    for (let i = 0; i < 2; i++) {
      const o = w * 0.5 - 30 * u - i * 22 * u;
      const tint = on ? CSS.foam : CSS.danger;
      chevron(c, cx - o, y + h * 0.5, 13 * u, -1, tint, 1 - i * 0.35);
      chevron(c, cx + o, y + h * 0.5, 13 * u, -1, tint, 1 - i * 0.35);
    }
    c.restore();
  }

  private drawCornerPreview(c: Ctx2D, data: HudData): void {
    const corner = data.corner;
    if (!corner || data.phase !== 'racing') return;
    const sev = clamp01(corner.severity);
    if (sev < 0.22) return;
    const u = this.u;
    const dir = corner.direction >= 0 ? 1 : -1;
    const cx = this.w * 0.5;
    const cy = this.h * 0.52;
    // The 3D racing line already carries the corner; this is peripheral
    // reinforcement, so it stays faint, off to the side, and out of the middle
    // where the boat is.
    const strength = range01(0.22, 0.85, sev);
    const color = sev > 0.66 ? CSS.danger : CSS.amber;
    const base = 205 * u;

    c.save();
    c.globalAlpha *= 0.45 + 0.5 * strength;
    for (let i = 0; i < 3; i++) {
      // Marching phase: the chevrons light in sequence towards the turn, which
      // gives the cluster a direction without needing an arrowhead.
      const phase = (this.blink * 3.4 - i * 0.42) % 1.6;
      const a = clamp01(1.2 - Math.abs(phase - 0.4) * 2.2);
      chevron(
        c,
        cx + dir * (base + i * 30 * u),
        cy,
        (17 + strength * 8) * u,
        dir,
        color,
        0.3 + a * 0.7,
      );
    }
    c.restore();
  }

  /**
   * Frame budget, top-left. Only drawn when the game is booted with `?perf=1`
   * so a real GPU can answer "does it hold 60" without a profiler.
   */
  private drawPerf(c: Ctx2D, perf: HudPerf): void {
    const u = this.u;
    const x = 14 * u;
    const y = 12 * u;
    const fps = perf.fps;
    const ok = fps >= 58;
    const fill = ok ? CSS.green : fps >= 45 ? CSS.amber : CSS.danger;
    const line = `${fps.toFixed(0)}  ${perf.tier}  ${perf.pixelRatio.toFixed(2)}x  ${perf.draws}  ${(perf.tris / 1000).toFixed(0)}k`;
    c.save();
    c.globalAlpha = 0.92;
    c.fillStyle = 'rgba(10,18,38,0.55)';
    c.beginPath();
    c.roundRect(x, y, 420 * u, 28 * u, 6 * u);
    c.fill();
    drawText(c, line, x + 10 * u, y + 20 * u, {
      size: 13 * u,
      weight: 0.08,
      fill,
      ink: CSS.ink,
    });
    c.restore();
  }
}

// ---------------------------------------------------------------------------
// Derivations
// ---------------------------------------------------------------------------

function resolveProgress(data: HudData): RacerProgress | null {
  if (data.playerProgress) return data.playerProgress;
  const id = data.player?.id;
  if (id === undefined || !data.progress) return null;
  return data.progress.find((p) => p.boatId === id) ?? null;
}

interface SplitTimes {
  current: number;
  last: number;
  best: number;
}

/**
 * Lap times, derived rather than demanded.
 *
 * `RacerProgress` already carries `totalTime` and the completed `lapTimes`, so
 * the in-progress lap is just the remainder. Deriving it here means there is
 * exactly one definition of "current lap time" in the build, and it cannot drift
 * out of step with the split the results screen prints.
 */
function resolveTimes(data: HudData, pp: RacerProgress | null): SplitTimes {
  const laps = pp?.lapTimes ?? [];
  let sum = 0;
  let best = Infinity;
  for (const t of laps) {
    sum += t;
    if (t < best) best = t;
  }
  const current = data.currentLapTime ?? Math.max(0, (pp?.totalTime ?? 0) - sum);
  return {
    current: data.phase === 'countdown' ? 0 : current,
    last: data.lastLapTime ?? (laps.length > 0 ? laps[laps.length - 1] : 0),
    best: data.bestLapTime ?? (Number.isFinite(best) ? best : 0),
  };
}
