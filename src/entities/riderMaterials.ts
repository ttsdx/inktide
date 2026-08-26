import { Color } from 'three';
import { PALETTE } from '../core/Palette.ts';
import { CelMaterial } from '../render/materials/CelMaterial.ts';

/**
 * Shared rider surfaces.
 *
 * Four racers used to each own five CelMaterials. The shader is identical
 * across them — only the accent paint changes — so that was twenty programs
 * and twenty uniform blocks for four characters. Suit, gear, skin and visor
 * are one set for the whole field; paint is one material per colour index.
 *
 * Do not dispose these from a rider teardown. They outlive any one instance.
 */

export interface RiderPalette {
  suit: CelMaterial;
  gear: CelMaterial;
  paint: CelMaterial;
  skin: CelMaterial;
  visor: CelMaterial;
}

let shared: Omit<RiderPalette, 'paint'> | null = null;
const paints: CelMaterial[] = [];

function sharedKit(): Omit<RiderPalette, 'paint'> {
  if (shared) return shared;
  shared = {
    suit: new CelMaterial({
      color: PALETTE.suit,
      rimColor: PALETTE.visor,
      rimStrength: 0.34,
      rimPower: 3.2,
      specStrength: 0.3,
      specSize: 0.22,
      matcapStrength: 0.16,
      name: 'RiderSuit',
    }),
    gear: new CelMaterial({
      color: PALETTE.suitLit,
      rimColor: PALETTE.visor,
      rimStrength: 0.42,
      rimPower: 2.8,
      specStrength: 0.62,
      specSize: 0.36,
      matcapStrength: 0.3,
      name: 'RiderGear',
    }),
    skin: new CelMaterial({
      color: PALETTE.skin,
      rimColor: PALETTE.skinShade,
      rimStrength: 0.25,
      rimPower: 3.5,
      specStrength: 0.12,
      specSize: 0.5,
      matcapStrength: 0.05,
      name: 'RiderSkin',
    }),
    visor: new CelMaterial({
      color: new Color().copy(PALETTE.visor).multiplyScalar(0.34),
      emissive: PALETTE.visor,
      emissiveStrength: 0.9,
      rimColor: PALETTE.visor,
      rimStrength: 1.1,
      rimPower: 2.0,
      specStrength: 1.0,
      specSize: 0.55,
      matcapStrength: 0.45,
      name: 'RiderVisor',
    }),
  };
  return shared;
}

export function riderMaterials(colorIndex: number): RiderPalette {
  const i = Math.max(0, Math.min(PALETTE.racer.length - 1, colorIndex | 0));
  if (!paints[i]) {
    const accent = PALETTE.racer[i];
    paints[i] = new CelMaterial({
      color: accent,
      rimColor: accent,
      rimStrength: 0.5,
      rimPower: 2.4,
      specStrength: 0.5,
      specSize: 0.3,
      matcapStrength: 0.22,
      name: `RiderPaint${i}`,
    });
  }
  return { ...sharedKit(), paint: paints[i] };
}
