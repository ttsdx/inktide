import type { AudioBus, SfxName } from '../contracts.ts';
import {
  chain,
  glide,
  makeAdsrEnv,
  makeAmpEnv,
  makeFilter,
  makeGain,
  makeImpulseResponse,
  makeNoiseBuffer,
  makeNoiseSource,
  makeOsc,
  noteHz,
  scaleHz,
  sweep,
} from './synth.ts';

/**
 * AUDIO ENGINE
 *
 * Every sound is synthesized. There is not one byte of sample data in the build.
 *
 * Graph topology:
 *
 *   engine voices ──> engineBus ──────────────────────────────┐
 *      (3 detuned oscs + sub + grit noise -> LPF -> tremolo)  │
 *                         └─> engSend(0.06) ─┐                │
 *                                            │                ├─> master ─> comp ─> out
 *   water rush + hull slap ─┐                │                │
 *   sfx voices ─────────────┴─> sfxBus ──────┼────────────────┘
 *                               └─> sfxSend(0.3) -> HPF -> convolver -> return ┘
 *
 * Two things about that shape are deliberate:
 *
 *  - The engine is nearly dry. Reverb on a continuous tone smears its pitch
 *    envelope, and the engine's pitch *is* the speed readout for the ear — a wet
 *    engine makes the boat feel like it is accelerating in a car park. The 6%
 *    send is only there so it does not sound like it is in a different room from
 *    the splashes.
 *
 *  - The compressor sits after the master fader, not before it. Everything
 *    upstream is generated at once (four boats' worth of impacts can land on the
 *    same frame as a lap sting), so the last stage has to be something that
 *    catches the sum. A limiter-ish 3:1 at -13 dBFS keeps the peaks in check
 *    without pumping the engine tone, which is the loudest steady voice.
 *
 * Robustness rules that hold for every public method:
 *
 *  - The `AudioContext` is created inside `resume()`, i.e. inside a user gesture.
 *    Constructing it earlier gets it born `suspended` by autoplay policy, and
 *    some browsers then log on every single scheduling call.
 *  - Before that, and forever after a failure, `enabled` is false and every
 *    method is a silent no-op. The screenshot harness runs headless with no
 *    output device; it must never see a throw or a console flood from here.
 */

/** Hard ceiling on simultaneous one-shot voices. */
const MAX_VOICES = 20;

/**
 * Minimum gap between two plays of the same cue, in seconds.
 *
 * Race events fire off physics state, so a boat grinding along a gate can ask
 * for `gatePass` on consecutive frames. Without this, that is 60 overlapping
 * voices a second and an instant clipped mess.
 */
const COOLDOWN: Partial<Record<SfxName, number>> = {
  impactSoft: 0.07,
  impactHard: 0.09,
  splash: 0.06,
  gatePass: 0.25,
  wrongWay: 1.6,
  boostFire: 0.18,
  boostCharged: 0.5,
  uiMove: 0.04,
  countdownBeep: 0.3,
};

interface AudioWindow {
  AudioContext?: typeof AudioContext;
  webkitAudioContext?: typeof AudioContext;
}

/** Continuous state, kept so it can be re-applied the instant audio comes up. */
interface EngineState {
  rpm: number;
  load: number;
  speed: number;
  airborne: boolean;
}

/**
 * A live one-shot voice.
 *
 * Tracked in a list rather than behind a counter so a voice whose `onended`
 * never arrives (the context gets suspended mid-flight when the tab is hidden,
 * for instance) can be reaped by its scheduled end time. With a bare counter
 * that case leaks a slot permanently, and twenty of them silence the game for
 * the rest of the session.
 */
interface Voice {
  end: number;
  done: boolean;
  release(): void;
}

export class AudioEngine implements AudioBus {
  /**
   * Analysis tap on the master bus.
   *
   * This project has no audio device — every gain, filter and send level was
   * chosen by reasoning, and nobody has heard a single sound. That is a real
   * verification gap, and the honest response is not to assert the mix is fine
   * but to measure what can be measured: that the graph actually emits signal,
   * that engine pitch genuinely tracks RPM rather than being a constant drone,
   * and that one-shots produce an audible transient. `tapAnalyser` exposes the
   * master bus so `tools/audioProbe` can do exactly that in a headless browser.
   */
  tapAnalyser(fftSize = 4096): AnalyserNode | null {
    if (!this.ctx || !this.master) return null;
    const an = this.ctx.createAnalyser();
    an.fftSize = fftSize;
    an.smoothingTimeConstant = 0;
    this.master.connect(an);
    return an;
  }

  /** Sample rate of the live context, for turning FFT bins into hertz. */
  get sampleRate(): number {
    return this.ctx?.sampleRate ?? 0;
  }

