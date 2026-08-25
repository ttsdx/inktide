/**
 * SYNTH — the Web Audio building blocks every sound in Ink Tide is made from.
 *
 * There are no audio files in this project, so this file is the sample library:
 * noise beds, impulse responses, envelopes and node-chain plumbing, all
 * generated from numbers at load time.
 *
 * A few decisions worth stating up front, because they shape everything above:
 *
 *  - Noise is a *looped buffer*, not a `ScriptProcessorNode` and not an
 *    `AudioWorklet`. Both of those put a JS callback on the audio thread, which
 *    on a frame-hitching WebGL page is how you get a stutter you can hear. A
 *    two-second decorrelated stereo buffer looped forever is free after setup,
 *    and nobody has ever identified the loop point of band-passed noise.
 *
 *  - Every random value comes from a seeded PRNG rather than `Math.random`, so
 *    the reverb tail and the noise bed are bit-identical between runs. That
 *    matters for the screenshot/audio harness: a sound that differs run to run
 *    cannot be regression-tested.
 *
 *  - Decays are `setTargetAtTime` or `exponentialRampToValueAtTime`, never
 *    `linearRampToValueAtTime` to zero. Amplitude is perceived roughly
 *    logarithmically, so a linear fade sounds like it hangs and then drops off
 *    a cliff; an exponential one sounds like a real thing stopping.
 */

/** Small fast PRNG (mulberry32). Deterministic per seed, good enough for noise. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Guard every value that reaches an AudioParam: one NaN silences a node forever. */
export function finite(v: number, fallback = 0): number {
  return Number.isFinite(v) ? v : fallback;
}

export type NoiseKind = 'white' | 'pink' | 'brown';

/**
 * Generate a looping noise bed.
 *
 * Pink is worth the extra filter: white noise through a bandpass still reads as
 * "hiss", while pink has the -3 dB/octave tilt of real broadband turbulence, so
 * the water rush sits under the engine instead of on top of it. Implemented with
 * Paul Kellet's economy IIR approximation — three-pole, accurate to about
 * ±0.3 dB across the audible range, which is far below what anyone will notice
 * behind an engine.
 *
 * Channels are generated from independent PRNG draws so the bed is genuinely
 * stereo. Correlated noise in both ears collapses to a point in the middle of
 * the head and makes the whole mix feel like it is coming out of a phone.
 */
export function makeNoiseBuffer(
  ctx: BaseAudioContext,
  seconds = 2,
  kind: NoiseKind = 'white',
  seed = 0x1a7e,
): AudioBuffer {
  const rate = ctx.sampleRate;
  const length = Math.max(1, Math.floor(rate * Math.max(0.05, seconds)));
  const buffer = ctx.createBuffer(2, length, rate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    const rnd = mulberry32(seed + ch * 7919);
    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    let b3 = 0;
    let b4 = 0;
    let b5 = 0;
    let b6 = 0;
    let brown = 0;
    for (let i = 0; i < length; i++) {
      const white = rnd() * 2 - 1;
      if (kind === 'white') {
        data[i] = white * 0.85;
      } else if (kind === 'pink') {
        b0 = 0.99886 * b0 + white * 0.0555179;
        b1 = 0.99332 * b1 + white * 0.0750759;
        b2 = 0.969 * b2 + white * 0.153852;
        b3 = 0.8665 * b3 + white * 0.3104856;
        b4 = 0.55 * b4 + white * 0.5329522;
        b5 = -0.7616 * b5 - white * 0.016898;
        const pink = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
        b6 = white * 0.115926;
        data[i] = pink * 0.14;
      } else {
        brown = (brown + white * 0.02) / 1.02;
        data[i] = brown * 3.2;
      }
    }
    // Cross-fade the last 20 ms into the head of the buffer so the loop point
    // has no discontinuity to click on.
    const fade = Math.min(Math.floor(rate * 0.02), Math.floor(length / 4));
    for (let i = 0; i < fade; i++) {
      const t = i / fade;
      data[i] = data[i] * t + data[length - fade + i] * (1 - t);
    }
  }
  return buffer;
}

