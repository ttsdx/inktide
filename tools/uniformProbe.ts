/**
 * HEADLESS UNIFORM PROBE
 *
 * Checks that every uniform a shader declares is actually defined on the
 * material that owns it.
 *
 * This exists because five of the ocean's were not. A ShaderMaterial uniform
 * missing from its uniforms map is never set and WebGL initialises it to zero,
 * so the shader compiles, the material renders, nothing throws, and the term
 * silently does nothing. Three of the layers the ocean's own file header lists
 * as the art direction had been switched off that way since they were written,
 * each with a paragraph above it describing behaviour that was not happening.
 * One of them, uFormRange, degenerated a divide into a hard step at almost
 * zero and flattened the largest term of the water's band coordinate into a
 * constant.
 *
 * Nothing else could have found it. It is invisible in a capture because the
 * result is merely a different-looking frame, invisible in review because the
 * declaration and the map are hundreds of lines apart, and invisible to the
 * tuning probes because they only write a uniform that already exists — so
 * every sweep of those five reported, accurately, that changing them did
 * nothing.
 *
 *   npx tsx tools/uniformProbe.ts
 */

import './domShim.ts';
import type { Mesh, Object3D, ShaderMaterial } from 'three';
import { Ocean } from '../src/world/Ocean.ts';
import { Sky } from '../src/world/Sky.ts';
import { Spray } from '../src/world/Spray.ts';
import { WakeField } from '../src/world/WakeField.ts';
import { RacingLine } from '../src/race/RacingLine.ts';
import { Course } from '../src/race/Course.ts';
import { CelMaterial } from '../src/render/materials/CelMaterial.ts';
import { BuoyField } from '../src/entities/Buoy.ts';
import { GateField } from '../src/entities/Gate.ts';
import { Boat } from '../src/entities/Boat.ts';
import { Rider } from '../src/entities/Rider.ts';
import { BOAT_SPECS } from '../src/entities/hullSpec.ts';

/**
 * Uniforms three.js declares for us in its shader prefix. A raw GLSL3
 * ShaderMaterial still receives these, so a shader may reference them without
 * the material having to list them.
 */
const BUILT_IN = new Set([
  'modelMatrix',
  'modelViewMatrix',
  'projectionMatrix',
  'viewMatrix',
  'normalMatrix',
  'cameraPosition',
  'isOrthographic',
  'instanceMatrix',
  'instanceColor',
  'logDepthBufFC',
  'bindMatrix',
  'bindMatrixInverse',
  'bindMatrixTexture',
]);

/** Every `uniform <type> <name>[array];` in a shader source. */
function declaredUniforms(src: string): string[] {
  const out: string[] = [];
  const re = /^\s*uniform\s+(?:highp|mediump|lowp\s+)?\w+\s+([A-Za-z_]\w*)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) out.push(m[1]);
  return out;
}

interface Problem {
  material: string;
  uniform: string;
}

const problems: Problem[] = [];
let checked = 0;
let materials = 0;

function check(label: string, mat: ShaderMaterial): void {
  materials++;
  const src = `${mat.vertexShader ?? ''}\n${mat.fragmentShader ?? ''}`;
  const seen = new Set<string>();
  for (const name of declaredUniforms(src)) {
    if (BUILT_IN.has(name) || seen.has(name)) continue;
    seen.add(name);
    checked++;
    if (!(name in (mat.uniforms ?? {}))) problems.push({ material: label, uniform: name });
  }
}

/**
 * Walk anything with an Object3D in it and check every ShaderMaterial found.
 *
 * Traversal rather than named accessors on purpose: a subsystem that grows a
 * second material should be covered without this file having to be edited,
 * since the whole point is to catch the material nobody remembered.
 */
function checkTree(label: string, root: Object3D): void {
  const seen = new Set<ShaderMaterial>();
  root.traverse((o) => {
    const mat = (o as Mesh).material as ShaderMaterial | ShaderMaterial[] | undefined;
    if (!mat) return;
    for (const m of Array.isArray(mat) ? mat : [m0(mat)]) {
      if (!m || !m.isShaderMaterial || seen.has(m)) continue;
      seen.add(m);
      check(`${label}/${m.name || o.name || 'unnamed'}`, m);
    }
  });
}
const m0 = (m: ShaderMaterial): ShaderMaterial => m;

const course = new Course();

const ocean = new Ocean();
check('Ocean', ocean.material);

checkTree('Sky', new Sky().group);
check('Spray', new Spray().material);
const line = new RacingLine(course);
check('RacingLine/body', line.material);
check('RacingLine/glow', line.glowMaterial);
checkTree('Buoy', new BuoyField(course).root);
checkTree('Gate', new GateField(course).root);
checkTree('Boat', (() => {
  const b = new Boat(BOAT_SPECS[0]);
  b.riderMount.add(new Rider(0).root);
  return b.root;
})());

check('CelMaterial', new CelMaterial());

// The wake's ping-pong passes own materials that never enter a scene graph, so
// they are the one case that has to be reached by hand.
const wake = new WakeField();
for (const m of Object.values(wake as unknown as Record<string, unknown>)) {
  const sm = m as ShaderMaterial;
  if (sm && (sm as { isShaderMaterial?: boolean }).isShaderMaterial) {
    check(`WakeField/${sm.name || 'unnamed'}`, sm);
  }
}

console.log(`\nUNIFORM COVERAGE\n  ${materials} materials, ${checked} declared uniforms\n`);
if (problems.length === 0) {
  console.log('  pass  every declared uniform is defined on its material\n');
} else {
  for (const p of problems) {
    console.log(`  FAIL  ${p.material.padEnd(22)} declares ${p.uniform} and never defines it`);
  }
  console.log(
    `\n  ${problems.length} uniform(s) will be zero at runtime. Whatever they gate is off.\n`,
  );
  process.exitCode = 1;
}
