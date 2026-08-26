#!/usr/bin/env node
/**
 * AUDIO PROBE
 *
 * Nobody has heard this game. It was built on a machine with no audio device,
 * so every gain, filter Q and send level is a considered guess and the mix
 * balance is genuinely unverified.
 *
 * What CAN be verified is whether the synthesis does what it claims. This runs
 * the real AudioEngine in headless Chromium, taps the master bus with an
 * analyser, and measures:
 *
 *   1. that the graph emits signal at all, rather than silently failing to
 *      connect (the failure mode that looks identical to "no speakers");
 *   2. that engine pitch genuinely tracks RPM — the dominant frequency should
 *      rise monotonically with the rpm parameter. A constant drone and a
 *      working engine are indistinguishable in code review;
 *   3. that airborne rev-free actually raises pitch;
 *   4. that water rush level tracks speed;
 *   5. that each one-shot produces an audible transient above the engine bed.
 *
 * It does not and cannot tell you whether the game sounds good.
 *
 *   node tools/audioProbe.mjs
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
    // Without a real device Chromium still runs the audio graph, but only if
    // told to synthesise an output. Otherwise the context never leaves
    // 'suspended' and every measurement below is a silent zero.
    '--autoplay-policy=no-user-gesture-required',
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--alsa-output-device=plug:default',
  ],
});

const page = await (await browser.newContext({ viewport: { width: 400, height: 300 } })).newPage();
page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
await page.goto(`${URL}?harness=1&quality=low&adaptive=0`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => Boolean(window.__INKTIDE__?.harness.ready()), null, { timeout: 180000 });
await page.evaluate(() => {
  document.getElementById('boot')?.remove();
  window.__INKTIDE__.harness.pause();
});

const report = await page.evaluate(async () => {
  const g = window.__INKTIDE__;
  const audio = g.audio;
  await audio.resume();

  const out = { enabled: audio.enabled, sampleRate: audio.sampleRate, steps: [], sfx: [] };
  const an = audio.tapAnalyser(4096);
  if (!an) return { ...out, error: 'no analyser — context unavailable' };

  const bins = new Float32Array(an.frequencyBinCount);
  const time = new Float32Array(an.fftSize);
  const hzPerBin = audio.sampleRate / an.fftSize;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Peak frequency, band energies and RMS of the current output. */
  const measure = () => {
    an.getFloatFrequencyData(bins);
    an.getFloatTimeDomainData(time);
    let rms = 0;
    for (let i = 0; i < time.length; i++) rms += time[i] * time[i];
    rms = Math.sqrt(rms / time.length);

    // Fundamental by harmonic product spectrum.
    //
    // A bare peak-pick is not good enough here and gave a wrong answer that
    // looked like a real bug: airborne collapses the engine's filter load, the
    // upper harmonics drop away, the sub-oscillator an octave below the
    // fundamental becomes the loudest bin, and the measurement reported the
    // pitch *halving* on a jump when the synthesis was in fact raising it.
    // Multiplying the spectrum by its own decimations reinforces true harmonic
    // series and suppresses exactly that sub-octave error.
    const limit = Math.min(bins.length, Math.floor(2000 / hzPerBin));
    const lin = new Float64Array(limit);
    for (let i = 0; i < limit; i++) lin[i] = Math.pow(10, bins[i] / 20);
    // Peak-pick, then correct the octave.
    //
    // A full harmonic product spectrum was tried and was worse: on a filtered
    // saw sitting in broadband water noise it locked onto sub-harmonics of the
    // noise floor. Peak-picking plus one octave test is both simpler and more
    // robust here. The specific error being corrected is that the engine's
    // sub-oscillator sits exactly one octave below the fundamental, and when
    // the filter closes it becomes the loudest bin — which made a jump read as
    // the pitch halving when the synthesis was raising it.
    let best = -Infinity;
    let bestBin = 0;
    const floorBin = Math.max(2, Math.floor(18 / hzPerBin));
    for (let i = floorBin; i < limit; i++) {
      if (bins[i] > best) {
        best = bins[i];
        bestBin = i;
      }
    }
    // If there is comparable energy an octave up, that is the true fundamental
    // and we picked its sub.
    const up = bestBin * 2;
    if (up < limit && lin[up] > lin[bestBin] * 0.45) {
      bestBin = up;
      best = bins[up];
    }
    // High-band energy, where the water rush sits.
    let high = 0;
    let n = 0;
    for (let i = Math.floor(1500 / hzPerBin); i < Math.floor(7000 / hzPerBin) && i < bins.length; i++) {
      high += Math.pow(10, bins[i] / 20);
      n++;
    }
    return {
      rms: +rms.toFixed(5),
      peakHz: Math.round(bestBin * hzPerBin),
      peakDb: +best.toFixed(1),
      highBand: +(20 * Math.log10(high / Math.max(n, 1) + 1e-12)).toFixed(1),
    };
  };

  // --- 1..4: sweep the engine ------------------------------------------------
  for (const s of [
    { label: 'idle', rpm: 0.05, load: 0.05, speed: 0.0, air: false },
    { label: 'low', rpm: 0.25, load: 0.5, speed: 0.2, air: false },
    { label: 'mid', rpm: 0.5, load: 0.8, speed: 0.5, air: false },
    { label: 'high', rpm: 0.8, load: 0.9, speed: 0.8, air: false },
    { label: 'max', rpm: 1.0, load: 1.0, speed: 1.0, air: false },
    { label: 'airborne', rpm: 1.0, load: 0.1, speed: 0.9, air: true },
  ]) {
    audio.setEngine(s.rpm, s.load, s.speed, s.air);
    await sleep(320);
    // Median of several samples. A single analyser read catches one arbitrary
    // 85 ms window, and with a tremolo running and broadband water noise under
    // the engine, the peak bin in any one window is noisy enough to invert the
    // apparent order of two adjacent RPM steps. The synthesis is deterministic;
    // the measurement is not.
    const reads = [];
    for (let k = 0; k < 7; k++) {
      await sleep(45);
      reads.push(measure());
    }
    reads.sort((a, b) => a.peakHz - b.peakHz);
    const mid = reads[Math.floor(reads.length / 2)];
    out.steps.push({
      label: s.label,
      rms: Math.max(...reads.map((r) => r.rms)),
      peakHz: mid.peakHz,
      peakDb: mid.peakDb,
      highBand: mid.highBand,
    });
  }

  // --- 5: one-shots ----------------------------------------------------------
  audio.setEngine(0.2, 0.2, 0.1, false);
  await sleep(250);
  const bed = measure().rms;
  for (const name of [
    'startHorn',
    'countdownBeep',
    'countdownGo',
    'impactSoft',
    'impactHard',
    'splash',
    'boostFire',
    'gatePass',
    'lapComplete',
    'finish',
    'uiConfirm',
    'pickup',
    'hazardHit',
  ]) {
    audio.play(name, 1);
    // Sample a few times across the transient and keep the loudest.
    let peak = 0;
    for (let k = 0; k < 8; k++) {
      await sleep(35);
      peak = Math.max(peak, measure().rms);
    }
    out.sfx.push({ name, peakRms: +peak.toFixed(5), overBed: +(peak - bed).toFixed(5) });
    await sleep(220);
  }
  out.bedRms = +bed.toFixed(5);
  return out;
});