/**
 * Procedural reverb impulse response: exponentially decaying, lowpassed noise
 * with a handful of discrete early reflections in front of it.
 *
 * The diffuse tail alone sounds like a reverb *plugin*; the early taps are what
 * make it sound like a place. Four sparse reflections in the first 45 ms give
 * the ear the "open water, nothing close by" read this game wants, and they cost
 * four array writes.
 *
 * Rendered directly into an `AudioBuffer` by hand rather than through an
 * `OfflineAudioContext`, because offline rendering is async and would leave the
 * first few seconds of play dry — and because it can fail outright in headless
 * environments, which this must not.
 */
export function makeImpulseResponse(
  ctx: BaseAudioContext,
  seconds = 1.9,
  decay = 3.4,
  brightness = 0.32,
  seed = 0x5eed,
): AudioBuffer {
  const rate = ctx.sampleRate;
  const length = Math.max(1, Math.floor(rate * Math.max(0.1, seconds)));
  const buffer = ctx.createBuffer(2, length, rate);
  // One-pole lowpass coefficient. Low brightness = darker tail = further away.
  const a = clamp01(brightness) * 0.85 + 0.05;
  const preDelay = Math.floor(rate * 0.011);

  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    const rnd = mulberry32(seed + ch * 104729);
    let lp = 0;
    for (let i = preDelay; i < length; i++) {
      const t = (i - preDelay) / rate;
      const white = rnd() * 2 - 1;
      lp += a * (white - lp);
      // Two decay terms: the exponential does the acoustic work, the linear
      // factor guarantees the very last sample is exactly zero so the tail
      // cannot click when the convolver wraps it.
      const env = Math.exp(-decay * t) * (1 - i / length);
      data[i] = lp * env;
    }
    // Early reflections, alternating polarity and slightly different per ear.
    const taps = [0.013, 0.021, 0.031, 0.044];
    for (let k = 0; k < taps.length; k++) {
      const idx = Math.floor(rate * (taps[k] + ch * 0.0017));
      if (idx < length) data[idx] += (k % 2 === 0 ? 0.55 : -0.42) * Math.pow(0.72, k);
    }
  }
  return buffer;
}

// ---------------------------------------------------------------------------
// Node factories
// ---------------------------------------------------------------------------

export function makeGain(ctx: BaseAudioContext, value = 1): GainNode {
  const g = ctx.createGain();
  g.gain.value = finite(value);
  return g;
}

export function makeOsc(
  ctx: BaseAudioContext,
  type: OscillatorType,
  frequency: number,
  detuneCents = 0,
): OscillatorNode {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.value = Math.max(0.0001, finite(frequency, 220));
  o.detune.value = finite(detuneCents);
  return o;
}

export function makeFilter(
  ctx: BaseAudioContext,
  type: BiquadFilterType,
  frequency: number,
  q = 1,
  gainDb = 0,
): BiquadFilterNode {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = Math.max(10, finite(frequency, 1000));
  f.Q.value = Math.max(0.0001, finite(q, 1));
  f.gain.value = finite(gainDb);
  return f;
}

export function makeNoiseSource(
  ctx: BaseAudioContext,
  buffer: AudioBuffer,
  loop = true,
  playbackRate = 1,
): AudioBufferSourceNode {
  const s = ctx.createBufferSource();
  s.buffer = buffer;
  s.loop = loop;
  s.playbackRate.value = Math.max(0.01, finite(playbackRate, 1));
  return s;
}

/** Connect a series of nodes and return the last one. */
export function chain<T extends AudioNode>(first: AudioNode, ...rest: AudioNode[]): T {
  let node = first;
  for (const next of rest) {
    node.connect(next);
    node = next;
  }
  return node as T;
}

// ---------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------

export interface AdsrSpec {
  attack: number;
  decay: number;
  /** 0..1 level held after the decay stage. */
  sustain: number;
  release: number;
}

