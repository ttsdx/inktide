#!/usr/bin/env node
/**
 * PRIVATE WATER-SUBSYSTEM CAPTURE HARNESS
 *
 * Owned by the water sub-agent. tools/capture.mjs and tools/shots.mjs belong
 * to the integrating agent and are not touched by this file.
 *
 * Why this exists: WakeField and Spray are constructed and ticked by Game, and
 * Game does not know about them yet (another agent owns that file). Rather
 * than editing a file this agent does not own, this harness reaches into the
 * running page through window.__INKTIDE__, dynamically imports the two modules
 * from the dev server, wires them into the engine's update list and drives a
 * scripted boat around. Everything happens inside the browser, so the source
 * tree is untouched and the modules under test are the real ones.
 *
 * Usage:
 *   node tools/water-capture.mjs --url http://127.0.0.1:43121/ --out shots/wake-01
 */

import { chromium } from '@playwright/test';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/**
 * Shots that only make sense once there is a boat laying a wake. The scripted
 * boat is a pure function of time (see driveBoat below) so these are just as
 * reproducible as the main shot list.
 *
 * Camera positions are offsets from the boat, in world axes. The boat covers
 * about half a kilometre during this script, so an absolute camera would be
 * looking at empty ocean for every shot but the first — and worse, at water
 * the wake field does not even cover, which would silently "prove" that the
 * wake works by showing nothing wrong.
 *
 * `back` offsets are applied along the boat's own heading instead, for the
 * shots that need to look down the ribbon whichever way the boat is pointing.
 */
const SHOTS = [
  {
    id: 'wake-01-ribbon-behind',
    time: 16.0,
    camera: { back: 38, up: 8.5, side: 0, aimUp: 0.6, aimBack: -4 },
    description: 'Looking back down a straight-line wake. Persistence and dissipation.',
  },
  {
    id: 'wake-02-hard-turn',
    time: 26.0,
    camera: { back: 26, up: 13, side: 10, aimUp: 0.6, aimBack: 6 },
    description: 'Mid powerslide. The wake must curve and stay where it was laid.',
  },
  {
    id: 'wake-03-overhead-arc',
    time: 34.0,
    camera: { back: 20, up: 70, side: 0, aimUp: 0, aimBack: 34 },
    description: 'Overhead. The whole arc of wake at once — the shape test.',
  },
  {
    id: 'wake-04-bow-lobes',
    time: 40.0,
    camera: { back: 9, up: 4.2, side: 9, aimUp: 0.5, aimBack: 1 },
    description: 'Close on the bow. Kelvin lobes and the stern churn.',
  },
  {
    id: 'spray-01-burst',
    time: 44.0,
    camera: { back: 4, up: 2.6, side: 8, aimUp: 1.3, aimBack: 0 },
    description: 'Close on a spray burst. Droplet silhouettes, ink rim, quantised opacity.',
  },
  {
    id: 'spray-02-chase',
    time: 48.0,
    camera: { back: 15, up: 4.6, side: 1.5, aimUp: 1.1, aimBack: 0 },
    description: 'Spray from behind at chase height, against the water.',
  },
];

function parseArgs(argv) {
  const out = {
    url: 'http://127.0.0.1:43121/',
    outDir: path.join(ROOT, 'shots', 'water-wake'),
    scale: 1,
    width: 1100,
    height: 620,
    quality: 'ultra',
    only: null,
    timeout: 180000,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--url') out.url = next();
    else if (a === '--out') out.outDir = path.resolve(ROOT, next());
    else if (a === '--scale') out.scale = Number(next());
    else if (a === '--width') out.width = Number(next());
    else if (a === '--height') out.height = Number(next());
    else if (a === '--quality') out.quality = next();
    else if (a === '--only') out.only = next().split(',').map((s) => s.trim());
  }
  return out;
}

const args = parseArgs(process.argv);

/**
 * Runs in the page. Imports the two systems under test, builds a scripted boat
 * and installs an update hook on the engine. Returns once everything is live.
 */