  private ctx: AudioContext | null = null;
  /** Set once if audio can never work here; makes every call a cheap no-op. */
  private unavailable = false;
  private resuming: Promise<void> | null = null;
  private started = false;

  private masterLevel = 0.85;
  private voices: Voice[] = [];
  private lastPlay: Partial<Record<SfxName, number>> = {};

  private state: EngineState = { rpm: 0, load: 0, speed: 0, airborne: false };
  /** Last state actually written to the graph, so unchanged frames cost nothing. */
  private applied: EngineState = { rpm: -1, load: -1, speed: -1, airborne: false };

  // --- buses ---------------------------------------------------------------
  private master: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private engineBus: GainNode | null = null;

  // --- continuous voices ---------------------------------------------------
  private oscA: OscillatorNode | null = null;
  private oscB: OscillatorNode | null = null;
  private oscC: OscillatorNode | null = null;
  private sub: OscillatorNode | null = null;
  private gritGain: GainNode | null = null;
  private engFilter: BiquadFilterNode | null = null;
  private engGain: GainNode | null = null;
  private tremLfo: OscillatorNode | null = null;
  private rushFilter: BiquadFilterNode | null = null;
  private rushGain: GainNode | null = null;
  private slapFilter: BiquadFilterNode | null = null;
  private slapGain: GainNode | null = null;
  private slapLfo: OscillatorNode | null = null;

  // --- shared buffers ------------------------------------------------------
  private whiteBuf: AudioBuffer | null = null;
  private pinkBuf: AudioBuffer | null = null;

  get enabled(): boolean {
    return !this.unavailable && this.ctx !== null && this.ctx.state === 'running' && this.started;
  }

  /**
   * Create and/or unblock the context. Safe to call from any gesture handler,
   * any number of times, including concurrently.
   */
  resume(): Promise<void> {
    if (this.unavailable) return Promise.resolve();
    if (this.resuming) return this.resuming;
    this.resuming = this.doResume().finally(() => {
      this.resuming = null;
    });
    return this.resuming;
  }

  private async doResume(): Promise<void> {
    try {
      if (!this.ctx) {
        const w = window as unknown as AudioWindow;
        const Ctor = w.AudioContext ?? w.webkitAudioContext;
        if (!Ctor) {
          this.unavailable = true;
          return;
        }
        // 'interactive' asks for the smallest buffer the device will give us.
        // Latency matters here: an impact sound 100 ms after the visual splash
        // reads as a bug even though nobody can say why.
        this.ctx = new Ctor({ latencyHint: 'interactive' });
      }
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      if (!this.started) {
        this.build(this.ctx);
        this.started = true;
      }
      // Push whatever the game has been telling us while we were muted, so the
      // engine comes up at the right pitch instead of idling for a frame.
      this.applied.rpm = -1;
      this.applyEngine();
    } catch {
      // No device, blocked context, or a browser that lied about support.
      // Fail permanently rather than retrying on every gesture.
      this.unavailable = true;
      this.ctx = null;
      this.started = false;
    }
  }

  setMasterGain(g: number): void {
    this.masterLevel = Number.isFinite(g) ? Math.max(0, Math.min(1.5, g)) : this.masterLevel;
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    try {
      glide(this.master.gain, this.masterLevel, ctx.currentTime, 0.05);
    } catch {
      /* a param write can only fail if the context died; nothing to salvage */
    }
  }

  /** Per-frame continuous drive. Cheap, and safe before audio exists. */
  setEngine(rpm01: number, load01: number, speed01: number, airborne: boolean): void {
    this.state.rpm = sat(rpm01);
    this.state.load = sat(load01);
    this.state.speed = sat(speed01);
    this.state.airborne = airborne === true;
    if (!this.enabled) return;
    this.applyEngine();
  }

