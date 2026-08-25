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

      // BAND AREA, which is the measure that actually matches the complaint.
      //
      // A wide brightness range can still come from one enormous flat region
      // plus a handful of bright crest pixels, and that is exactly what "the
      // near field is a single colour" means. Counting how much of the near
      // band the largest single tone owns catches it; the percentile spread
      // does not.
      const bins = new Map();
      let nearN = 0;
      for (let y = Math.floor(cv.height * 0.72); y < cv.height; y++) {
        for (let x = 0; x < cv.width; x += 2) {
          const i = (y * cv.width + x) * 4;
          // Quantise to 12 levels per channel: enough to merge anti-aliasing
          // and ripple jitter within a band, far too coarse to merge two.
          const key =
            (Math.round(d[i] / 21) << 16) | (Math.round(d[i + 1] / 21) << 8) | Math.round(d[i + 2] / 21);
          bins.set(key, (bins.get(key) ?? 0) + 1);
          nearN++;
        }
      }
      const shares = [...bins.values()].sort((a, b) => b - a).map((n) => n / nearN);

      return {
        label,
        p02: pct(0.02),
        p50: pct(0.5),
        p98: pct(0.98),
        range: +(pct(0.98) - pct(0.02)).toFixed(3),
        nearRange: +(nearHi - nearLo).toFixed(3),
        nearLo,
        meanSat,
        // Share of the near field owned by its single largest tone. Above about
        // 0.6 the region reads as one flat colour however wide its histogram is.
        nearTop: +shares[0].toFixed(3),
        // How many tones own a real share of it. Under three, there is no
        // banding to see.
        nearBands: shares.filter((s) => s >= 0.07).length,
      };
    },
    { label, apply },
  );
};

const bands = (x, y, z) => ({ uBands: { x, y, z } });

const rows = [];
rows.push(await measure('baseline (shipped)', null));
// The shipped thresholds were swept for tone alone and won on p02. The cost,
// which nothing was measuring at the time, is that they push the median into
// the deepest band too: the near field ends up owning one tone and reads as a
// flat mass however wide its histogram is. Sweep back down with band AREA in
// the scoring this time.
rows.push(await measure('0.62/0.79/0.92', bands(0.62, 0.79, 0.92)));
rows.push(await measure('0.64/0.81/0.93', bands(0.64, 0.81, 0.93)));
rows.push(await measure('0.64/0.78/0.90', bands(0.64, 0.78, 0.90)));
rows.push(await measure('0.64/0.84/0.95', bands(0.64, 0.84, 0.95)));
rows.push(await measure('0.66/0.83/0.94', bands(0.66, 0.83, 0.94)));
rows.push(await measure('0.68/0.82/0.92', bands(0.68, 0.82, 0.92)));

console.log('\nWATER TONE AND BAND AREA  (water-02 framing)');
console.log('  variant                p02    p50    p98    range  nearRange  nearTop  nearBands  meanSat');
for (const r of rows) {
  if (!r) continue;
  const flag = r.nearTop > 0.6 ? '  <- one flat tone' : r.nearBands < 3 ? '  <- too few bands' : '';
  console.log(
    `  ${r.label.padEnd(21)} ${String(r.p02).padEnd(6)} ${String(r.p50).padEnd(6)} ` +
      `${String(r.p98).padEnd(6)} ${String(r.range).padEnd(6)} ` +
      `${String(r.nearRange).padEnd(10)} ${String(r.nearTop).padEnd(8)} ` +
      `${String(r.nearBands).padEnd(10)} ${r.meanSat}${flag}`,
  );
}
console.log(`
  Wanted, together rather than one at a time:
    p02       0.30-0.45   a trough has to be a readable shadow
    range     above 0.45
    nearTop   below 0.55  no single tone may own the near field
    nearBands 3 or more   there has to be visible banding to look at
`);

await browser.close();
