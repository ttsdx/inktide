import { CSS } from '../core/Palette.ts';
import {
  clamp01,
  drawText,
  panelPath,
  racerColor,
  triangle,
  type Ctx2D,
} from './hudPrimitives.ts';

/**
 * MINIMAP
 *
 * North-up, whole-course, with the player drawn as a heading arrow rather than a
 * dot.
 *
 * The alternative — rotating the map so the player's heading is always up — was
 * rejected on purpose. It wins for point-to-point tracks where only the next
 * hundred metres matter, but Ink Tide runs closed circuits over three laps, and
 * the thing the player actually needs from a lap-2 glance is *where the rivals
 * are on the loop*, which is a memorised shape. Spinning that shape under them
 * destroys the memory and costs an extra rotation of every gate mark per frame.
 * So the loop stays put, and the player's own facing is carried by the arrow.
 *
 * The projection is a uniform fit of the course bounds into the frame. Uniform,
 * not stretched, because a squashed circuit no longer matches the corner shapes
 * the player learned from the 3D view.
 */

export interface MinimapPoint {
  x: number;
  z: number;
}

export interface MinimapGate {
  x: number;
  z: number;
  /** Gate axis in world XZ — the line the racers cross. Normalised or not. */
  nx: number;
  nz: number;
}

export interface MinimapBlip {
  x: number;
  z: number;
  /** Forward vector in world XZ. Only the player's is used, for the heading arrow. */
  fx?: number;
  fz?: number;
  /** Palette index 0..3. */
  colorIndex: number;
  isPlayer?: boolean;
  finished?: boolean;
}

export interface MinimapData {
  /** Sampled course centreline in world XZ, in travel order, treated as closed. */
  path: readonly MinimapPoint[];
  gates?: readonly MinimapGate[];
  /** Start/finish line. Falls back to the first gate, then to path[0]. */
  startLine?: MinimapGate;
  blips: readonly MinimapBlip[];
  /** Index of the player's next gate, so it can be highlighted. */
  nextCheckpoint?: number;
}

interface Bounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export class Minimap {
  /** Cached fit, recomputed only when the course itself changes. */
  private fitFor: readonly MinimapPoint[] | null = null;
  private bounds: Bounds = { minX: -1, maxX: 1, minZ: -1, maxZ: 1 };
  private pulse = 0;
  /** Smoothed arrow heading so a single-frame yaw spike cannot make it jitter. */
  private arrow = 0;
  private arrowInit = false;

