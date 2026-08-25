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

/**
 * Reload before every variant.
 *
 * Restoring the uniforms between measurements was not enough. A control — the
 * same measurement taken first and again last — came back with the shadow tone
 * 36 degrees off the palette on the first pass and 3 degrees off on the last,
 * and the share of water inside the ocean family at 0.25 against 0.88. Nothing
 * in the sweep was isolated, so none of its rows could be compared, and the
 * values shipped from the previous run of it were chosen from noise.
 *
 * A fresh page per variant is slower and is the only version of this that can
 * be trusted. The control row exists to keep proving it.
 */
const reset = async () => {
  await page.goto(`${URL}?harness=1&quality=high&adaptive=0`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.__INKTIDE__?.harness.ready()), null, {
    timeout: 180000,
  });
  await page.evaluate(() => {
    document.getElementById('boot')?.remove();
    window.__INKTIDE__.harness.pause();
  });
};

const measure = async (label, apply) => {
  await reset();
  return await page.evaluate(
    ({ label, apply }) => {
      const g = window.__INKTIDE__;
      const u = g.ocean.material.uniforms;

      // Snapshot the shipped values once, and restore them before every
      // variant. Without this each measurement is taken on top of every
      // previous one, so a sweep of four separate uniforms reports the effect
      // of four accumulated changes and none of the rows can be compared —
      // which is exactly what the first run of this sweep did.
      if (!window.__TONE_BASE__) {
        const base = {};
        for (const [k, v] of Object.entries(u)) {
          const val = v.value;
          if (typeof val === 'number') base[k] = val;
          else if (val && val.isVector3) base[k] = { x: val.x, y: val.y, z: val.z };
          else if (val && val.isVector2) base[k] = { x: val.x, y: val.y };
        }
        window.__TONE_BASE__ = base;
      }
      for (const [k, v] of Object.entries(window.__TONE_BASE__)) {
        if (!u[k]) continue;
        if (typeof v === 'number') u[k].value = v;
        else if (u[k].value.isVector3) u[k].value.set(v.x, v.y, v.z);
        else if (u[k].value.isVector2) u[k].value.set(v.x, v.y);
      }
      // Water-only camera, far from the grid so no boats or foam decals.
      g.harness.step(Math.max(0, Math.round((12 - g.harness.stats().elapsed) * 60)), 1 / 60, false);
      g.harness.setFreeCamera([600, 5.2, 600], [600, 0.5, 545]);
      if (apply) {
        for (const [k, v] of Object.entries(apply)) {
          if (k.startsWith('post:')) {
            g.harness.setPassUniform('composite', k.slice(5), v);
          } else if (!u[k]) {
            // Loudly, rather than silently skipping. Five uniforms were
            // declared in the shader and never defined, and because this loop
            // quietly ignored anything it could not find, every sweep of them
            // reported that changing them made no difference.
            throw new Error(`waterToneProbe: no uniform named ${k}`);
          } else {
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

      // PALETTE FIDELITY AND DARK TONE.
      //
      // The two measures above see structure and nothing else, and a sweep
      // scored on structure alone will happily trade the committed palette
      // away to get it: switching on the fresnel lift, the sun plane and the
      // pre-filter together improved every structural number while moving 88%
      // of the water into hue 170-190 against an ocean family that runs
      // 187-215, and raising the darkest 2% of it to value 0.41 — no indigo
      // anywhere, and no shadow anywhere.
      const hsv = [];
      for (let y = y0; y < cv.height; y++) {
        for (let x = 0; x < cv.width; x += 2) {
          const i = (y * cv.width + x) * 4;
          const r = d[i] / 255;
          const gg = d[i + 1] / 255;
          const b = d[i + 2] / 255;
          const mx = Math.max(r, gg, b);
          const mn = Math.min(r, gg, b);
          let h = 0;
          if (mx > mn) {
            const c2 = mx - mn;
            if (mx === r) h = ((gg - b) / c2 + 6) % 6;
            else if (mx === gg) h = (b - r) / c2 + 2;
            else h = (r - gg) / c2 + 4;
            h *= 60;
          }
          hsv.push([mx, h]);
        }
      }
      hsv.sort((a, b) => a[0] - b[0]);
      const dark = hsv.slice(0, Math.max(1, Math.floor(hsv.length * 0.1)));
      const darkVal = +(dark.reduce((a, p) => a + p[0], 0) / dark.length).toFixed(3);
      const darkHue = +(dark.reduce((a, p) => a + p[1], 0) / dark.length).toFixed(1);
      // waterDeep is hue 215. How far the shadow tone has rotated off it.
      const darkHueErr = +Math.abs(darkHue - 215).toFixed(1);
      // Share of the water inside the ocean family's own hue range.
      const inFamily = +(
        (hsv.filter((p) => p[1] >= 185 && p[1] <= 220).length / hsv.length)
      ).toFixed(3);

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
        darkVal,
        darkHueErr,
        inFamily,
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
// The five uniforms below were declared in the shader and never defined, so
// they sat at zero and every earlier sweep of them silently did nothing — this
// probe only writes a uniform that already exists. Now that they are real, the
// values they were given are still only reasoned guesses, so sweep them.
rows.push(await measure('lift 0.0', { uLiftStrength: 0.0 }));
rows.push(await measure('lift 0.25', { uLiftStrength: 0.25 }));
rows.push(await measure('lift 0.5', { uLiftStrength: 0.5 }));
rows.push(await measure('sunPlane 0.0', { uSunPlaneStrength: 0.0 }));
rows.push(await measure('sunPlane 0.45', { uSunPlaneStrength: 0.45 }));
rows.push(await measure('sunPlane 1.0', { uSunPlaneStrength: 1.0 }));
rows.push(await measure('preFilter 0.0', { uPreFilterFloor: 0.0 }));
rows.push(await measure('preFilter 0.35', { uPreFilterFloor: 0.35 }));
rows.push(await measure('deepLift 0.0', { uDeepLift: 0.0 }));
// The bands are the other half of it: with formT finally a real variable, the
// coordinate no longer reaches the upper thresholds and the palette's top tones
// are unreachable — the mirror of the fault the thresholds were raised to fix.
rows.push(await measure('bands 0.42/0.60/0.80', bands(0.42, 0.60, 0.80)));
rows.push(await measure('bands 0.50/0.66/0.84', bands(0.50, 0.66, 0.84)));
rows.push(await measure('bands 0.56/0.72/0.88', bands(0.56, 0.72, 0.88)));
// The combination the numbers above point at.
rows.push(
  await measure('combined', {
    uLiftStrength: 0.25,
    uSunPlaneStrength: 0.45,
    uBands: { x: 0.50, y: 0.66, z: 0.84 },
  }),
);
// CONTROL. The same measurement as row one, taken last.
//
// If it does not match, the rows in between are not isolated and none of them
// can be compared — which is worth knowing before any of these numbers is used
// to pick a shipping value.
rows.push(await measure('baseline (control)', null));

console.log('\nWATER  (water-02 framing)');
console.log(
  '  variant                range  nearTop  nearBands  darkVal  darkHueErr  inFamily  meanSat',
);
for (const r of rows) {
  if (!r) continue;
  const fails = [];
  if (r.nearTop > 0.55) fails.push('flat');
  if (r.nearBands < 3) fails.push('bands');
  if (r.darkVal > 0.34) fails.push('no shadow');
  if (r.darkHueErr > 18) fails.push('hue');
  if (r.inFamily < 0.4) fails.push('off-palette');
  console.log(
    `  ${r.label.padEnd(21)} ${String(r.range).padEnd(6)} ${String(r.nearTop).padEnd(8)} ` +
      `${String(r.nearBands).padEnd(10)} ${String(r.darkVal).padEnd(8)} ` +
      `${String(r.darkHueErr).padEnd(11)} ${String(r.inFamily).padEnd(9)} ${r.meanSat}` +
      (fails.length ? `  <- ${fails.join(', ')}` : '  ok'),
  );
}
console.log(`
  All of these together, not one at a time:
    range      above 0.45
    nearTop    below 0.55   no single tone may own the near field
    nearBands  3 or more    there has to be visible banding to look at
    darkVal    below 0.34   the shadow tone has to actually be dark
    darkHueErr below 18 deg the shadow has to still be waterDeep's indigo
    inFamily   above 0.40   most of the water inside the ocean family's hues
`);

await browser.close();
