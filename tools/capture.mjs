#!/usr/bin/env node
/**
 * INK TIDE SCREENSHOT HARNESS
 *
 * Loads the game in headless Chromium with a real GPU-backed WebGL2 context,
 * drives the simulation to an exact deterministic moment, and captures frames
 * at retina resolution from a set of named camera angles.
 *
 * Every visual claim in this project is verified against output from this tool.
 * Nothing is verified by reading the shader source and assuming.
 *
 * Usage:
 *   node tools/capture.mjs                       # the full default shot list
 *   node tools/capture.mjs --shots water,cel     # only named groups
 *   node tools/capture.mjs --out shots/run-3     # output directory
 *   node tools/capture.mjs --scale 2             # device pixel ratio
 *   node tools/capture.mjs --list                # print available shots
 *
 * Determinism: the page is loaded with the render loop stopped. We then step
 * the simulation with a fixed 1/60 dt, so shot "t=12.0s" is byte-for-byte the
 * same moment on every run and every machine.
 */

import { chromium } from '@playwright/test';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// The shot list is swappable so a subsystem can keep its own adversarial angles
// without editing the shared list.
const shotFileArg = process.argv.includes('--shotfile')
  ? process.argv[process.argv.indexOf('--shotfile') + 1]
  : 'tools/shots.mjs';
const { SHOTS, SHOT_GROUPS } = await import(
  pathToFileURL(path.resolve(ROOT, shotFileArg)).href,
);

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {
    url: 'http://127.0.0.1:43117/',
    outDir: path.join(ROOT, 'shots', 'latest'),
    scale: 2,
    width: 1600,
    height: 900,
    groups: null,
    only: null,
    list: false,
    quality: 'ultra',
    keepOpen: false,
    probe: false,
    timeout: 120000,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--url') out.url = next();
    else if (a === '--out') out.outDir = path.resolve(ROOT, next());
    else if (a === '--scale') out.scale = Number(next());
    else if (a === '--width') out.width = Number(next());
    else if (a === '--height') out.height = Number(next());
    else if (a === '--shots') out.groups = next().split(',').map((s) => s.trim());
    else if (a === '--only') out.only = next().split(',').map((s) => s.trim());
    else if (a === '--quality') out.quality = next();
    else if (a === '--shotfile') next();
    else if (a === '--probe') out.probe = true;
    else if (a === '--list') out.list = true;
    else if (a === '--timeout') out.timeout = Number(next());
    else if (a === '--help' || a === '-h') {
      console.log(HELP);
      process.exit(0);
    }
  }
  return out;
}

const HELP = `
Ink Tide capture harness

  --url <url>        dev server url        (default http://127.0.0.1:43117/)
  --out <dir>        output directory      (default shots/latest)
  --scale <n>        device pixel ratio    (default 2, i.e. retina)
  --width <n>        css viewport width    (default 1600)
  --height <n>       css viewport height   (default 900)
  --shots <a,b>      only these groups     (${Object.keys(SHOT_GROUPS).join(', ')})
  --only <a,b>       only these shot ids
  --quality <tier>   low|medium|high|ultra (default ultra)
  --list             list shots and exit
`;

const args = parseArgs(process.argv);

