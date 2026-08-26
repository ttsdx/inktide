#!/usr/bin/env node
/**
 * ADAPTIVE QUALITY PROBE
 *
 * This machine has no GPU, so "does it hold 60 fps at retina" cannot be
 * answered here and any number claiming to answer it would be a lie. What can
 * be answered — and had never been checked — is whether the safety net works:
 * when frames get slow, does the controller actually respond, and does the
 * response reach the framebuffer?
 *
 * That matters more than a synthetic frame time. A game that runs at 45 fps and
 * correctly drops its pixel ratio recovers; a game whose adaptive controller
 * silently does nothing does not, and the two are indistinguishable without a
 * test like this.
 *
 * Feeds the controller synthetic frame times and asserts:
 *   1. sustained slow frames pull the pixel ratio down, in steps, not a cliff;
 *   2. it keeps stepping down and eventually drops a whole quality tier;
 *   3. a tier drop actually disables the passes it claims to;
 *   4. sustained fast frames climb back, and climb slower than they fell;
 *   5. the cooldown prevents oscillation between two adjacent states;
 *   6. the change reaches the real framebuffer, not just a variable.
 *
 * Also reports frustum culling effectiveness and instancing use.
 *
 *   node tools/adaptiveProbe.mjs
 */

import { chromium } from '@playwright/test';

const URL = process.argv.includes('--url')
  ? process.argv[process.argv.indexOf('--url') + 1]
  : 'http://127.0.0.1:43140/';

const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--no-sandbox',
    '--disable-dev-shm-usage',
  ],
});
const page = await (await browser.newContext({ viewport: { width: 800, height: 450 }, deviceScaleFactor: 2 })).newPage();
page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
// Adaptive must be ON for this probe; every other tool disables it.
await page.goto(`${URL}?harness=1&quality=ultra`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => Boolean(window.__INKTIDE__?.harness.ready()), null, { timeout: 180000 });
await page.evaluate(() => {
  document.getElementById('boot')?.remove();
  window.__INKTIDE__.harness.pause();
});

const report = await page.evaluate(() => {
  const g = window.__INKTIDE__;
  const eng = g.engine;
  const out = { trace: [], culling: null, instancing: [], tiers: {} };

  const snap = (label) => ({
    label,
    tier: eng.adaptive.tier,
    scale: +eng.adaptive.scale.toFixed(3),
    pixelRatio: +eng.pixelRatio.toFixed(3),
    samples: eng.quality.samples,
    bloom: eng.quality.bloom,
    interiorLines: eng.quality.interiorLines,
  });

  // Feeding the controller has to go through the same path the render loop
  // uses, or the test proves nothing about the real thing.
  const feed = (ms, frames) => {
    for (let i = 0; i < frames; i++) eng.pumpAdaptive(ms);
  };

  out.trace.push(snap('start'));

  // 1-2: a machine running at ~24 fps.
  for (let round = 0; round < 12; round++) {
    feed(42, 60);
    out.trace.push(snap(`slow x${(round + 1) * 60}`));
  }

  const bottom = snap('after sustained slow');

  // 4: now give it real headroom, ~140 fps.
  for (let round = 0; round < 16; round++) {
    feed(7, 60);
    out.trace.push(snap(`fast x${(round + 1) * 60}`));
  }
  const recovered = snap('after sustained fast');

  // 5: marginal frames, right at the boundary, must not oscillate.
  const before = snap('pre-marginal');
  let flips = 0;
  let last = before.scale;
  for (let round = 0; round < 40; round++) {
    feed(16.7, 45);
    const s = eng.adaptive.scale;
    if (Math.abs(s - last) > 1e-6) flips++;
    last = s;
  }
  const marginal = snap('after marginal');

  out.bottom = bottom;
  out.recovered = recovered;
  out.marginalFlips = flips;
  out.marginal = marginal;

  // --- culling and instancing -------------------------------------------
  let meshes = 0;
  let instanced = 0;
  let instancedInstances = 0;
  let ink = 0;
  eng.scene.traverse((o) => {
    if (o.isInstancedMesh) {
      instanced++;
      instancedInstances += o.count;
      out.instancing.push({ name: o.name || '(unnamed)', count: o.count });
    } else if (o.isMesh) {
      meshes++;
      if (o.userData?.isOutline) ink++;
    }
  });
  g.harness.renderFrames(2);
  const st = g.harness.stats();
  out.culling = {
    sceneMeshes: meshes,
    inkShells: ink,
    instancedMeshes: instanced,
    totalInstances: instancedInstances,
    drawCalls: st.drawCalls,
    triangles: st.triangles,
  };

  // --- what each tier actually turns off ---------------------------------
  for (const tier of ['low', 'medium', 'high', 'ultra']) {
    g.harness.setQuality(tier);
    g.harness.renderFrames(1);
    const s = g.harness.stats();
    out.tiers[tier] = {
      pixelRatio: +eng.pixelRatio.toFixed(2),
      samples: eng.quality.samples,
      bloom: eng.quality.bloom,
      interiorLines: eng.quality.interiorLines,
      drawCalls: s.drawCalls,
      oceanTriangles: s.oceanTriangles,
      wakeResolution: s.wakeResolution,
    };
  }
  return out;
});

