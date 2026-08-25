import {
  BoxGeometry,
  BufferGeometry,
  ConeGeometry,
  Float32BufferAttribute,
  Group,
  IcosahedronGeometry,
  Mesh,
  SphereGeometry,
  TorusKnotGeometry,
  CylinderGeometry,
  Vector3,
} from 'three';
import { CelMaterial } from '../render/materials/CelMaterial.ts';
import { outlineHierarchy } from '../render/OutlineHull.ts';
import { PALETTE } from '../core/Palette.ts';
import { LAYER_OPAQUE } from '../render/layers.ts';
import { sampleOcean } from '../world/gerstner.ts';

/**
 * A calibration scene for the cel pipeline, enabled with `?probe=1`.
 *
 * Layout, left to right: distance row lane at x=-22, mast at -11.5, ramp sphere
 * at -6, box at -2, knot at 2.4, cone at 6.4, icosahedron at 10, crease stack
 * at 14.5.
 *
 * Shipping art is a bad place to tune a shading model: if a hull looks wrong it
 * could be the ramp, the normals, the outline shell or the geometry, and you
 * cannot tell which. These primitives have known, trivially-correct normals, so
 * anything wrong in a probe frame is unambiguously the pipeline's fault.
 *
 * What each object is for:
 *   sphere      — the band thresholds. A sphere shows every N.L value at once,
 *                 so the ramp's step positions are directly readable.
 *   box         — hard edges. Verifies the inverted hull does not split open at
 *                 a 90-degree corner (the smoothed-normal attribute's job).
 *   torus knot  — self-occlusion and interior lines. The Sobel pass must find
 *                 the creases where the knot passes over itself without
 *                 double-inking the silhouette the hull shell already drew.
 *   cone        — a sharp apex, the worst case for an inverted hull (the shell
 *                 wants to fly off to infinity there).
 *   icosahedron — faceted flat shading against the ramp. Painted near-white on
 *                 purpose: any hue that appears on it was invented by the
 *                 shading model, which is how the matcap contamination was
 *                 caught.
 *   crease stack— stepped plates sharing one silhouette. The only object here
 *                 the inverted hull cannot line, so it is the only real test of
 *                 the screen-space edge pass.
 *   near/far row— the same sphere from 6 m to 94 m down a clear lane, to
 *                 confirm the outline is the same number of pixels wide at both.
 */
/**
 * The outline-width rig's eye point, elevation and stations (metres, degrees).
 *
 * Exported because `tools/probeShots.mjs` needs the identical numbers to place
 * probe-02's camera, and a rig whose camera has drifted from its geometry
 * measures nothing.
 */
export const ROW_EYE = [-22, 3.0, 26] as const;
export const ROW_ELEV_DEG = 10;
/**
 * [distance from ROW_EYE, bearing in degrees off the eye's -Z axis].
 *
 * The bearings are not evenly spaced, because the spheres are not evenly sized
 * on screen: a 1.2 m sphere at 7 m subtends 19.5 degrees and at 94 m it subtends
 * 1.5. An even 10-degree fan therefore had the nearest sphere sitting on top of
 * the second, which hid one of the two outlines being compared — the first
 * version of this rig produced a clean-looking frame that could not actually be
 * measured. Each gap is now wider than the mean angular size of the pair it
 * separates, and the 35-degree total span still fits inside the 42.8-degree half
 * field of view at 16:9.
 */
export const ROW_STATIONS = [
  [7, 12],
  [15, -6],
  [30, -15],
  [55, -20],
  [94, -23],
] as const;

export class ProbeScene {
  readonly root = new Group();
  private bobbers: Array<{ mesh: Mesh; phase: number; base: Vector3 }> = [];

