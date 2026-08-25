import type { FrameContext, RacePhase } from '../contracts.ts';
import { CSS } from '../core/Palette.ts';
import { drawText, formatTime, measureText, ordinalSuffix, racerColor } from './hudPrimitives.ts';

/**
 * SCREENS — title card, pause overlay, results table.
 *
 * These are DOM, not canvas, and the split is deliberate: the results screen is
 * a five-column table of variable-width names and monospaced-ish times, which is
 * exactly the job CSS grid does better than hand-measured `fillText` calls, and
 * it is the one part of the UI that has to be clickable.
 *
 * The risk with going DOM is that the browser's own idea of a heading drags a
 * different visual language in. Two things prevent that:
 *
 *   - every *large* piece of type ("INK TIDE", "PAUSED", "RESULTS", the finishing
 *     ordinal) is rendered through the same vector stroke font the HUD canvas
 *     uses, into a small `<canvas>` that is then laid out as an image. The
 *     headline type is therefore literally identical to the in-race type.
 *   - everything else is sheared, tracked out, hard-shadowed and chamfered with
 *     `clip-path` so it matches the panel primitive: no border radius, no blur,
 *     no gradient softer than a hard colour stop anywhere in the sheet.
 *
 * All styling is injected from here. There is no external stylesheet to fall out
 * of sync with `Palette.ts`.
 */

export interface ScreenResultRow {
  name: string;
  /** Palette index 0..3. */
  colorIndex: number;
  /** Final placement, 1-based. */
  position: number;
  /** Total race time in seconds. */
  totalTime: number;
  /** Best lap in seconds. 0 if none set. */
  bestLap: number;
  /** Seconds behind the winner. Derived from the fastest total when omitted. */
  gap?: number;
  isPlayer?: boolean;
  finished?: boolean;
}

export interface ScreensData {
  phase: RacePhase;
  paused?: boolean;
  /** Final classification, any order — sorted by `position` here. */
  results?: readonly ScreenResultRow[];
  /** The player's finishing place, for the big verdict. Derived when omitted. */
  playerPosition?: number;
  totalLaps?: number;
  /** Replaces the title card's prompt line. */
  startHint?: string;
  /** Replaces the pause overlay's hint line. */
  pauseHint?: string;
}

type ScreenKind = 'none' | 'title' | 'pause' | 'results';

const STYLE_ID = 'ink-tide-screens-style';

/**
 * Chamfer size for panels, in px, matched to the canvas panel primitive's
 * `cut`. Kept as a constant because it appears in four `clip-path` polygons.
 */
const CUT = 22;

