#!/usr/bin/env node
/**
 * Capture the same hull waterline shot at every quality tier.
 *
 * This is the visual half of the performance ladder: the probes prove the
 * numbers move; these frames prove low still looks like the game and ultra
 * still looks like the authored art.
 *
 *   node tools/tierCapture.mjs
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TIERS = ['low', 'medium', 'high', 'ultra'];

const run = (args) =>
  new Promise((resolve, reject) => {
    const child = spawn('node', args, { cwd: ROOT, stdio: 'inherit' });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
  });

for (const tier of TIERS) {
  await run([
    'tools/capture.mjs',
    '--shotfile',
    'tools/hullShots.mjs',
    '--only',
    'hull-idle-side',
    '--quality',
    tier,
    '--out',
    `shots/tiers/${tier}`,
  ]);
}

console.log('\n4-tier ladder -> shots/tiers/{low,medium,high,ultra}/hull-idle-side.png');