  play(name: SfxName, gain = 1): void {
    const ctx = this.ctx;
    if (!ctx || !this.enabled || !this.sfxBus) return;
    const now = ctx.currentTime;
    const gap = COOLDOWN[name];
    if (gap !== undefined) {
      const last = this.lastPlay[name];
      if (last !== undefined && now - last < gap) return;
    }
    this.reap(now);
    if (this.voices.length >= MAX_VOICES) return;
    this.lastPlay[name] = now;
    const g = Number.isFinite(gain) ? Math.max(0, Math.min(2, gain)) : 1;

    try {
      switch (name) {
        case 'startHorn':
          this.horn(g);
          break;
        case 'countdownBeep':
          this.beep(noteHz(69), 0.16, 0.34 * g, 'square');
          break;
        case 'countdownGo':
          this.beep(noteHz(81), 0.62, 0.42 * g, 'square', true);
          break;
        case 'impactSoft':
          this.impact(false, g * 2.2);
          break;
        case 'impactHard':
          this.impact(true, g * 1.7);
          break;
        case 'splash':
          this.splash(g * 2.0);
          break;
        case 'boostFire':
          this.boostFire(g * 1.8);
          break;
        case 'boostCharged':
          this.sting([9, 12], 0.055, 0.16, 0.2 * g, 'triangle');
          break;
        case 'gatePass':
          this.sting([7, 10], 0.05, 0.14, 0.16 * g, 'triangle');
          break;
        case 'lapComplete':
          this.sting([5, 7, 9], 0.085, 0.3, 0.24 * g, 'triangle');
          break;
        case 'finish':
          this.sting([5, 7, 9, 10, 12], 0.11, 0.55, 0.3 * g, 'triangle', true);
          break;
        case 'wrongWay':
          this.wrongWay(g);
          break;
        case 'uiMove':
          this.beep(scaleHz(9), 0.05, 0.12 * g, 'triangle');
          break;
        case 'uiConfirm':
          this.sting([5, 12], 0.06, 0.14, 0.18 * g, 'square');
          break;
      }
    } catch {
      /* a single failed cue must never take the frame down */
    }
  }

  dispose(): void {
    const ctx = this.ctx;
    this.started = false;
    this.ctx = null;
    if (!ctx) return;
    try {
      for (const osc of [this.oscA, this.oscB, this.oscC, this.sub, this.tremLfo, this.slapLfo]) {
        osc?.stop();
      }
      void ctx.close();
    } catch {
      /* already torn down */
    }
  }

  // -------------------------------------------------------------------------
  // Graph construction
  // -------------------------------------------------------------------------

  private build(ctx: AudioContext): void {
    this.whiteBuf = makeNoiseBuffer(ctx, 2, 'white', 0x1a7e);
    this.pinkBuf = makeNoiseBuffer(ctx, 2, 'pink', 0x2b91);

    const master = makeGain(ctx, this.masterLevel);
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -13;
    comp.knee.value = 9;
    comp.ratio.value = 3.2;
    comp.attack.value = 0.006;
    comp.release.value = 0.19;

    // Brickwall limiter after the bus compressor.
    //
    // Measuring the master bus showed the finish cue peaking at 5.1 amplitude
    // — five times full scale — while the engine bed sat at 0.05. A gentle 3.2:1
    // compressor cannot hold that: it would duck the entire mix by 20 dB every
    // time a lap completed, which is audible as the whole game flinching. A
    // shipped mix has a limiter as its last stage for exactly this reason, so
    // that a cue nobody predicted the level of cannot clip the output or pump
    // everything else. Fast attack, short release, high ratio, and it only
    // engages on the peaks.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -2.5;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.09;

    master.connect(comp);
    comp.connect(limiter);
    limiter.connect(ctx.destination);
    this.master = master;

    // --- reverb send -------------------------------------------------------
    const convolver = ctx.createConvolver();
    // The impulse is unit-normalised by `makeImpulseResponse`, so the send and
    // return gains below fully determine how wet the mix is. Leaving the node's
    // own `normalize` on stacks a second, opaque, implementation-defined
    // scaling on top of that: measured on the master bus it was pushing a
    // sustained sting to twice the level of its own dry signal, which is why
    // the finish cue peaked at 1.7 — over twenty times the engine bed and well
    // into clipping — no matter how far its source gain was turned down.
    convolver.normalize = false;
    convolver.buffer = makeImpulseResponse(ctx, 1.9, 3.4, 0.32);
    const reverbReturn = makeGain(ctx, 0.55);
    convolver.connect(reverbReturn);
    reverbReturn.connect(master);

    // One-shots measured 10-25x the engine bed on the master bus, so the sfx
    // bus is pulled well down rather than the individual cues being chased one
    // by one: the balance between cues was reasonable, it was the whole bus
    // that sat too hot against the continuous layers.
    const sfxBus = makeGain(ctx, 0.32);
    sfxBus.connect(master);
    // Highpass the send: low frequencies convolved into a 1.9 s tail turn into
    // an undifferentiated rumble that eats the engine's bottom end.
    const sfxSend = makeGain(ctx, 0.3);
    const sendHp = makeFilter(ctx, 'highpass', 320, 0.7);
    chain(sfxBus, sfxSend, sendHp, convolver);
    this.sfxBus = sfxBus;

    const engineBus = makeGain(ctx, 1);
    engineBus.connect(master);
    const engSend = makeGain(ctx, 0.06);
    chain(engineBus, engSend, convolver);
    this.engineBus = engineBus;

    this.buildEngineVoice(ctx, engineBus);
    this.buildWaterVoice(ctx, sfxBus);
  }