async function installWaterRig() {
  const game = window.__INKTIDE__;
  const [{ WakeField }, { Spray }] = await Promise.all([
    import('/src/world/WakeField.ts'),
    import('/src/world/Spray.ts'),
  ]);
  const { oceanHeight } = await import('/src/world/gerstner.ts');

  const wake = new WakeField(game.engine.renderer, { resolution: 1024, halfExtent: 260 });
  const spray = new Spray({ capacity: 1200 });
  spray.setImpactSink((x, z, r, s) => wake.splash(x, z, r, s));
  game.engine.scene.add(spray.root);

  // A scripted boat: straight for a while, then a long hard turn, then a
  // series of launches off crests. Deterministic in t, so a capture at t=34
  // is the same boat state on every run.
  const state = {
    x: 0, z: 0, heading: 0, speed: 0, turnRate: 0,
    lastLandingT: -10, y: 0,
  };

  function driveBoat(t, dt) {
    const targetSpeed = t < 2 ? 0 : 27;
    state.speed += (targetSpeed - state.speed) * Math.min(1, dt * 0.9);
    // Straight until 18 s, then a sustained left-hand powerslide, then esses.
    let steer = 0;
    if (t > 18 && t < 30) steer = 0.9;
    else if (t >= 30) steer = Math.sin((t - 30) * 0.55) * 0.85;
    state.turnRate = steer * 0.62;
    state.heading += state.turnRate * dt;
    const fx = Math.sin(state.heading);
    const fz = -Math.cos(state.heading);
    state.x += fx * state.speed * dt;
    state.z += fz * state.speed * dt;
    state.y = oceanHeight(state.x, state.z, t);
    return { fx, fz };
  }

  const ctx = { dt: 1 / 60, elapsed: 0, frame: 0 };
  const emitters = [
    {
      position: { x: 0, y: 0, z: 0 },
      forward: { x: 0, y: 0, z: 1 },
      speed: 0,
      turnRate: 0,
      width: 1.5,
      strength: 1,
    },
  ];

  let lastBurst = 0;

  game.engine.onUpdate((dt, elapsed) => {
    const { fx, fz } = driveBoat(elapsed, dt);

    const e = emitters[0];
    e.position.x = state.x;
    e.position.y = state.y;
    e.position.z = state.z;
    e.forward.x = fx;
    e.forward.z = fz;
    e.speed = state.speed;
    e.turnRate = state.turnRate;
    e.strength = state.speed > 1 ? 1 : 0;

    wake.follow(state.x, state.z);
    wake.submit(emitters);

    ctx.dt = dt;
    ctx.elapsed = elapsed;
    ctx.frame++;
    wake.update(ctx);
    spray.update(ctx);

    game.ocean.setWakeField(wake.texture, wake.centerX, wake.centerZ, wake.extent);

    // Hull contact ring so the ocean's analytic foam term is exercised too.
    game.ocean.setContacts([
      {
        position: { x: state.x, y: state.y, z: state.z },
        radius: 3.4,
        strength: Math.min(1, state.speed / 14),
        forwardX: fx,
        forwardZ: fz,
      },
    ]);

    // Bow spray while moving, plus a heavier burst on hard steering.
    const hard = Math.abs(state.turnRate) > 0.35;
    const period = hard ? 0.055 : 0.14;
    if (state.speed > 6 && elapsed - lastBurst > period) {
      lastBurst = elapsed;
      const side = hard ? -Math.sign(state.turnRate) : 0;
      const rx = -fz * side * 1.3;
      const rz = fx * side * 1.3;
      spray.emit({
        position: {
          x: state.x + fx * 1.6 + rx,
          y: state.y + 0.5,
          z: state.z + fz * 1.6 + rz,
        },
        velocity: {
          x: fx * state.speed * 0.35 + rx * 3.2,
          y: 4.6 + (hard ? 3.2 : 0),
          z: fz * state.speed * 0.35 + rz * 3.2,
        },
        count: hard ? 26 : 12,
        spread: hard ? 1.5 : 0.9,
        size: 0.3,
        life: 1.15,
      });
    }
  });

  window.__WATER_RIG__ = { wake, spray, state };
}