  /**
   * Draw the map into a `size`-square box with its top-left at (x, y).
   * `dt` drives the gate pulse and the arrow smoothing.
   */
  draw(c: Ctx2D, x: number, y: number, size: number, data: MinimapData, dt: number): void {
    this.pulse += dt;
    const path = data.path;
    if (path.length < 2) return;

    if (this.fitFor !== path) {
      this.bounds = computeBounds(path);
      this.fitFor = path;
    }

    const b = this.bounds;
    const pad = size * 0.12;
    const spanX = Math.max(1e-3, b.maxX - b.minX);
    const spanZ = Math.max(1e-3, b.maxZ - b.minZ);
    const scale = Math.min((size - pad * 2) / spanX, (size - pad * 2) / spanZ);
    const cx = x + size * 0.5;
    const cy = y + size * 0.5;
    const midX = (b.minX + b.maxX) * 0.5;
    const midZ = (b.minZ + b.maxZ) * 0.5;
    const px = (wx: number): number => cx + (wx - midX) * scale;
    const py = (wz: number): number => cy + (wz - midZ) * scale;

    const frame = panelPath(x, y, size, size, size * 0.07, size * 0.2);

    c.save();

    // --- frame -------------------------------------------------------------
    c.save();
    c.globalAlpha = 0.72;
    c.fillStyle = CSS.waterDeep;
    c.fill(frame);
    c.restore();

    // Everything after this is clipped, so a boat that has driven off the
    // course cannot smear a dot across the speedometer.
    c.save();
    c.clip(frame);

    // --- course ribbon -----------------------------------------------------
    const ribbon = new Path2D();
    ribbon.moveTo(px(path[0].x), py(path[0].z));
    for (let i = 1; i < path.length; i++) ribbon.lineTo(px(path[i].x), py(path[i].z));
    ribbon.closePath();

    c.lineJoin = 'round';
    c.lineCap = 'round';
    // Ink under-stroke first, coloured core second: the same two-pass trick the
    // 3D outline pass uses, so the map reads as part of the same drawing.
    c.strokeStyle = CSS.ink;
    c.lineWidth = Math.max(6, size * 0.075);
    c.stroke(ribbon);
    c.strokeStyle = CSS.cyan;
    c.lineWidth = Math.max(3, size * 0.042);
    c.stroke(ribbon);

    // --- checkpoint gates --------------------------------------------------
    const gates = data.gates ?? [];
    const tick = Math.max(4, size * 0.055);
    for (let i = 0; i < gates.length; i++) {
      const gate = gates[i];
      const len = Math.hypot(gate.nx, gate.nz) || 1;
      const ax = (gate.nx / len) * tick;
      const az = (gate.nz / len) * tick;
      const next = data.nextCheckpoint === i;
      // The next gate breathes; the rest are static. One moving mark is a
      // direction cue, five moving marks are noise.
      const grow = next ? 1 + Math.sin(this.pulse * 6.5) * 0.28 : 1;
      c.beginPath();
      c.moveTo(px(gate.x - ax * grow), py(gate.z - az * grow));
      c.lineTo(px(gate.x + ax * grow), py(gate.z + az * grow));
      c.lineCap = 'butt';
      c.strokeStyle = CSS.ink;
      c.lineWidth = Math.max(4, size * 0.038);
      c.stroke();
      c.strokeStyle = next ? CSS.green : CSS.foam;
      c.lineWidth = Math.max(2, size * 0.02);
      c.stroke();
    }

    // --- start / finish line ----------------------------------------------
    const start = data.startLine ?? gates[0] ?? null;
    if (start) {
      const len = Math.hypot(start.nx, start.nz) || 1;
      const ax = (start.nx / len) * tick * 1.7;
      const az = (start.nz / len) * tick * 1.7;
      const x0 = px(start.x - ax);
      const y0 = py(start.z - az);
      const x1 = px(start.x + ax);
      const y1 = py(start.z + az);
      c.beginPath();
      c.moveTo(x0, y0);
      c.lineTo(x1, y1);
      c.lineCap = 'butt';
      c.strokeStyle = CSS.ink;
      c.lineWidth = Math.max(7, size * 0.062);
      c.stroke();
      // Dashed rather than solid so it reads as a chequered flag line and not
      // as one more checkpoint.
      c.setLineDash([Math.max(3, size * 0.028), Math.max(3, size * 0.028)]);
      c.strokeStyle = CSS.amber;
      c.lineWidth = Math.max(4, size * 0.036);
      c.stroke();
      c.setLineDash([]);
    }

    // --- racers ------------------------------------------------------------
    // Rivals first, player last: the player's marker must never be occluded by
    // a boat it is overlapping with.
    const blips = data.blips;
    for (let pass = 0; pass < 2; pass++) {
      for (const blip of blips) {
        const isPlayer = blip.isPlayer === true;
        if ((pass === 0) === isPlayer) continue;
        const bx = px(blip.x);
        const by = py(blip.z);
        const color = racerColor(blip.colorIndex);
        if (isPlayer) {
          if (!this.arrowInit) {
            this.arrow = Math.atan2(blip.fz ?? 1, blip.fx ?? 0);
            this.arrowInit = true;
          } else {
            const target = Math.atan2(blip.fz ?? 1, blip.fx ?? 0);
            // Unwrap the shortest way round before smoothing, or the arrow spins
            // a full turn every time the heading crosses +/-PI.
            let delta = target - this.arrow;
            while (delta > Math.PI) delta -= Math.PI * 2;
            while (delta < -Math.PI) delta += Math.PI * 2;
            this.arrow += delta * (1 - Math.exp(-14 * dt));
          }
          triangle(c, bx, by, this.arrow, size * 0.085, color, CSS.ink, Math.max(2, size * 0.022));
        } else {
          const r = size * 0.042;
          c.beginPath();
          c.arc(bx, by, r, 0, Math.PI * 2);
          c.fillStyle = blip.finished ? CSS.inkSoft : color;
          c.fill();
          c.lineWidth = Math.max(1.5, size * 0.014);
          c.strokeStyle = CSS.ink;
          c.stroke();
        }
      }
    }

    c.restore(); // clip

    // --- frame outline on top so no mark can bleed over the edge ----------
    c.lineJoin = 'miter';
    c.miterLimit = 3;
    c.lineWidth = Math.max(2.5, size * 0.022);
    c.strokeStyle = CSS.ink;
    c.stroke(frame);

    // North tick: the only orientation cue a fixed map needs.
    drawText(c, 'N', x + size * 0.5, y + size * 0.035, {
      size: size * 0.1,
      fill: CSS.foam,
      align: 'center',
      alpha: 0.75,
      weight: 0.2,
      outline: 0.12,
    });

    c.restore();
  }
}

function computeBounds(path: readonly MinimapPoint[]): Bounds {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of path) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }
  // Force a square world window so the uniform fit does not leave the circuit
  // hugging one edge of the frame.
  const spanX = maxX - minX;
  const spanZ = maxZ - minZ;
  const span = Math.max(spanX, spanZ, 1);
  const cx = (minX + maxX) * 0.5;
  const cz = (minZ + maxZ) * 0.5;
  return {
    minX: cx - span * 0.5,
    maxX: cx + span * 0.5,
    minZ: cz - span * 0.5,
    maxZ: cz + span * 0.5,
  };
}

/** Exposed for the HUD's layout maths; keeps the magic 0.12 in one place. */
export const MINIMAP_PADDING_FRAC = 0.12;

/** Utility for callers that only have a 0..1 lap progress and want a blip. */
export function pointAtProgress(
  path: readonly MinimapPoint[],
  progress01: number,
): MinimapPoint | null {
  if (path.length === 0) return null;
  const t = clamp01(progress01) * path.length;
  const i = Math.min(path.length - 1, Math.floor(t));
  const j = (i + 1) % path.length;
  const f = t - i;
  return {
    x: path[i].x + (path[j].x - path[i].x) * f,
    z: path[i].z + (path[j].z - path[i].z) * f,
  };
}