  constructor() {
    this.root.name = 'ProbeScene';

    const add = (
      geo: import('three').BufferGeometry,
      color: import('three').Color,
      pos: [number, number, number],
      opts: Partial<ConstructorParameters<typeof CelMaterial>[0]> = {},
      still = false,
    ): Mesh => {
      const mesh = new Mesh(geo, new CelMaterial({ color: color.clone(), ...opts }));
      mesh.position.set(...pos);
      mesh.layers.set(LAYER_OPAQUE);
      this.root.add(mesh);
      // The measuring rig opts out of the bob: a ruler that moves is not a ruler.
      if (!still) {
        this.bobbers.push({ mesh, phase: this.bobbers.length * 1.3, base: mesh.position.clone() });
      }
      return mesh;
    };

    add(new SphereGeometry(1.6, 48, 32), PALETTE.racer[0], [-6, 2.4, 0]);
    add(new BoxGeometry(2.6, 2.6, 2.6), PALETTE.racer[1], [-2, 2.4, 0]);
    add(new TorusKnotGeometry(1.3, 0.42, 128, 20), PALETTE.racer[2], [2.4, 2.6, 0]);
    add(new ConeGeometry(1.3, 3.0, 24), PALETTE.racer[3], [6.4, 2.6, 0]);
    add(new IcosahedronGeometry(1.5, 0), PALETTE.foam, [10, 2.4, 0]);

    // A tall thin cylinder: the case where an inverted hull is most likely to
    // produce a visibly uneven line, because the shell's push is large relative
    // to the object's cross-section. It also proves the interior-line pass is
    // not doubling the ink, since on a 44 cm mast the front and back surfaces
    // are too close for any depth heuristic to separate.
    add(new CylinderGeometry(0.22, 0.22, 5, 12), PALETTE.uiCyan, [-11.5, 3.4, 3.5]);

    // CREASE STACK — the case the inverted hull physically cannot draw.
    //
    // Three plates stepped back and up, MERGED INTO ONE GEOMETRY so a single
    // shell wraps the whole thing. The shell then only inks the outer boundary
    // and the two internal steps exist in the frame if and only if the
    // screen-space edge pass finds them. Built as three separate meshes this
    // proved nothing, because each got its own shell and the hull drew all the
    // steps by itself — which is how the interior-line pass managed to look
    // "nearly working" for several rounds while doing almost nothing. Every
    // other primitive here is convex.
    add(ProbeScene.mergeBoxes([
      { size: [3.4, 0.6, 2.2], at: [0, 0, 0] },
      { size: [2.7, 0.6, 1.9], at: [0, 0.6, -0.45] },
      { size: [2.0, 0.6, 1.6], at: [0, 1.2, -0.9] },
    ]), PALETTE.suitLit, [14.5, 2.2, 0]);

    // OUTLINE WIDTH MEASURING RIG.
    //
    // Five identical spheres at 7, 15, 30, 55 and 94 m, placed by polar
    // coordinates about a fixed eye point rather than by eye. Two earlier
    // layouts — a straight lane down -Z, then a sideways fan — both failed as
    // measurements for the same reason: the spheres landed at different screen
    // heights against a mixture of water, foam and the horizon band, so an ink
    // width read off the frame was as much a measure of what happened to be
    // behind the sphere as of the outline.
    //
    // The fix is to treat this as instrumentation. Each sphere sits at a fixed
    // ELEVATION ANGLE from the eye, so they all land on the same screen row, and
    // the row is high enough that every one of them is silhouetted against clear
    // sky. The bearings fan to the left only, so the rig never crosses the
    // primitive lineup. probe-02-distance-row's camera is ROW_EYE looking down
    // the row's centre bearing; the two must be edited together.
    for (const [dist, bearingDeg] of ROW_STATIONS) {
      const a = (bearingDeg * Math.PI) / 180;
      add(
        new SphereGeometry(1.2, 32, 24),
        PALETTE.racingLine,
        [
          ROW_EYE[0] + dist * Math.sin(a),
          ROW_EYE[1] + dist * Math.tan((ROW_ELEV_DEG * Math.PI) / 180),
          ROW_EYE[2] - dist * Math.cos(a),
        ],
        { emissive: PALETTE.racingLine, emissiveStrength: 0.12 },
        true,
      );
    }

    outlineHierarchy(this.root, { widthPx: 2.6 });
    this.root.traverse((o) => o.layers.set(LAYER_OPAQUE));
  }

  /**
   * Concatenate box geometries into one non-indexed BufferGeometry.
   *
   * three has no merge helper in core, and the crease test specifically needs
   * ONE geometry so it gets ONE outline shell.
   */
  private static mergeBoxes(
    parts: Array<{ size: [number, number, number]; at: [number, number, number] }>,
  ): BufferGeometry {
    const pos: number[] = [];
    const nrm: number[] = [];
    for (const p of parts) {
      const box = new BoxGeometry(...p.size).toNonIndexed();
      const bp = box.getAttribute('position');
      const bn = box.getAttribute('normal');
      for (let i = 0; i < bp.count; i++) {
        pos.push(bp.getX(i) + p.at[0], bp.getY(i) + p.at[1], bp.getZ(i) + p.at[2]);
        nrm.push(bn.getX(i), bn.getY(i), bn.getZ(i));
      }
      box.dispose();
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new Float32BufferAttribute(nrm, 3));
    return geo;
  }

  update(elapsed: number): void {
    for (const b of this.bobbers) {
      const s = sampleOcean(b.base.x, b.base.z, elapsed);
      b.mesh.position.y = b.base.y + s.height;
      b.mesh.rotation.y = elapsed * 0.35 + b.phase;
      b.mesh.rotation.x = Math.sin(elapsed * 0.4 + b.phase) * 0.25;
    }
  }
}