const SHEET = `
.it-root {
  position: absolute; inset: 0; pointer-events: none;
  font-family: 'Trebuchet MS', 'Segoe UI', system-ui, sans-serif;
  font-weight: 900; text-transform: uppercase; color: ${CSS.foam};
  -webkit-font-smoothing: antialiased;
}
.it-screen {
  position: absolute; inset: 0; display: none;
  align-items: center; justify-content: center; flex-direction: column;
}
.it-screen.it-on { display: flex; }

/* Backdrops are flat ink plus hard diagonal bands — a stepped wash, never a
   soft radial one, so the screen reads as printed card stock. */
.it-wash {
  position: absolute; inset: 0;
  background:
    repeating-linear-gradient(102deg,
      rgba(10,18,38,0.00) 0px, rgba(10,18,38,0.00) 34px,
      rgba(10,18,38,0.16) 34px, rgba(10,18,38,0.16) 68px),
    ${CSS.ink};
  opacity: 0.9;
  animation: it-fade 320ms steps(4, end) both;
}
.it-wash.it-light { opacity: 0.66; }

.it-stack { position: relative; display: flex; flex-direction: column; align-items: center; }

.it-headline { display: block; image-rendering: auto; }
.it-headline.it-pop { animation: it-pop 420ms cubic-bezier(.16,1.5,.3,1) both; }

.it-rule {
  height: 8px; background: ${CSS.cyan}; border: 3px solid ${CSS.ink};
  transform: skewX(-24deg); margin: 10px 0 0 0;
  animation: it-wipe 420ms cubic-bezier(.2,.9,.2,1) both;
}
.it-sub {
  margin-top: 16px; font-size: 14px; letter-spacing: 0.42em; color: ${CSS.cyan};
  transform: skewX(-8deg); text-shadow: 2px 2px 0 ${CSS.ink};
}
.it-prompt {
  margin-top: 30px; font-size: 17px; letter-spacing: 0.3em; color: ${CSS.foam};
  transform: skewX(-8deg); text-shadow: 3px 3px 0 ${CSS.ink};
  animation: it-blink 1.15s steps(2, end) infinite;
}

/* Panels: sheared, two opposite corners cut, hard offset ink shadow. Identical
   construction to panelPath() on the canvas side. */
.it-panel {
  position: relative; background: ${CSS.ink};
  border: 3px solid ${CSS.ink};
  clip-path: polygon(${CUT}px 0, 100% 0, 100% calc(100% - ${CUT}px), calc(100% - ${CUT}px) 100%, 0 100%, 0 ${CUT}px);
  box-shadow: 9px 9px 0 ${CSS.ink};
}
.it-results {
  padding: 26px 30px 22px; min-width: min(760px, 92vw);
  background: rgba(10,18,38,0.94);
  animation: it-rise 380ms cubic-bezier(.2,.9,.2,1) both;
}
.it-verdict {
  display: flex; align-items: baseline; gap: 14px; margin: 4px 0 18px;
  transform: skewX(-8deg);
}
.it-verdict-note { font-size: 15px; letter-spacing: 0.26em; color: ${CSS.cyan}; }

.it-grid { display: grid; grid-template-columns: 58px 1fr 116px 116px 104px; row-gap: 6px; }
.it-th {
  font-size: 11px; letter-spacing: 0.24em; color: ${CSS.cyan}; opacity: 0.8;
  padding: 0 8px 8px; border-bottom: 3px solid ${CSS.inkSoft};
  transform: skewX(-8deg);
}
.it-th.it-num, .it-td.it-num { text-align: right; font-variant-numeric: tabular-nums; }

.it-row { display: grid; grid-column: 1 / -1; grid-template-columns: subgrid; }
.it-cell {
  display: flex; align-items: center; padding: 9px 8px;
  background: rgba(22,41,74,0.55); font-size: 16px; letter-spacing: 0.1em;
  transform: skewX(-8deg);
}
.it-cell.it-num { justify-content: flex-end; letter-spacing: 0.04em; }
.it-cell:first-child { clip-path: polygon(12px 0, 100% 0, 100% 100%, 0 100%, 0 12px); }
.it-cell:last-child { clip-path: polygon(0 0, 100% 0, 100% calc(100% - 12px), calc(100% - 12px) 100%, 0 100%); }
.it-row.it-player .it-cell { background: rgba(143,244,255,0.16); color: ${CSS.foam}; }
.it-row.it-dnf .it-cell { opacity: 0.55; }
.it-row { animation: it-slide 340ms cubic-bezier(.2,.9,.2,1) both; }

.it-place {
  font-size: 22px; -webkit-text-stroke: 0; text-shadow: 2px 2px 0 ${CSS.ink};
}
.it-chip {
  width: 12px; height: 22px; margin-right: 10px; border: 2px solid ${CSS.ink};
  transform: skewX(-16deg); flex: 0 0 auto;
}
.it-gap { color: ${CSS.amber}; }
.it-gap.it-lead { color: ${CSS.green}; }

.it-actions { display: flex; gap: 14px; align-items: center; margin-top: 22px; }
.it-btn {
  pointer-events: auto; cursor: pointer; appearance: none;
  font: inherit; font-size: 18px; letter-spacing: 0.24em; color: ${CSS.ink};
  background: ${CSS.cyan}; border: 3px solid ${CSS.ink};
  padding: 13px 26px 12px; transform: skewX(-10deg);
  clip-path: polygon(14px 0, 100% 0, 100% calc(100% - 14px), calc(100% - 14px) 100%, 0 100%, 0 14px);
  box-shadow: 6px 6px 0 ${CSS.ink};
  transition: transform 90ms steps(2, end), background-color 90ms steps(2, end), box-shadow 90ms steps(2, end);
}
.it-btn:hover { background: ${CSS.foam}; transform: skewX(-10deg) translate(-2px, -2px); box-shadow: 9px 9px 0 ${CSS.ink}; }
.it-btn:active { transform: skewX(-10deg) translate(3px, 3px); box-shadow: 2px 2px 0 ${CSS.ink}; }
.it-btn.it-alt { background: ${CSS.amber}; }
.it-hint { font-size: 12px; letter-spacing: 0.24em; color: ${CSS.cyan}; opacity: 0.8; transform: skewX(-8deg); }

@keyframes it-fade { from { opacity: 0; } to { opacity: 0.9; } }
@keyframes it-pop {
  0% { transform: scale(0.72) skewX(-6deg); opacity: 0; }
  60% { transform: scale(1.06) skewX(0deg); opacity: 1; }
  100% { transform: scale(1) skewX(0deg); opacity: 1; }
}
@keyframes it-wipe { from { width: 0; } to { width: 100%; } }
@keyframes it-rise { from { transform: translateY(26px); opacity: 0; } to { transform: none; opacity: 1; } }
@keyframes it-slide { from { transform: translateX(-34px); opacity: 0; } to { transform: none; opacity: 1; } }
@keyframes it-blink { 0%, 55% { opacity: 1; } 56%, 100% { opacity: 0.25; } }
`;

