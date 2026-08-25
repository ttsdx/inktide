import {
  BoxGeometry,
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  Group,
  Mesh,
  Uint32BufferAttribute,
  Vector3,
} from 'three';
import { CelMaterial } from '../render/materials/CelMaterial.ts';
import { PALETTE } from '../core/Palette.ts';
import { LAYER_OPAQUE } from '../render/layers.ts';
import { sampleOcean } from '../world/gerstner.ts';

/**
 * WATERLINE CALIBRATION RIG — enabled with `?waterline=1`.
 *
 * Answers one question with a number instead of an opinion: at a given distance
 * from the camera, is the water drawn at the same height the CPU sampler says
 * it is?
 *
 * Every floating thing in the game that is not a boat — buoys, gate collars,
 * the racing-line ribbon — is positioned from `sampleOcean`. If the vertex
 * shader displaces the surface to a different height than the sampler reports,
 * all of them hover or sink, and no amount of tuning their local offsets will
 * fix it because the error changes with the wave phase underneath them.
 *
 * Eyeballing a capture cannot separate "hovers by 5 cm" from "hovers by 80 cm"
 * from "sits correctly and just lacks a foam ring", and those three have
 * completely different causes. So this rig is built as instrumentation:
 *
 *   STAFF — a graduated pole whose zero is placed at exactly the sampled
 *     height. Bands are 10 cm, alternating ink and foam, with the band below
 *     zero painted warning red so the zero line is unmistakable. Where the
 *     water crosses the staff, read the error off directly in centimetres.
 *
 *   PLATE — a horizontal square, 6 m across, centred at exactly the sampled
 *     height. If the sampler and the shader agree the plate is awash: cut in
 *     half by the surface along its whole length. Any gap under it, or any
 *     part of it missing, is the error. The plate is the only readable
 *     instrument past a hundred metres, where the staff's bands are sub-pixel.
 *
 * Stations run away from a fixed eye point so one capture covers the whole
 * distance range at once. Staff and band sizes grow with distance so each
 * station subtends roughly the same angle; the metre value of a band is
 * therefore different per station and is printed in the shot list.
 */

/** Eye point the stations are laid out for. `tools/waterlineShots.mjs` matches it. */
export const RIG_EYE = [1800, 2.4, 1800] as const;

/**
 * Distance from the eye for each station, and the metre height of one band on
 * that station's staff. Near stations are the fine instrument; far stations
 * exist to catch a gross whole-field offset.
 */
export const RIG_STATIONS: ReadonlyArray<{ dist: number; band: number; bearing: number }> = [
  { dist: 6, band: 0.1, bearing: 0.34 },
  { dist: 18, band: 0.1, bearing: 0.13 },
  { dist: 45, band: 0.25, bearing: -0.05 },
  { dist: 120, band: 0.5, bearing: -0.2 },
  { dist: 320, band: 1.0, bearing: -0.32 },
  { dist: 700, band: 2.0, bearing: -0.42 },
];

interface Station {
  staff: Mesh;
  plate: Mesh;
  x: number;
  z: number;
}

export class WaterlineRig {
  readonly root = new Group();
  private readonly stations: Station[] = [];

  constructor() {
    this.root.name = 'WaterlineRig';

    for (const s of RIG_STATIONS) {
      // Stations fan out to one side of the eye's -Z axis so none occludes the
      // one behind it.
      const x = RIG_EYE[0] + Math.sin(s.bearing) * s.dist;
      const z = RIG_EYE[2] - Math.cos(s.bearing) * s.dist;

      const staff = new Mesh(
        buildStaff(s.band, s.dist * 0.014),
        new CelMaterial({
          color: new Color(1, 1, 1),
          vertexColors: true,
          // Flat and unlit as far as the ramp allows: this is a ruler, and a
          // band that changes value with the sun is a band that cannot be
          // counted against its neighbour.
          specStrength: 0,
          matcapStrength: 0,
          rimStrength: 0,
          name: 'WaterlineStaff',
        }),
      );
      staff.position.set(x, 0, z);
      staff.layers.set(LAYER_OPAQUE);
      this.root.add(staff);

      const plateSize = Math.max(6, s.dist * 0.22);
      const plate = new Mesh(
        new BoxGeometry(plateSize, 0.04, plateSize),
        new CelMaterial({
          color: PALETTE.uiAmber,
          rampTint: PALETTE.uiAmber,
          specStrength: 0,
          matcapStrength: 0,
          rimStrength: 0,
          name: 'WaterlinePlate',
        }),
      );
      // Offset to the side of the staff so the two instruments do not overlap.
      plate.position.set(x + plateSize * 0.9, 0, z);
      plate.layers.set(LAYER_OPAQUE);
      this.root.add(plate);

      this.stations.push({ staff, plate, x, z });
    }
  }

  update(elapsed: number): void {
    for (const s of this.stations) {
      s.staff.position.y = sampleOcean(s.staff.position.x, s.staff.position.z, elapsed).height;
      s.plate.position.y = sampleOcean(s.plate.position.x, s.plate.position.z, elapsed).height;
    }
  }

  dispose(): void {
    for (const s of this.stations) {
      s.staff.geometry.dispose();
      s.plate.geometry.dispose();
      (s.staff.material as CelMaterial).dispose();
      (s.plate.material as CelMaterial).dispose();
    }
  }
}

/**
 * A square-section pole banded every `band` metres, with local y = 0 at the
 * boundary between the red band below and the first light band above.
 *
 * Deliberately not outlined: an ink contour on a 10 cm band is wider than the
 * band, and the instrument's whole value is that the boundaries are crisp.
 */
function buildStaff(band: number, halfThickness: number): BufferGeometry {
  const below = 12; // bands below zero
  const above = 20;
  const t = Math.max(0.02, halfThickness);

  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  const dark = PALETTE.ink;
  const light = PALETTE.foam;
  const zero = PALETTE.warn;

  for (let i = -below; i < above; i++) {
    const y0 = i * band;
    const y1 = (i + 1) * band;
    // The single band immediately under zero is red, so the zero line reads at
    // a glance without counting from the bottom of the pole.
    const c = i === -1 ? zero : i % 2 === 0 ? light : dark;

    // Four side quads of a box segment. No top or bottom faces: the segments
    // stack into a continuous pole and interior caps would z-fight.
    const corners: Array<[number, number]> = [
      [-t, -t],
      [t, -t],
      [t, t],
      [-t, t],
    ];
    const base = positions.length / 3;
    for (const [cx, cz] of corners) {
      positions.push(cx, y0, cz);
      colors.push(c.r, c.g, c.b);
      positions.push(cx, y1, cz);
      colors.push(c.r, c.g, c.b);
    }
    for (let e = 0; e < 4; e++) {
      const a = base + e * 2;
      const b = base + ((e + 1) % 4) * 2;
      indices.push(a, b, a + 1);
      indices.push(a + 1, b, b + 1);
    }
  }

  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geo.setAttribute('color', new Float32BufferAttribute(colors, 3));
  geo.setIndex(new Uint32BufferAttribute(indices, 1));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/** World position of a station, for a shot that wants to frame one directly. */
export function stationPosition(index: number, out: Vector3): Vector3 {
  const s = RIG_STATIONS[Math.max(0, Math.min(RIG_STATIONS.length - 1, index))];
  return out.set(
    RIG_EYE[0] + Math.sin(s.bearing) * s.dist,
    0,
    RIG_EYE[2] - Math.cos(s.bearing) * s.dist,
  );
}