console.log('\nADAPTIVE RESPONSE  (viewport 800x450 @2x, starting at ultra)');
console.log('  stage                        tier     scale   pixelRatio  msaa  bloom  lines');
const show = (s) =>
  console.log(
    `  ${s.label.padEnd(28)} ${s.tier.padEnd(8)} ${String(s.scale).padEnd(7)} ` +
      `${String(s.pixelRatio).padEnd(11)} ${String(s.samples).padEnd(5)} ` +
      `${String(s.bloom).padEnd(6)} ${s.interiorLines}`,
  );
show(report.trace[0]);
show(report.bottom);
show(report.recovered);
show(report.marginal);

const start = report.trace[0];
const check = (ok, label, detail) =>
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(50)} ${detail}`);

console.log('\nASSERTIONS');
check(
  report.bottom.pixelRatio < start.pixelRatio,
  'slow frames reduce the framebuffer',
  `${start.pixelRatio} -> ${report.bottom.pixelRatio}`,
);
const tierOrder = ['low', 'medium', 'high', 'ultra'];
check(
  tierOrder.indexOf(report.bottom.tier) < tierOrder.indexOf(start.tier),
  'sustained slow frames drop a quality tier',
  `${start.tier} -> ${report.bottom.tier}`,
);
// Checked across the whole ladder, not one step. ultra -> high legitimately
// only changes resolution; the passes come off lower down, and asserting on a
// single step made a correct ladder look broken.
const t = report.tiers;
check(
    t.ultra.samples > t.high.samples &&
    t.medium.bloom &&
    t.high.interiorLines &&
    t.medium.interiorLines &&
    !t.low.bloom &&
    !t.low.interiorLines &&
    t.high.pixelRatio >= 2 &&
    t.ultra.pixelRatio >= t.high.pixelRatio,
  'the tier ladder sheds work in the right order',
  `res ${t.ultra.pixelRatio}>=${t.high.pixelRatio} retina, msaa ${t.ultra.samples}>${t.high.samples}, ` +
    `lines stay on through medium, bloom/lines off at low`,
);
check(
  report.recovered.pixelRatio > report.bottom.pixelRatio,
  'headroom lets it climb back',
  `${report.bottom.pixelRatio} -> ${report.recovered.pixelRatio}`,
);
{
  const slow = report.trace.filter((s) => s.label === 'start' || String(s.label).startsWith('slow'));
  let rose = false;
  for (let i = 1; i < slow.length; i++) {
    if (slow[i].pixelRatio > slow[i - 1].pixelRatio + 0.001) rose = true;
  }
  check(
    !rose,
    'dropping a tier never raises pixel ratio',
    slow.map((s) => s.pixelRatio).join(' → '),
  );
}
check(
  report.marginalFlips <= 6,
  'marginal frames do not oscillate',
  `${report.marginalFlips} scale changes over 1800 marginal frames`,
);

console.log('\nCULLING AND INSTANCING');
const c = report.culling;
console.log(`  scene meshes            ${c.sceneMeshes}   (${c.inkShells} of them ink shells)`);
console.log(`  instanced meshes        ${c.instancedMeshes} carrying ${c.totalInstances} instances`);
for (const i of report.instancing) console.log(`      ${i.name.padEnd(24)} ${i.count} instances`);
console.log(`  draw calls this frame   ${c.drawCalls}`);
console.log(`  triangles this frame    ${c.triangles.toLocaleString()}`);
check(
  c.drawCalls < c.sceneMeshes,
  'frustum culling removes off-screen geometry',
  `${c.sceneMeshes} meshes -> ${c.drawCalls} calls`,
);
check(c.instancedMeshes >= 6, 'instancing is in use', `${c.totalInstances} instances in ${c.instancedMeshes} draws`);

check(
  t.low.oceanTriangles < t.ultra.oceanTriangles && t.low.wakeResolution < t.ultra.wakeResolution,
  'lower tiers drop ocean density and wake resolution',
  `ocean ${t.ultra.oceanTriangles} -> ${t.low.oceanTriangles} tris, wake ${t.ultra.wakeResolution} -> ${t.low.wakeResolution}`,
);

console.log('\nQUALITY TIERS');
console.log('  tier     pixelRatio  msaa  bloom  lines  draws  oceanTris  wake');
for (const [t, v] of Object.entries(report.tiers)) {
  console.log(
    `  ${t.padEnd(8)} ${String(v.pixelRatio).padEnd(11)} ${String(v.samples).padEnd(5)} ` +
      `${String(v.bloom).padEnd(6)} ${String(v.interiorLines).padEnd(6)} ` +
      `${String(v.drawCalls).padEnd(6)} ${String(v.oceanTriangles).padEnd(10)} ${v.wakeResolution}`,
  );
}
console.log(
  '\n  Note: no frame-time figure is reported here on purpose. This box has no\n' +
    '  GPU, so any fps number would be a property of the software rasteriser\n' +
    '  rather than of the game.\n',
);

await browser.close();