  /**
   * The engine voice.
   *
   * Topology and why: three detuned oscillators (two saws plus a square) beat
   * against each other at a few Hz, which is what stops a synthesized engine
   * from sounding like a test tone — a single oscillator has no width and the ear
   * instantly files it as "computer". The square adds odd harmonics the saws do
   * not emphasise, giving the mid range some rasp.
   *
   * They all feed one resonant lowpass whose cutoff opens with *load*, not with
   * RPM. That separation is the whole trick: RPM sets pitch, load sets
   * brightness. Coasting at high revs then sounds hollow and off-throttle, while
   * climbing under power sounds strained, from the same pitch. Tie brightness to
   * RPM instead and every engine sound in the game becomes a siren.
   *
   * A sub-oscillator an octave down carries the weight (small speakers reproduce
   * the fundamental of a 45 Hz idle badly, but they do reproduce its second
   * harmonic, so having both is what makes it audible on a laptop), and a thin
   * band of noise adds the combustion grit that pure oscillators lack.
   *
   * The tremolo is the firing order. A real engine's amplitude pulses once per
   * combustion event, so the AM rate is tied to RPM; without it, the tone is a
   * smooth drone that never sounds mechanical no matter how good the filter is.
   */
  private buildEngineVoice(ctx: AudioContext, out: AudioNode): void {
    const mix = makeGain(ctx, 1);

    this.oscA = makeOsc(ctx, 'sawtooth', 60);
    this.oscB = makeOsc(ctx, 'sawtooth', 60, 9);
    this.oscC = makeOsc(ctx, 'square', 60, -11);
    this.sub = makeOsc(ctx, 'triangle', 30);

    const gA = makeGain(ctx, 0.34);
    const gB = makeGain(ctx, 0.3);
    const gC = makeGain(ctx, 0.16);
    const gS = makeGain(ctx, 0.42);
    chain(this.oscA, gA, mix);
    chain(this.oscB, gB, mix);
    chain(this.oscC, gC, mix);
    chain(this.sub, gS, mix);

    if (this.whiteBuf) {
      const grit = makeNoiseSource(ctx, this.whiteBuf, true, 1);
      const gritBp = makeFilter(ctx, 'bandpass', 1350, 1.1);
      this.gritGain = makeGain(ctx, 0.02);
      chain(grit, gritBp, this.gritGain, mix);
      grit.start();
    }

    this.engFilter = makeFilter(ctx, 'lowpass', 700, 1.6);
    const trem = makeGain(ctx, 0.8);
    this.engGain = makeGain(ctx, 0.0001);
    chain(mix, this.engFilter, trem, this.engGain, out);

    this.tremLfo = makeOsc(ctx, 'triangle', 12);
    const tremDepth = makeGain(ctx, 0.2);
    chain(this.tremLfo, tremDepth, trem.gain);

    this.oscA.start();
    this.oscB.start();
    this.oscC.start();
    this.sub.start();
    this.tremLfo.start();
  }

  /**
   * Water: a bright rush layer plus a low hull-slap layer.
   *
   * Both are the same pink bed through different filters, which is cheaper than
   * two beds and, more importantly, keeps them phase-related so they read as one
   * body of water rather than two effects. The slap layer's amplitude is wobbled
   * by a slow LFO whose rate rises with speed, so the low end thumps in a way
   * that suggests a hull striking wave faces instead of sitting there as a drone.
   */
  private buildWaterVoice(ctx: AudioContext, out: AudioNode): void {
    if (!this.pinkBuf) return;

    const rush = makeNoiseSource(ctx, this.pinkBuf, true, 1);
    this.rushFilter = makeFilter(ctx, 'bandpass', 700, 0.7);
    this.rushGain = makeGain(ctx, 0.0001);
    chain(rush, this.rushFilter, this.rushGain, out);
    rush.start();

    const slap = makeNoiseSource(ctx, this.pinkBuf, true, 0.73);
    this.slapFilter = makeFilter(ctx, 'lowpass', 190, 1.4);
    this.slapGain = makeGain(ctx, 0.0001);
    chain(slap, this.slapFilter, this.slapGain, out);
    slap.start();

    this.slapLfo = makeOsc(ctx, 'triangle', 1.4);
    const slapDepth = makeGain(ctx, 0.6);
    chain(this.slapLfo, slapDepth, this.slapGain.gain);
    this.slapLfo.start();
  }

  // -------------------------------------------------------------------------
  // Continuous parameter drive
  // -------------------------------------------------------------------------