/**
 * Render a headline through the HUD's vector stroke font into its own canvas.
 *
 * This is the glue that stops the DOM screens from looking like a different
 * game: the words on the title card are drawn by exactly the same code path as
 * the countdown digits, down to the ink outline width.
 */
function headlineCanvas(
  text: string,
  size: number,
  fill: string,
  opts: { slant?: number; tracking?: number; shadow?: number } = {},
): HTMLCanvasElement {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const slant = opts.slant ?? 0.26;
  const tracking = opts.tracking ?? 1.6;
  const shadow = opts.shadow ?? size * 0.06;
  const pad = size * 0.34 + shadow;
  const w = Math.ceil(measureText(text, size, tracking) + pad * 2);
  const h = Math.ceil(size + pad * 2);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * dpr));
  canvas.height = Math.max(1, Math.round(h * dpr));
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  const c = canvas.getContext('2d');
  if (c) {
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawText(c, text, pad, pad, {
      size,
      fill,
      tracking,
      slant,
      shadow,
      weight: 0.17,
      outline: 0.095,
    });
  }
  canvas.className = 'it-headline';
  return canvas;
}

export class Screens {
  /** Hooked by the game to rebuild the race. Fired by the results button. */
  onRestart: (() => void) | null = null;
  /** Fired by the title card's start button. */
  onStart: (() => void) | null = null;
  /** Fired by the pause overlay's resume button. */
  onResume: (() => void) | null = null;

  private readonly container: HTMLElement;
  private readonly root: HTMLDivElement;
  private readonly screens: Record<Exclude<ScreenKind, 'none'>, HTMLDivElement>;
  private current: ScreenKind = 'none';
  /** Signature of the rendered results, so the table is not rebuilt every frame. */
  private resultsKey = '';
  private disposed = false;

  constructor(container: HTMLElement) {
    this.container = container;
    injectSheet();

    this.root = document.createElement('div');
    this.root.className = 'it-root';
    container.appendChild(this.root);

    this.screens = {
      title: this.buildTitle(),
      pause: this.buildPause(),
      results: this.buildResults(),
    };
    for (const el of Object.values(this.screens)) this.root.appendChild(el);
  }

