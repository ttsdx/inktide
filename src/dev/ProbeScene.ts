import {
  BoxGeometry,
  ConeGeometry,
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
    ): Mesh => {
      const mesh = new Mesh(geo, new CelMaterial({ color: color.clone(), ...opts }));
      mesh.position.set(...pos);
      mesh.layers.set(LAYER_OPAQUE);
      this.root.add(mesh);
      this.bobbers.push({ mesh, phase: this.bobbers.length * 1.3, base: mesh.position.clone() });
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
    // Three plates stepped back and up, sharing one silhouette from the front.
    // A hull shell only inks the outer boundary of that silhouette, so the two
    // internal steps are visible only if the screen-space edge pass finds them.
    // Every other primitive here is convex, which is why the interior-line
    // pass looked "nearly working" for so long: there was nothing for it to do.
    const stack = new Group();
    for (let i = 0; i < 3; i++) {
      const plate = new Mesh(
        new BoxGeometry(3.4 - i * 0.55, 0.55, 2.2),
        new CelMaterial({ color: PALETTE.suitLit.clone() }),
      );
      plate.position.set(0, i * 0.62, -i * 0.5);
      stack.add(plate);
    }
    stack.position.set(14.5, 2.0, 0);
    this.root.add(stack);
    this.bobbers.push({ mesh: stack as unknown as Mesh, phase: 4.1, base: stack.position.clone() });

    // Distance calibration row: identical spheres receding straight down -Z on
    // a clear lane, so a single frame can be measured end to end. They were
    // previously fanned sideways and ran behind the cylinder, which made the
    // near end unmeasurable.
    for (let i = 0; i < 5; i++) {
      add(new SphereGeometry(1.2, 32, 24), PALETTE.racingLine, [-22, 2.2, 6 - i * 22], {
        emissive: PALETTE.racingLine,
        emissiveStrength: 0.12,
      });
    }

    outlineHierarchy(this.root, { widthPx: 2.6 });
    this.root.traverse((o) => o.layers.set(LAYER_OPAQUE));
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