  private applyEngine(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    const s = this.state;

    // Skip frames where nothing meaningful moved. `setTargetAtTime` is cheap but
    // not free, and this is eleven params at 60 Hz for the whole race; a boat
    // holding a steady throttle down a straight should not be paying for it.
    const a = this.applied;
    if (
      s.airborne === a.airborne &&
      Math.abs(s.rpm - a.rpm) < 0.002 &&
      Math.abs(s.load - a.load) < 0.004 &&
      Math.abs(s.speed - a.speed) < 0.004
    ) {
      return;
    }
    a.rpm = s.rpm;
    a.load = s.load;
    a.speed = s.speed;
    a.airborne = s.airborne;

    // Airborne: the prop is spinning in air, so the load the engine is fighting
    // vanishes and it revs free. Pitch climbs, the filter opens a little (thin
    // and shouty, not fat), and the firing rate speeds up. This one branch is
    // what sells a jump — the visual leaves the water and the *sound* leaves
    // with it, instead of grinding on unchanged.
    const air = s.airborne ? 1 : 0;
    const rpm = Math.min(1.14, s.rpm * (1 - 0.02 * air) + 0.15 * air);
    const load = s.airborne ? Math.min(1, s.load * 0.3 + 0.1) : s.load;

    // 42..236 Hz fundamental. Low enough to idle with weight, and just under the
    // range where a saw's aliasing starts to bite at the top.
    const base = 42 + 194 * Math.pow(rpm, 1.04);
    if (this.oscA) glide(this.oscA.frequency, base, now, 0.05);
    if (this.oscB) glide(this.oscB.frequency, base * 1.006, now, 0.05);
    if (this.oscC) glide(this.oscC.frequency, base * 0.993, now, 0.05);
    if (this.sub) glide(this.sub.frequency, base * 0.5, now, 0.06);

    if (this.engFilter) {
      glide(this.engFilter.frequency, 260 + 3100 * load + 1500 * rpm + 500 * air, now, 0.08);
      // Resonance rises with load so a hard pull growls; a coasting engine has a
      // flat, uninteresting filter, which is correct.
      glide(this.engFilter.Q, 1.2 + 4.4 * load, now, 0.12);
    }
    if (this.gritGain) glide(this.gritGain.gain, 0.015 + 0.075 * load, now, 0.1);
    if (this.tremLfo) glide(this.tremLfo.frequency, 5.5 + 58 * rpm + 9 * air, now, 0.07);
    if (this.engGain) {
      // Idle floor of 0.05 so the engine never fully disappears at a standstill.
      glide(this.engGain.gain, 0.05 + 0.3 * rpm + 0.1 * load, now, 0.07);
    }

    // Water scales with speed, and mostly mutes in the air: nothing is touching
    // the water, so the rush should drop out and come back with the splash.
    const speed = s.speed;
    const wet = 1 - 0.82 * air;
    if (this.rushFilter) glide(this.rushFilter.frequency, 620 + 2900 * speed, now, 0.15);
    if (this.rushGain) {
      glide(this.rushGain.gain, (0.004 + 0.3 * Math.pow(speed, 1.5)) * wet, now, 0.12);
    }
    if (this.slapFilter) glide(this.slapFilter.frequency, 170 + 270 * speed, now, 0.2);
    if (this.slapGain) glide(this.slapGain.gain, (0.006 + 0.17 * speed) * wet, now, 0.15);
    if (this.slapLfo) glide(this.slapLfo.frequency, 1.1 + 5.4 * speed, now, 0.2);
  }

  // -------------------------------------------------------------------------
  // One-shot voices
  // -------------------------------------------------------------------------

  /**
   * Start a set of sources, schedule their stop, and disconnect everything when
   * the last one ends.
   *
   * `AudioBufferSourceNode`s and `OscillatorNode`s are one-shot objects: without
   * an explicit stop they run forever, and without the disconnect their whole
   * chain stays reachable from the graph. Both are leaks that only show up after
   * a few minutes of racing, which is exactly when nobody is looking for them.
   */
  private launch(
    sources: readonly AudioScheduledSourceNode[],
    nodes: readonly AudioNode[],
    t0: number,
    endTime: number,
  ): void {
    if (sources.length === 0) return;
    const voice: Voice = {
      end: endTime,
      done: false,
      release: () => {
        if (voice.done) return;
        voice.done = true;
        for (const n of nodes) {
          try {
            n.disconnect();
          } catch {
            /* already gone */
          }
        }
        for (const s of sources) {
          try {
            s.onended = null;
            s.disconnect();
          } catch {
            /* already gone */
          }
        }
      },
    };
    this.voices.push(voice);

    let remaining = sources.length;
    const onEnd = (): void => {
      remaining--;
      if (remaining <= 0) voice.release();
    };
    for (const s of sources) {
      s.onended = onEnd;
      s.start(t0);
      s.stop(endTime);
    }
  }