  /**
   * Drive the screens from race state.
   *
   * Cheap to call every frame: it resolves which screen should be up, and only
   * touches the DOM when that answer or the results data actually changes. The
   * entrance animations are CSS, so re-showing a screen is one class toggle.
   */
  update(data: ScreensData, ctx: FrameContext): void {
    if (this.disposed) return;
    void ctx;

    let want: ScreenKind = 'none';
    if (data.phase === 'results') want = 'results';
    else if (data.paused === true) want = 'pause';
    else if (data.phase === 'intro') want = 'title';

    if (want === 'results') {
      const rows = sortRows(data.results ?? []);
      const key = resultsSignature(rows, data.playerPosition);
      if (key !== this.resultsKey) {
        this.resultsKey = key;
        this.fillResults(rows, data);
      }
    }

    if (want !== this.current) {
      for (const [kind, el] of Object.entries(this.screens)) {
        const on = kind === want;
        // Re-adding the class after a removal restarts the CSS entrance
        // animations, which is exactly what a re-shown screen should do.
        el.classList.toggle('it-on', on);
      }
      this.current = want;
    }
  }

  /** True while a screen is up — the game can use this to gate input. */
  get visible(): boolean {
    return this.current !== 'none';
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.root.parentNode === this.container) this.container.removeChild(this.root);
  }

  // -------------------------------------------------------------------------
  // Construction
  // -------------------------------------------------------------------------

  private buildTitle(): HTMLDivElement {
    const screen = div('it-screen');
    screen.appendChild(div('it-wash'));
    const stack = div('it-stack');
    const head = headlineCanvas('INK TIDE', 96, CSS.foam, { shadow: 8 });
    head.classList.add('it-pop');
    stack.appendChild(head);
    const rule = div('it-rule');
    rule.style.width = '82%';
    stack.appendChild(rule);
    stack.appendChild(text('it-sub', 'CEL-SHADED OCEAN RACING'));

    const actions = div('it-actions');
    const start = button('it-btn', 'START RACE', () => this.onStart?.());
    actions.appendChild(start);
    stack.appendChild(actions);
    stack.appendChild(text('it-prompt', 'PRESS ENTER OR CLICK TO LAUNCH'));
    screen.appendChild(stack);
    return screen;
  }

  private buildPause(): HTMLDivElement {
    const screen = div('it-screen');
    screen.appendChild(div('it-wash it-light'));
    const stack = div('it-stack');
    const head = headlineCanvas('PAUSED', 70, CSS.cyan, { shadow: 6 });
    head.classList.add('it-pop');
    stack.appendChild(head);
    const rule = div('it-rule');
    rule.style.width = '70%';
    stack.appendChild(rule);
    const actions = div('it-actions');
    actions.appendChild(button('it-btn', 'RESUME', () => this.onResume?.()));
    actions.appendChild(button('it-btn it-alt', 'RESTART', () => this.onRestart?.()));
    stack.appendChild(actions);
    stack.appendChild(text('it-hint', 'ESC TO RESUME'));
    screen.appendChild(stack);
    return screen;
  }

  private buildResults(): HTMLDivElement {
    const screen = div('it-screen');
    screen.appendChild(div('it-wash'));
    const stack = div('it-stack');
    const panel = div('it-panel it-results');
    panel.appendChild(div('it-results-head'));
    panel.appendChild(div('it-verdict'));
    panel.appendChild(div('it-grid'));
    const actions = div('it-actions');
    actions.appendChild(button('it-btn', 'RACE AGAIN', () => this.onRestart?.()));
    actions.appendChild(text('it-hint', 'ENTER TO RESTART'));
    panel.appendChild(actions);
    stack.appendChild(panel);
    screen.appendChild(stack);
    return screen;
  }

  private fillResults(rows: readonly ScreenResultRow[], data: ScreensData): void {
    const panel = this.screens.results.querySelector('.it-results');
    if (!panel) return;
    const head = panel.querySelector('.it-results-head');
    const verdict = panel.querySelector('.it-verdict');
    const grid = panel.querySelector('.it-grid');
    if (!head || !verdict || !grid) return;

    head.textContent = '';
    head.appendChild(headlineCanvas('RESULTS', 46, CSS.foam, { shadow: 5 }));

    // The player's own placement is the single most important number on this
    // screen, so it gets the headline treatment and its own colour.
    const player = rows.find((r) => r.isPlayer === true);
    const place = data.playerPosition ?? player?.position ?? 0;
    verdict.textContent = '';
    if (place > 0) {
      const won = place === 1;
      verdict.appendChild(
        headlineCanvas(
          `${place}${ordinalSuffix(place)}`,
          62,
          won ? CSS.amber : racerColor(player?.colorIndex ?? 0),
          { shadow: 6 },
        ),
      );
      verdict.appendChild(
        text('it-verdict-note', won ? 'FLAWLESS RUN' : place <= 3 ? 'ON THE PODIUM' : 'SHAKE IT OFF'),
      );
    }

    grid.textContent = '';
    for (const label of ['POS', 'RACER', 'TOTAL', 'BEST LAP', 'GAP']) {
      const th = div(label === 'POS' || label === 'RACER' ? 'it-th' : 'it-th it-num');
      th.textContent = label;
      grid.appendChild(th);
    }

    const winner = rows.length > 0 ? rows[0] : null;
    let i = 0;
    for (const row of rows) {
      const tr = div('it-row');
      if (row.isPlayer) tr.classList.add('it-player');
      if (row.finished === false) tr.classList.add('it-dnf');
      // Staggered entrance: the classification arrives in finishing order, which
      // is worth the four inline delays.
      tr.style.animationDelay = `${120 + i * 70}ms`;

      const pos = div('it-cell');
      const place2 = span('it-place', row.finished === false ? 'DNF' : `${row.position}`);
      place2.style.color = racerColor(row.colorIndex);
      pos.appendChild(place2);
      tr.appendChild(pos);

      const name = div('it-cell');
      const chip = div('it-chip');
      chip.style.background = racerColor(row.colorIndex);
      name.appendChild(chip);
      name.appendChild(span('', row.name));
      tr.appendChild(name);

      tr.appendChild(cell(formatTime(row.totalTime)));
      tr.appendChild(cell(formatTime(row.bestLap)));

      const gapCell = div('it-cell it-num');
      const gapValue = row.gap ?? (winner ? row.totalTime - winner.totalTime : 0);
      const gapSpan = span(gapValue <= 0.0005 ? 'it-gap it-lead' : 'it-gap', '');
      gapSpan.textContent =
        row.finished === false ? '--' : gapValue <= 0.0005 ? 'LEADER' : `+${gapValue.toFixed(2)}`;
      gapCell.appendChild(gapSpan);
      tr.appendChild(gapCell);

      grid.appendChild(tr);
      i++;
    }
  }
}