async function main() {
  const shots = args.only ? SHOTS.filter((s) => args.only.includes(s.id)) : SHOTS;
  if (existsSync(args.outDir)) await rm(args.outDir, { recursive: true, force: true });
  await mkdir(args.outDir, { recursive: true });

  const browser = await chromium.launch({
    args: [
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--enable-webgl',
      '--ignore-gpu-blocklist',
      '--disable-gpu-sandbox',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-frame-rate-limit',
    ],
  });
  const context = await browser.newContext({
    viewport: { width: args.width, height: args.height },
    deviceScaleFactor: args.scale,
  });
  const page = await context.newPage();

  const consoleErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') {
      consoleErrors.push(`[${m.type()}] ${m.text()}`);
      if (m.type() === 'error') console.error('  page error:', m.text());
    }
  });
  page.on('pageerror', (e) => {
    consoleErrors.push(`[pageerror] ${e.message}`);
    console.error('  page exception:', e.message);
  });

  const url = new URL(args.url);
  url.searchParams.set('harness', '1');
  url.searchParams.set('quality', args.quality);
  url.searchParams.set('adaptive', '0');

  const results = [];
  let lastTime = 0;
  let booted = false;

  const boot = async () => {
    await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: args.timeout });
    await page.waitForFunction(() => Boolean(window.__INKTIDE__?.harness.ready()), null, {
      timeout: args.timeout,
    });
    await page.evaluate(() => {
      document.getElementById('boot')?.remove();
      window.__INKTIDE__.harness.pause();
    });
    await page.evaluate(installWaterRig);
    lastTime = 0;
    booted = true;
  };

  console.log(`\nLoading ${url} at ${args.width}x${args.height} @${args.scale}x`);
  await boot();

  for (const shot of shots) {
    const started = Date.now();
    process.stdout.write(`  ${shot.id.padEnd(26)} `);
    try {
      if (!booted || shot.time < lastTime) await boot();

      // The wake field is a simulation with memory, so unlike the main shot
      // list these cannot be fast-forwarded without rendering: skipping the
      // GPU passes would skip the wake itself. Game.simulateOnly still runs
      // every registered update hook, which is exactly what the field needs,
      // so stepping without rendering the *scene* is fine and much cheaper.
      const steps = Math.round((shot.time - lastTime) * 60);
      await page.evaluate((n) => window.__INKTIDE__.harness.step(n, 1 / 60, false), steps);
      lastTime = shot.time;

      await page.evaluate((cam) => {
        const s = window.__WATER_RIG__.state;
        const fx = Math.sin(s.heading);
        const fz = -Math.cos(s.heading);
        const rx = -fz;
        const rz = fx;
        const pos = [
          s.x - fx * cam.back + rx * cam.side,
          s.y + cam.up,
          s.z - fz * cam.back + rz * cam.side,
        ];
        const aim = [
          s.x - fx * cam.aimBack,
          s.y + cam.aimUp,
          s.z - fz * cam.aimBack,
        ];
        window.__INKTIDE__.harness.setFreeCamera(pos, aim);
      }, shot.camera);
      await page.evaluate(() => window.__INKTIDE__.harness.renderFrames(3));

      const file = path.join(args.outDir, `${shot.id}.png`);
      await page.locator('#scene').screenshot({ path: file, scale: 'device', timeout: 90000 });
      results.push({ id: shot.id, file, ms: Date.now() - started });
      console.log(`ok  (${Date.now() - started}ms)`);
    } catch (err) {
      console.log(`FAILED — ${err.message}`);
      results.push({ id: shot.id, error: String(err) });
      booted = false;
    }
  }

  await writeFile(
    path.join(args.outDir, 'report.json'),
    JSON.stringify({ args, results, consoleErrors: consoleErrors.slice(0, 100) }, null, 2),
  );
  await browser.close();

  const bad = results.filter((r) => r.error);
  console.log(`\n${results.length - bad.length}/${results.length} shots -> ${args.outDir}`);
  if (consoleErrors.length) {
    console.log(`${consoleErrors.length} console messages (first 8):`);
    consoleErrors.slice(0, 8).forEach((e) => console.log('  ' + e));
  }
  if (bad.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