  /**
   * Drop finished voices, and force-release any that are past their scheduled
   * end by a comfortable margin. `onended` normally gets there first; the
   * deadline exists only so a lost callback cannot hold a slot forever.
   */
  private reap(now: number): void {
    for (let i = this.voices.length - 1; i >= 0; i--) {
      const v = this.voices[i];
      if (v.done || now > v.end + 0.5) {
        v.release();
        this.voices.splice(i, 1);
      }
    }
  }

  /** Short pitched blip. `wobble` adds a light vibrato for the "GO" tone. */
  private beep(hz: number, dur: number, gain: number, type: OscillatorType, wobble = false): void {
    const ctx = this.ctx;
    const out = this.sfxBus;
    if (!ctx || !out) return;
    const t0 = ctx.currentTime + 0.002;
    const osc = makeOsc(ctx, type, hz);
    // A square through a gentle lowpass keeps the click of the attack without
    // the fizz above 5 kHz that makes short beeps sound cheap.
    const lp = makeFilter(ctx, 'lowpass', Math.max(1200, hz * 6), 0.9);
    const env = makeAmpEnv(ctx, t0, gain, 0.006, dur);
    chain(osc, lp, env.node, out);

    const sources: AudioScheduledSourceNode[] = [osc];
    const nodes: AudioNode[] = [osc, lp, env.node];
    if (wobble) {
      const vib = makeOsc(ctx, 'sine', 5.5);
      const vibDepth = makeGain(ctx, hz * 0.008);
      chain(vib, vibDepth, osc.frequency);
      sources.push(vib);
      nodes.push(vib, vibDepth);
    }
    this.launch(sources, nodes, t0, env.endTime);
  }

  /**
   * Impact thud.
   *
   * Two components, because a real collision is both: a pitched body resonance
   * that falls as the structure rings out, and a broadband transient from the
   * surfaces meeting. The pitch sweep on the sine-ish tone is what makes it read
   * as mass — a fixed-pitch thump sounds like a drum machine.
   */
  private impact(hard: boolean, gain: number): void {
    const ctx = this.ctx;
    const out = this.sfxBus;
    if (!ctx || !out || !this.whiteBuf) return;
    const t0 = ctx.currentTime + 0.002;

    const f0 = hard ? 205 : 132;
    const f1 = hard ? 36 : 54;
    const tone = makeOsc(ctx, 'triangle', f0);
    sweep(tone.frequency, t0, f0, f1, hard ? 0.24 : 0.15);
    const toneEnv = makeAmpEnv(ctx, t0, (hard ? 0.85 : 0.42) * gain, 0.004, hard ? 0.34 : 0.17);
    chain(tone, toneEnv.node, out);

    const noise = makeNoiseSource(ctx, this.whiteBuf, false, hard ? 1 : 0.8);
    const lp = makeFilter(ctx, 'lowpass', hard ? 1700 : 950, 0.9);
    sweep(lp.frequency, t0, hard ? 1700 : 950, hard ? 190 : 240, 0.2);
    const noiseEnv = makeAmpEnv(ctx, t0, (hard ? 0.5 : 0.26) * gain, 0.002, hard ? 0.26 : 0.13);
    chain(noise, lp, noiseEnv.node, out);

    const sources: AudioScheduledSourceNode[] = [tone, noise];
    const nodes: AudioNode[] = [tone, toneEnv.node, noise, lp, noiseEnv.node];
    let end = Math.max(toneEnv.endTime, noiseEnv.endTime);

    if (hard) {
      // A narrow crack on top. Only on hard hits, so the two variants are
      // distinguishable by timbre and not just by volume.
      const crack = makeNoiseSource(ctx, this.whiteBuf, false, 1.4);
      const bp = makeFilter(ctx, 'bandpass', 2400, 1.6);
      const crackEnv = makeAmpEnv(ctx, t0, 0.3 * gain, 0.001, 0.06);
      chain(crack, bp, crackEnv.node, out);
      sources.push(crack);
      nodes.push(crack, bp, crackEnv.node);
      end = Math.max(end, crackEnv.endTime);
    }

    this.launch(sources, nodes, t0, end);
  }