// ---------------------------------------------------------------------------
// DOM helpers — tiny on purpose; this file owns all of its own markup
// ---------------------------------------------------------------------------

function injectSheet(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = SHEET;
  document.head.appendChild(style);
}

function div(className: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = className;
  return el;
}

function span(className: string, content: string): HTMLSpanElement {
  const el = document.createElement('span');
  if (className) el.className = className;
  el.textContent = content;
  return el;
}

function text(className: string, content: string): HTMLDivElement {
  const el = div(className);
  el.textContent = content;
  return el;
}

function cell(content: string): HTMLDivElement {
  const el = div('it-cell it-num');
  el.textContent = content;
  return el;
}

function button(className: string, label: string, onClick: () => void): HTMLButtonElement {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = className;
  el.textContent = label;
  el.addEventListener('click', (ev) => {
    ev.preventDefault();
    // Stop the click reaching the canvas underneath, which would otherwise be
    // read as a steering/throttle press by the pointer input path.
    ev.stopPropagation();
    onClick();
  });
  return el;
}

function sortRows(rows: readonly ScreenResultRow[]): ScreenResultRow[] {
  // Unfinished racers sink to the bottom regardless of their position field.
  return [...rows].sort((a, b) => {
    const af = a.finished === false ? 1 : 0;
    const bf = b.finished === false ? 1 : 0;
    if (af !== bf) return af - bf;
    return a.position - b.position;
  });
}

function resultsSignature(rows: readonly ScreenResultRow[], playerPosition?: number): string {
  let s = `${playerPosition ?? 0}|`;
  for (const r of rows) {
    s += `${r.position}:${r.name}:${r.totalTime.toFixed(3)}:${r.bestLap.toFixed(3)}:${r.finished !== false ? 1 : 0};`;
  }
  return s;
}