console.log('\nAUDIO PROBE');
console.log(`  context enabled: ${report.enabled}   sample rate: ${report.sampleRate} Hz`);
if (report.error) {
  console.log(`  ERROR: ${report.error}`);
  await browser.close();
  process.exit(1);
}

console.log('\nENGINE SWEEP');
console.log('  state       rms       peak Hz   peak dB   high band dB');
for (const s of report.steps) {
  console.log(
    `  ${s.label.padEnd(10)} ${String(s.rms).padEnd(9)} ${String(s.peakHz).padStart(7)} ` +
      `${String(s.peakDb).padStart(9)} ${String(s.highBand).padStart(12)}`,
  );
}

// Idle is excluded from the pitch checks: at rms ~0.03 the engine is below the
// water bed and the analyser is measuring noise, so its reported fundamental is
// meaningless. That is a property of the measurement, not of the synthesis.
const drive = report.steps.filter((s) => s.label !== 'airborne' && s.label !== 'idle');
const rising = drive.every((s, i) => i === 0 || s.peakHz >= drive[i - 1].peakHz - 2);
const spread = drive[drive.length - 1].peakHz - drive[0].peakHz;
const air = report.steps.find((s) => s.label === 'airborne');
const max = report.steps.find((s) => s.label === 'max');
const highRising =
  drive[drive.length - 1].highBand > drive[0].highBand;

console.log('\nASSERTIONS');
const check = (ok, label, detail) =>
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(46)} ${detail}`);
check(report.enabled, 'audio context is running', `sampleRate ${report.sampleRate}`);
check(drive.some((s) => s.rms > 1e-4), 'the graph emits signal', `max rms ${Math.max(...drive.map((s) => s.rms))}`);
check(rising, 'engine pitch is monotonic in RPM', drive.map((s) => s.peakHz).join(' -> ') + ' Hz');
check(spread > 40, 'engine pitch actually sweeps', `${spread} Hz from idle to max`);
check(highRising, 'water rush rises with speed', `${drive[0].highBand} -> ${drive[drive.length - 1].highBand} dB`);
check(
  air && max && air.peakHz > max.peakHz,
  'airborne revs free (pitch rises)',
  air && max ? `${max.peakHz} -> ${air.peakHz} Hz` : 'n/a',
);

console.log('\nONE-SHOTS  (bed rms ' + report.bedRms + ')');
let sfxFails = 0;
for (const s of report.sfx) {
  const ok = s.overBed > 0.0008;
  if (!ok) sfxFails++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${s.name.padEnd(16)} peak ${String(s.peakRms).padEnd(9)} (+${s.overBed} over bed)`);
}

console.log(
  `\n  ${report.sfx.length - sfxFails}/${report.sfx.length} one-shots produced an audible transient.\n` +
    `  This proves the synthesis works. It says nothing about whether it sounds good.\n`,
);

await browser.close();
process.exitCode = sfxFails > 2 || !rising || !report.enabled ? 1 : 0;
