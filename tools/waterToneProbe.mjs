#!/usr/bin/env node
/**
 * WATER TONE PROBE
 *
 * A visual critic measured the ocean at brightness 0.86-1.00 across an entire
 * frame — no dark tone anywhere, and a near-field band collapsing to a range of
 * 0.07. Eyeballing captures had not caught it, and one attempted fix was
 * reverted because "it looks the same", which is exactly the judgement a
 * measurement exists to replace.
 *
 * This renders the chase-height water shot, samples the water region, and
 * reports the brightness distribution. It then sweeps the candidate causes so
 * the fix is chosen against numbers.
 *
 * Target, from the reference games: the trough tone should reach V ~0.35-0.45
 * so a swell's shadow face is legible, with a total range above ~0.45.
 *
 *   node tools/waterToneProbe.mjs
 */

import { chromium } from '@playwright/test';

const URL = process.argv.includes('--url')
  ? process.argv[process.argv.indexOf('--url') + 1]
  : 'http://127.0.0.1:43140/';

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await (await browser.newContext({ viewport: { width: 700, height: 420 }, deviceScaleFactor: 1 })).newPage();
page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
await page.goto(`${URL}?harness=1&quality=high&adaptive=0`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => Boolean(window.__INKTIDE__?.harness.ready()), null, { timeout: 180000 });
await page.evaluate(() => {
  document.getElementById('boot')?.remove();
  window.__INKTIDE__.harness.pause();
});

const measure = async (label, apply) => {
  return await page.evaluate(
    ({ label, apply }) => {
      const g = window.__INKTIDE__;
      const u = g.ocean.material.uniforms;
      // Water-only camera, far from the grid so no boats or foam decals.
      g.harness.step(Math.max(0, Math.round((12 - g.harness.stats().elapsed) * 60)), 1 / 60, false);
      g.harness.setFreeCamera([600, 5.2, 600], [600, 0.5, 545]);
      if (apply) {
        for (const [k, v] of Object.entries(apply)) {
          if (k.startsWith('post:')) {
            g.harness.setPassUniform('composite', k.slice(5), v);
          } else if (u[k]) {
            if (v && typeof v === 'object' && u[k].value && u[k].value.isVector3) {
              u[k].value.set(v.x, v.y, v.z);
            } else {
              u[k].value = v;
            }
          }
        }
      }
      g.harness.renderFrames(3);

      const c = document.getElementById('scene');
      const cv = document.createElement('canvas');
      cv.width = c.width;
      cv.height = c.height;
      cv.getContext('2d').drawImage(c, 0, 0);
      const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;

      // Water occupies the lower ~55% of this framing.
      const y0 = Math.floor(cv.height * 0.45);
      const vals = [];
      const sats = [];
      for (let y = y0; y < cv.height; y++) {
        for (let x = 0; x < cv.width; x += 2) {
          const i = (y * cv.width + x) * 4;
          const r = d[i] / 255;
          const gg = d[i + 1] / 255;
          const b = d[i + 2] / 255;
          const mx = Math.max(r, gg, b);
          const mn = Math.min(r, gg, b);
          vals.push(mx);
          sats.push(mx === 0 ? 0 : (mx - mn) / mx);
        }
      }
      vals.sort((a, b) => a - b);
      const pct = (p) => +vals[Math.floor(vals.length * p)].toFixed(3);
      const meanSat = +(sats.reduce((a, b) => a + b, 0) / sats.length).toFixed(3);
      // Near band: the bottom fifth of the frame, where the critic measured the
      // worst collapse.
      const nearVals = [];
      for (let y = Math.floor(cv.height * 0.8); y < cv.height; y++) {
        for (let x = 0; x < cv.width; x += 2) {
          const i = (y * cv.width + x) * 4;
          nearVals.push(Math.max(d[i], d[i + 1], d[i + 2]) / 255);
        }
      }
      nearVals.sort((a, b) => a - b);
      const nearLo = +nearVals[Math.floor(nearVals.length * 0.02)].toFixed(3);
      const nearHi = +nearVals[Math.floor(nearVals.length * 0.98)].toFixed(3);

      return {
        label,
        p02: pct(0.02),
        p25: pct(0.25),
        p50: pct(0.5),
        p98: pct(0.98),
        range: +(pct(0.98) - pct(0.02)).toFixed(3),
        nearRange: +(nearHi - nearLo).toFixed(3),
        nearLo,
        meanSat,
      };
    },
    { label, apply },
  );
};

const rows = [];
rows.push(await measure('baseline', null));
rows.push(await measure('bands 0.40/0.62/0.82', { uBands: { x: 0.40, y: 0.62, z: 0.82 } }));
rows.push(await measure('bands 0.55/0.75/0.90', { uBands: { x: 0.55, y: 0.75, z: 0.90 } }));
rows.push(await measure('bands 0.70/0.85/0.95', { uBands: { x: 0.70, y: 0.85, z: 0.95 } }));
rows.push(await measure('0.55/0.75/0.90 lift .18', { uBands: { x: 0.55, y: 0.75, z: 0.90 }, uLiftStrength: 0.18 }));
rows.push(await measure('0.55/0.75/0.90 lift .18 dl 0', { uBands: { x: 0.55, y: 0.75, z: 0.90 }, uLiftStrength: 0.18, uDeepLift: 0.0 }));

console.log('\nWATER TONE  (water-02 framing, lower 55% of frame)');
console.log('  variant                 p02    p25    p50    p98    range  nearRange  nearLo  meanSat');
for (const r of rows) {
  if (!r) continue;
  console.log(
    `  ${r.label.padEnd(22)} ${String(r.p02).padEnd(6)} ${String(r.p25).padEnd(6)} ` +
      `${String(r.p50).padEnd(6)} ${String(r.p98).padEnd(6)} ${String(r.range).padEnd(6)} ` +
      `${String(r.nearRange).padEnd(10)} ${String(r.nearLo).padEnd(7)} ${r.meanSat}`,
  );
}
console.log(`
  Target: p02 around 0.35-0.45 so a trough is a readable shadow, total range
  above 0.45. The reference is Wave Race 64, where a swell's shadow face is
  legible from across a room.
`);

await browser.close();