  /** Splash: noise through a bandpass that rises as the water throws upwards. */
  private splash(gain: number): void {
    const ctx = this.ctx;
    const out = this.sfxBus;
    if (!ctx || !out || !this.whiteBuf) return;
    const t0 = ctx.currentTime + 0.002;

    const noise = makeNoiseSource(ctx, this.whiteBuf, false, 1);
    const bp = makeFilter(ctx, 'bandpass', 420, 0.9);
    // Rising, not falling: the spray leaves the surface and gets finer, so the
    // spectral centroid climbs. A falling sweep sounds like something draining.
    sweep(bp.frequency, t0, 420, 3900, 0.26);
    const env = makeAmpEnv(ctx, t0, 0.4 * gain, 0.008, 0.34);
    chain(noise, bp, env.node, out);

    const fizz = makeNoiseSource(ctx, this.whiteBuf, false, 1.7);
    const hp = makeFilter(ctx, 'highpass', 4200, 0.8);
    const fizzEnv = makeAmpEnv(ctx, t0 + 0.02, 0.14 * gain, 0.01, 0.22);
    chain(fizz, hp, fizzEnv.node, out);

    this.launch(
      [noise, fizz],
      [noise, bp, env.node, fizz, hp, fizzEnv.node],
      t0,
      Math.max(env.endTime, fizzEnv.endTime),
    );
  }

  /**
   * Start horn.
   *
   * Three saws a few cents apart through a stack of peaking filters. The peaks
   * around 780 Hz and 1.9 kHz are a crude formant pair — that is what separates a
   * *horn* from a buzzer, because the ear identifies brass by fixed resonances
   * that stay put while the pitch moves. The slight upward bend on the attack
   * mimics the pressure taking a moment to build behind the valve.
   */
  private horn(gain: number): void {
    const ctx = this.ctx;
    const out = this.sfxBus;
    if (!ctx || !out) return;
    const t0 = ctx.currentTime + 0.002;
    const root = noteHz(50); // D3 — the tonic of the game's scale.

    const mix = makeGain(ctx, 1);
    const sources: AudioScheduledSourceNode[] = [];
    const nodes: AudioNode[] = [mix];
    const detunes = [-7, 4, 11];
    for (let i = 0; i < detunes.length; i++) {
      const hz = root * (i === 2 ? 1.5 : 1); // top voice is a fifth: brass stack
      const osc = makeOsc(ctx, 'sawtooth', hz * 0.97, detunes[i]);
      sweep(osc.frequency, t0, hz * 0.97, hz, 0.13);
      const g = makeGain(ctx, i === 2 ? 0.26 : 0.4);
      chain(osc, g, mix);
      sources.push(osc);
      nodes.push(osc, g);
    }

    const form1 = makeFilter(ctx, 'peaking', 780, 2.2, 10);
    const form2 = makeFilter(ctx, 'peaking', 1900, 3, 7);
    const lp = makeFilter(ctx, 'lowpass', 3400, 0.8);
    const env = makeAdsrEnv(ctx, t0, 0.5 * gain, { attack: 0.05, decay: 0.1, sustain: 0.82, release: 0.3 }, 0.78);
    chain(mix, form1, form2, lp, env.node, out);
    nodes.push(form1, form2, lp, env.node);

    this.launch(sources, nodes, t0, env.endTime);
  }

  /**
   * Boost fire: a rising noise whoosh plus a pitched element.
   *
   * The noise carries the air being moved; the saw carries the machine doing the
   * moving. Whoosh alone is a wind sound, tone alone is a synth riser — the boost
   * needs to feel like both a release of pressure and a mechanical commitment.
   */
  private boostFire(gain: number): void {
    const ctx = this.ctx;
    const out = this.sfxBus;
    if (!ctx || !out || !this.whiteBuf) return;
    const t0 = ctx.currentTime + 0.002;

    const noise = makeNoiseSource(ctx, this.whiteBuf, false, 1);
    const bp = makeFilter(ctx, 'bandpass', 280, 1.5);
    sweep(bp.frequency, t0, 280, 4600, 0.46);
    const env = makeAmpEnv(ctx, t0, 0.44 * gain, 0.045, 0.5);
    chain(noise, bp, env.node, out);

    const tone = makeOsc(ctx, 'sawtooth', 170);
    sweep(tone.frequency, t0, 170, 640, 0.42);
    const toneLp = makeFilter(ctx, 'lowpass', 1400, 2.4);
    sweep(toneLp.frequency, t0, 700, 2600, 0.42);
    const toneEnv = makeAmpEnv(ctx, t0, 0.2 * gain, 0.02, 0.44);
    chain(tone, toneLp, toneEnv.node, out);

    // A low thump underneath, so the boost has a moment of impact rather than
    // only a build.
    const thump = makeOsc(ctx, 'sine', 150);
    sweep(thump.frequency, t0, 150, 48, 0.16);
    const thumpEnv = makeAmpEnv(ctx, t0, 0.32 * gain, 0.004, 0.2);
    chain(thump, thumpEnv.node, out);

    this.launch(
      [noise, tone, thump],
      [noise, bp, env.node, tone, toneLp, toneEnv.node, thump, thumpEnv.node],
      t0,
      Math.max(env.endTime, toneEnv.endTime, thumpEnv.endTime),
    );
  }