if (args.list) {
  console.log('Groups:', Object.keys(SHOT_GROUPS).join(', '));
  for (const s of SHOTS) {
    console.log(`  ${s.id.padEnd(28)} [${s.group}] ${s.description ?? ''}`);
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// capture
// ---------------------------------------------------------------------------

async function main() {
  let shots = SHOTS;
  if (args.groups) shots = shots.filter((s) => args.groups.includes(s.group));
  if (args.only) shots = shots.filter((s) => args.only.includes(s.id));
  if (shots.length === 0) {
    console.error('No shots matched.');
    process.exit(1);
  }

  if (existsSync(args.outDir)) await rm(args.outDir, { recursive: true, force: true });
  await mkdir(args.outDir, { recursive: true });

  const browser = await chromium.launch({
    args: [
      // Force a real ANGLE/SwiftShader GL backend. Without these, headless
      // Chromium hands back a software rasteriser with no WebGL2 MRT support
      // and every capture comes back as a black frame.
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--enable-webgl',
      '--enable-webgl2-compute-context',
      '--ignore-gpu-blocklist',
      '--disable-gpu-sandbox',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--enable-features=Vulkan',
      '--disable-frame-rate-limit',
    ],
  });

  const context = await browser.newContext({
    viewport: { width: args.width, height: args.height },
    deviceScaleFactor: args.scale,
    reducedMotion: 'no-preference',
  });

  const page = await context.newPage();

  const consoleErrors = [];
  page.on('console', (msg) => {
    const t = msg.type();
    if (t === 'error' || t === 'warning') {
      const text = msg.text();
      consoleErrors.push(`[${t}] ${text}`);
      if (t === 'error') console.error('  page error:', text);
    }
  });
  page.on('pageerror', (err) => {
    consoleErrors.push(`[pageerror] ${err.message}`);
    console.error('  page exception:', err.message);
  });

  const url = new URL(args.url);
  url.searchParams.set('harness', '1');
  url.searchParams.set('quality', args.quality);
  url.searchParams.set('adaptive', '0');
  if (args.probe) url.searchParams.set('probe', '1');

  console.log(`\nLoading ${url.toString()} at ${args.width}x${args.height} @${args.scale}x`);
  await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: args.timeout });

  // Wait for the game object and its first compiled frame.
  await page.waitForFunction(
    () => Boolean(window.__INKTIDE__ && window.__INKTIDE__.harness.ready()),
    null,
    { timeout: args.timeout },
  );

  // Freeze the render loop so every subsequent step is exact, and drop the
  // boot splash — it fades out on a timer that a paused page never reaches.
  await page.evaluate(() => {
    document.getElementById('boot')?.remove();
    window.__INKTIDE__.harness.pause();
  });

  const results = [];
  let lastTime = 0;

  for (const shot of shots) {
    const started = Date.now();
    process.stdout.write(`  ${shot.id.padEnd(30)} `);

    try {
      // Re-seek from zero when a shot needs an earlier moment than the last.
      if (shot.time < lastTime) {
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForFunction(
          () => Boolean(window.__INKTIDE__ && window.__INKTIDE__.harness.ready()),
          null,
          { timeout: args.timeout },
        );
        await page.evaluate(() => {
          document.getElementById('boot')?.remove();
          window.__INKTIDE__.harness.pause();
        });
        lastTime = 0;
      }

      await page.evaluate(applyShot, { shot, from: lastTime });
      lastTime = shot.time;

      // Render a few real frames after the state change: the first compiles any
      // shader variant this angle needs, the rest let camera springs and the
      // wake field settle so the capture is not a half-initialised frame.
      await page.evaluate(() => window.__INKTIDE__.harness.renderFrames(3));

      const file = path.join(args.outDir, `${shot.id}.png`);
      if (shot.includeHud) {
        // Full-page capture so the DOM/canvas HUD overlay is included.
        await page.screenshot({ path: file, scale: 'device', animations: 'disabled', timeout: 240000 });
      } else {
        // Read the WebGL canvas directly. The renderer is created with
        // preserveDrawingBuffer, so this returns the exact framebuffer at
        // device resolution — no compositor round-trip, and none of
        // Playwright's element-stability waiting, which times out on a paused
        // page under a software rasteriser.
        const dataUrl = await page.evaluate(() => {
          const c = document.getElementById('scene');
          return c.toDataURL('image/png');
        });
        await writeFile(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
      }

      const stats = await page.evaluate(() => window.__INKTIDE__.harness.stats());
      results.push({ id: shot.id, group: shot.group, file, stats, ms: Date.now() - started });
      console.log(`ok  (${Date.now() - started}ms, ${stats.drawCalls} calls, ${(stats.triangles / 1000).toFixed(0)}k tris)`);
    } catch (err) {
      console.log(`FAILED — ${err.message}`);
      results.push({ id: shot.id, group: shot.group, error: String(err) });
    }
  }

  // Contact sheet so a critic can look at everything in one image.
  await writeContactSheet(page, args.outDir, results);

  await writeFile(
    path.join(args.outDir, 'report.json'),
    JSON.stringify(
      { capturedAt: new Date().toISOString(), args, results, consoleErrors: consoleErrors.slice(0, 200) },
      null,
      2,
    ),
  );

  await browser.close();

  const failures = results.filter((r) => r.error);
  console.log(`\n${results.length - failures.length}/${results.length} shots captured -> ${args.outDir}`);
  if (consoleErrors.length) {
    console.log(`\n${consoleErrors.length} console messages (first 10):`);
    consoleErrors.slice(0, 10).forEach((e) => console.log('  ' + e));
  }
  if (failures.length) process.exitCode = 1;
}

/**
 * Runs inside the page. Applies a shot definition: sets input, advances the
 * simulation to the shot's timestamp, then positions the camera.
 */
function applyShot({ shot, from }) {
  const h = window.__INKTIDE__.harness;
  const dt = 1 / 60;

  if (shot.setup) {
    // Shot setups are serialised as a plain data description, never a closure,
    // because closures cannot cross the Playwright boundary.
    for (const [key, value] of Object.entries(shot.setup)) {
      const fn = h[key];
      if (typeof fn === 'function') fn(...(Array.isArray(value) ? value : [value]));
    }
  }

  h.setInput(shot.input ?? null);

  // Fast-forward without rendering, then set the camera, then render for real.
  const steps = Math.max(0, Math.round((shot.time - from) / dt));
  h.step(steps, dt, false);

  if (shot.camera) {
    const c = shot.camera;
    if (c.mode === 'free') h.setFreeCamera(c.position, c.target);
    else if (c.mode === 'orbit') h.setOrbit(c.angle ?? 0, c.radius ?? 26, c.height ?? 9);
    else if (c.mode === 'boat') {
      // Framed relative to the boat's own heading, so a shot stays composed
      // wherever on the circuit the racer has got to by the target time.
      h.frameBoat(c.index ?? 0, c.yaw ?? 0, c.pitch ?? 0.2, c.distance ?? 8, c.lookHeight ?? 1.0);
    } else if (c.mode === 'prop') {
      h.frameProp(c.kind ?? 'buoy', c.index ?? 0, c.yaw ?? 0, c.pitch ?? 0, c.distance ?? 6, c.lookHeight ?? 0);
    } else h.setCamera(c.mode);
  }
}

/** Build a simple HTML contact sheet next to the PNGs. */
async function writeContactSheet(page, outDir, results) {
  const ok = results.filter((r) => !r.error);
  const html = `<!doctype html><meta charset="utf-8">
<title>Ink Tide — capture ${new Date().toISOString()}</title>
<style>
  body{background:#0a1226;color:#eefaff;font:13px/1.5 ui-monospace,monospace;margin:0;padding:24px}
  h1{font:700 20px/1.2 system-ui;letter-spacing:.08em;text-transform:uppercase}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(520px,1fr));gap:18px;margin-top:20px}
  figure{margin:0;background:#101c38;border:1px solid #1e3a63;border-radius:10px;overflow:hidden}
  img{width:100%;display:block;background:#000}
  figcaption{padding:8px 12px;display:flex;justify-content:space-between;gap:10px}
  .id{color:#8ff4ff}
  .meta{opacity:.55}
</style>
<h1>Ink Tide capture &mdash; ${ok.length} frames</h1>
<div class="grid">
${ok
  .map(
    (r) => `<figure>
  <img src="${path.basename(r.file)}" loading="lazy">
  <figcaption><span class="id">${r.id}</span>
  <span class="meta">${r.stats.drawCalls} calls · ${(r.stats.triangles / 1000).toFixed(0)}k tris</span></figcaption>
</figure>`,
  )
  .join('\n')}
</div>`;
  await writeFile(path.join(outDir, 'index.html'), html);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