/** Floor for exponential ramps — `exponentialRampToValueAtTime(0)` throws. */
const EPS = 0.0001;

/**
 * Percussive attack/decay gain node.
 *
 * Returns the node plus the time it is guaranteed silent, so the caller can
 * schedule `stop()` precisely: a source left running is a voice that never
 * garbage-collects.
 */
export function makeAmpEnv(
  ctx: BaseAudioContext,
  t0: number,
  peak: number,
  attack: number,
  decay: number,
): { node: GainNode; endTime: number } {
  const g = ctx.createGain();
  const p = Math.max(EPS, finite(peak, 0.5));
  const a = Math.max(0.0005, finite(attack, 0.005));
  const d = Math.max(0.005, finite(decay, 0.2));
  g.gain.setValueAtTime(EPS, t0);
  g.gain.linearRampToValueAtTime(p, t0 + a);
  g.gain.exponentialRampToValueAtTime(EPS, t0 + a + d);
  return { node: g, endTime: t0 + a + d + 0.02 };
}

/** Full ADSR with an explicit hold, for sustained sounds like the start horn. */
export function makeAdsrEnv(
  ctx: BaseAudioContext,
  t0: number,
  peak: number,
  adsr: AdsrSpec,
  hold: number,
): { node: GainNode; endTime: number } {
  const g = ctx.createGain();
  const p = Math.max(EPS, finite(peak, 0.5));
  const s = Math.max(EPS, p * clamp01(adsr.sustain));
  const a = Math.max(0.0005, adsr.attack);
  const d = Math.max(0.005, adsr.decay);
  const r = Math.max(0.01, adsr.release);
  const h = Math.max(0, hold);
  g.gain.setValueAtTime(EPS, t0);
  g.gain.linearRampToValueAtTime(p, t0 + a);
  g.gain.exponentialRampToValueAtTime(s, t0 + a + d);
  g.gain.setValueAtTime(s, t0 + a + d + h);
  g.gain.exponentialRampToValueAtTime(EPS, t0 + a + d + h + r);
  return { node: g, endTime: t0 + a + d + h + r + 0.02 };
}

/** Exponential parameter sweep, clamped away from zero. */
export function sweep(
  param: AudioParam,
  t0: number,
  from: number,
  to: number,
  duration: number,
): void {
  const f = Math.max(EPS, finite(from, 100));
  const t = Math.max(EPS, finite(to, 100));
  param.setValueAtTime(f, t0);
  param.exponentialRampToValueAtTime(t, t0 + Math.max(0.005, duration));
}

/** Smoothed continuous parameter write. The only safe way to drive per-frame. */
export function glide(param: AudioParam, value: number, now: number, timeConstant = 0.06): void {
  param.setTargetAtTime(finite(value, param.value), now, Math.max(0.005, timeConstant));
}

// ---------------------------------------------------------------------------
// Pitch
// ---------------------------------------------------------------------------

export function noteHz(midi: number): number {
  return 440 * Math.pow(2, (finite(midi, 69) - 69) / 12);
}

/**
 * D major pentatonic, three octaves from D4.
 *
 * Every musical cue in the game (gate, lap, finish, UI) draws from this one set,
 * so cues layered on top of each other — a gate pass while a lap sting is still
 * ringing — are always consonant. Random intervals is how a racing game ends up
 * sounding like a slot machine.
 */
export const SCALE_D_PENTATONIC: readonly number[] = [
  62, 64, 66, 69, 71, 74, 76, 78, 81, 83, 86, 88, 90, 93, 95,
];

/** Index into the scale, extending past the table by octaves. */
export function scaleHz(index: number): number {
  const n = SCALE_D_PENTATONIC.length;
  const i = Math.round(finite(index));
  const oct = Math.floor(i / n);
  const step = ((i % n) + n) % n;
  return noteHz(SCALE_D_PENTATONIC[step] + oct * 12);
}