  /** Low detuned buzz with a fast tremolo — reads as an alarm without a siren. */
  private wrongWay(gain: number): void {
    const ctx = this.ctx;
    const out = this.sfxBus;
    if (!ctx || !out) return;
    const t0 = ctx.currentTime + 0.002;
    const mix = makeGain(ctx, 1);
    const a = makeOsc(ctx, 'sawtooth', 138);
    const b = makeOsc(ctx, 'sawtooth', 138 * 1.06);
    const gA = makeGain(ctx, 0.5);
    const gB = makeGain(ctx, 0.5);
    chain(a, gA, mix);
    chain(b, gB, mix);
    const bp = makeFilter(ctx, 'bandpass', 620, 1.3);
    const trem = makeGain(ctx, 0.55);
    const lfo = makeOsc(ctx, 'square', 9);
    const depth = makeGain(ctx, 0.45);
    chain(lfo, depth, trem.gain);
    const env = makeAmpEnv(ctx, t0, 0.28 * gain, 0.02, 0.5);
    chain(mix, bp, trem, env.node, out);

    this.launch(
      [a, b, lfo],
      [a, b, gA, gB, mix, bp, trem, lfo, depth, env.node],
      t0,
      env.endTime,
    );
  }

  /**
   * Musical sting from the shared pentatonic scale.
   *
   * `steps` are indices into `SCALE_D_PENTATONIC`, never raw frequencies, which
   * is what keeps the gate blip, the lap chime and the finish flourish sounding
   * like parts of one piece of music rather than three unrelated beeps.
   */
  private sting(
    steps: readonly number[],
    spacing: number,
    dur: number,
    gain: number,
    type: OscillatorType,
    withBass = false,
  ): void {
    const ctx = this.ctx;
    const out = this.sfxBus;
    if (!ctx || !out) return;
    const t0 = ctx.currentTime + 0.002;
    const sources: AudioScheduledSourceNode[] = [];
    const nodes: AudioNode[] = [];
    let end = t0;

    // Normalise by voice count.
    //
    // These are arpeggios on paper — notes spaced 50-110 ms apart — but each
    // note rings for up to 550 ms, so in practice every voice of the chord is
    // sounding at once and their amplitudes sum. Measured on the master bus,
    // the five-note finish sting peaked at 1.73 RMS against an engine bed of
    // 0.05: more than thirty times the rest of the mix, and hard clipping.
    // `gain` is meant to be the loudness of the whole sting, so it has to be
    // divided among its voices. The 0.8 accounts for the envelopes not all
    // peaking on the same sample.
    const perVoice = gain / Math.max(1, steps.length * 0.8);

    for (let i = 0; i < steps.length; i++) {
      const at = t0 + i * spacing;
      const hz = scaleHz(steps[i]);
      const osc = makeOsc(ctx, type, hz);
      const lp = makeFilter(ctx, 'lowpass', Math.max(2200, hz * 5), 0.9);
      const env = makeAmpEnv(ctx, at, perVoice, 0.005, dur);
      chain(osc, lp, env.node, out);
      // An octave-up sine at low level in place of a real harmonic series: it
      // adds bell-like sparkle for two extra nodes and no extra attack noise.
      const shine = makeOsc(ctx, 'sine', hz * 2);
      const shineEnv = makeAmpEnv(ctx, at, perVoice * 0.3, 0.004, dur * 0.6);
      chain(shine, shineEnv.node, out);

      sources.push(osc, shine);
      nodes.push(osc, lp, env.node, shine, shineEnv.node);
      end = Math.max(end, env.endTime, shineEnv.endTime);
    }

    if (withBass) {
      const bass = makeOsc(ctx, 'triangle', noteHz(38));
      const bassEnv = makeAmpEnv(ctx, t0, perVoice * 0.9, 0.01, dur + steps.length * spacing);
      chain(bass, bassEnv.node, out);
      sources.push(bass);
      nodes.push(bass, bassEnv.node);
      end = Math.max(end, bassEnv.endTime);
    }

    this.launch(sources, nodes, t0, end);
  }
}

function sat(v: number): number {
  return Number.isFinite(v) ? (v < 0 ? 0 : v > 1 ? 1 : v) : 0;
}
