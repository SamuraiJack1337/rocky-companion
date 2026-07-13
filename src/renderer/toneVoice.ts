// Procedural Eridian language. Each concept has a stable musical signature:
// the same roots, rhythm, register, and five-bladder voicing every time. Tiny
// detune and amplitude differences keep performances organic without changing
// the identity of the phrase.

import type { EridianMotif } from '../shared/types';

interface Syllable {
  /** Root movement in semitones from the motif's base frequency. */
  root: number;
  /** Onset in seconds from the beginning of the phrase. */
  at: number;
  /** Sounding duration in seconds. */
  duration: number;
  /** Relative strength, preserving a repeatable accent pattern. */
  accent?: number;
}

interface MotifPhrase {
  baseHz: number;
  syllables: readonly Syllable[];
  /** Five simultaneous voices, representing Rocky's five vocal bladders. */
  voicing: readonly [number, number, number, number, number];
  tension: number;
  gain: number;
  wave: OscillatorType;
}

/**
 * A small musical lexicon. These phrases are intentionally data, not generated
 * melodies: "greeting" (for example) is recognisable on every playback.
 */
const MOTIFS: Record<EridianMotif, MotifPhrase> = {
  greeting: {
    baseHz: 176,
    syllables: [
      { root: 0, at: 0, duration: 0.3 },
      { root: 4, at: 0.34, duration: 0.28 },
      { root: 7, at: 0.67, duration: 0.48, accent: 1.08 },
    ],
    voicing: [0, 7, 12, 16, 19], tension: 0.14, gain: 0.14, wave: 'sine',
  },
  agreement: {
    baseHz: 164,
    syllables: [
      { root: 2, at: 0, duration: 0.25 },
      { root: 2, at: 0.29, duration: 0.25 },
      { root: -1, at: 0.58, duration: 0.42, accent: 1.08 },
    ],
    voicing: [0, 7, 12, 16, 19], tension: 0.1, gain: 0.14, wave: 'sine',
  },
  question: {
    baseHz: 196,
    syllables: [
      { root: -2, at: 0, duration: 0.3 },
      { root: 1, at: 0.32, duration: 0.27 },
      { root: 6, at: 0.63, duration: 0.52, accent: 1.1 },
    ],
    voicing: [0, 7, 12, 15, 20], tension: 0.28, gain: 0.145, wave: 'triangle',
  },
  calculate: {
    baseHz: 142,
    syllables: [
      { root: 0, at: 0, duration: 0.2 },
      { root: 5, at: 0.23, duration: 0.2 },
      { root: 2, at: 0.46, duration: 0.2 },
      { root: 9, at: 0.69, duration: 0.22 },
      { root: 7, at: 0.95, duration: 0.42, accent: 1.1 },
    ],
    voicing: [0, 5, 12, 17, 21], tension: 0.24, gain: 0.135, wave: 'triangle',
  },
  build: {
    baseHz: 132,
    syllables: [
      { root: 0, at: 0, duration: 0.22, accent: 1.08 },
      { root: 0, at: 0.27, duration: 0.22 },
      { root: 7, at: 0.54, duration: 0.25 },
      { root: 4, at: 0.84, duration: 0.24 },
      { root: 9, at: 1.13, duration: 0.44, accent: 1.08 },
    ],
    voicing: [0, 7, 12, 16, 22], tension: 0.2, gain: 0.145, wave: 'triangle',
  },
  amaze: {
    baseHz: 238,
    syllables: [
      { root: 0, at: 0, duration: 0.18 },
      { root: 4, at: 0.2, duration: 0.18 },
      { root: 7, at: 0.4, duration: 0.18 },
      { root: 12, at: 0.6, duration: 0.2 },
      { root: 16, at: 0.84, duration: 0.5, accent: 1.14 },
    ],
    voicing: [0, 7, 12, 16, 24], tension: 0.34, gain: 0.15, wave: 'triangle',
  },
  concern: {
    baseHz: 92,
    syllables: [
      { root: 3, at: 0, duration: 0.46 },
      { root: -1, at: 0.5, duration: 0.5 },
      { root: -4, at: 1.04, duration: 0.7, accent: 1.1 },
    ],
    voicing: [0, 6, 12, 15, 20], tension: 0.62, gain: 0.15, wave: 'sawtooth',
  },
  focus: {
    baseHz: 118,
    syllables: [
      { root: 0, at: 0, duration: 0.28, accent: 1.08 },
      { root: 7, at: 0.34, duration: 0.28 },
      { root: 0, at: 0.68, duration: 0.28 },
      { root: 7, at: 1.02, duration: 0.52, accent: 1.08 },
    ],
    voicing: [0, 7, 12, 19, 24], tension: 0.08, gain: 0.13, wave: 'sine',
  },
  complete: {
    baseHz: 184,
    syllables: [
      { root: 0, at: 0, duration: 0.22 },
      { root: 7, at: 0.26, duration: 0.22 },
      { root: 12, at: 0.52, duration: 0.25 },
      { root: 7, at: 0.82, duration: 0.2 },
      { root: 12, at: 1.06, duration: 0.52, accent: 1.12 },
    ],
    voicing: [0, 7, 12, 16, 19], tension: 0.1, gain: 0.15, wave: 'triangle',
  },
  rest: {
    baseHz: 78,
    syllables: [
      { root: 2, at: 0, duration: 0.7 },
      { root: 0, at: 0.74, duration: 0.76 },
      { root: -5, at: 1.54, duration: 0.95 },
    ],
    voicing: [0, 7, 12, 16, 19], tension: 0.05, gain: 0.115, wave: 'sine',
  },
  farewell: {
    baseHz: 168,
    syllables: [
      { root: 7, at: 0, duration: 0.34 },
      { root: 4, at: 0.38, duration: 0.36 },
      { root: 0, at: 0.79, duration: 0.42 },
      { root: -5, at: 1.26, duration: 0.72, accent: 0.92 },
    ],
    voicing: [0, 7, 12, 16, 19], tension: 0.12, gain: 0.13, wave: 'sine',
  },
};

const semitones = (base: number, n: number): number => base * 2 ** (n / 12);

export class ToneVoice {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private muted = false;

  setMuted(muted: boolean): void {
    this.muted = muted;
  }

  play(motif: EridianMotif, volume = 1): number[] {
    if (this.muted) return [];
    const ctx = this.ensureContext();
    if (!ctx || !this.master) return [];
    if (ctx.state === 'suspended') void ctx.resume();

    const phrase = MOTIFS[motif];
    const start = ctx.currentTime + 0.015;
    const level = Math.max(0, Math.min(1, volume));
    for (const syllable of phrase.syllables) {
      this.scheduleChord(
        ctx,
        this.master,
        semitones(phrase.baseHz, syllable.root),
        start + syllable.at,
        syllable.duration,
        phrase.gain * level * (syllable.accent ?? 1),
        phrase,
      );
    }
    return phrase.syllables.map((syllable) => syllable.at);
  }

  private ensureContext(): AudioContext | null {
    if (this.ctx) return this.ctx;
    const Ctor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    const ctx = new Ctor();
    const master = ctx.createGain();
    master.gain.value = 0.78;
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -18;
    compressor.ratio.value = 4;
    master.connect(compressor);
    compressor.connect(ctx.destination);
    this.ctx = ctx;
    this.master = master;
    return ctx;
  }

  private scheduleChord(
    ctx: AudioContext,
    out: GainNode,
    root: number,
    when: number,
    duration: number,
    peak: number,
    phrase: MotifPhrase,
  ): void {
    const envelope = ctx.createGain();
    const stone = ctx.createBiquadFilter();
    stone.type = 'bandpass';
    stone.frequency.value = Math.min(2600, Math.max(340, root * 3.5));
    stone.Q.value = 1.05 + phrase.tension * 2.3;
    envelope.connect(stone);
    stone.connect(out);

    const attack = phrase.tension > 0.5 ? 0.012 : root < 105 ? 0.055 : 0.028;
    const release = Math.min(0.3, duration * 0.46);
    envelope.gain.setValueAtTime(0.0001, when);
    envelope.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), when + attack);
    envelope.gain.setValueAtTime(peak, Math.max(when + attack, when + duration - release));
    envelope.gain.exponentialRampToValueAtTime(0.0001, when + duration);

    phrase.voicing.forEach((interval, index) => {
      const osc = ctx.createOscillator();
      const partial = ctx.createGain();
      osc.type = index === 4 && phrase.tension > 0.5 ? 'triangle' : phrase.wave;
      osc.frequency.value = semitones(root, interval);
      // Organic variation is deliberately tiny: the phrase and chord remain stable.
      osc.detune.value = (Math.random() - 0.5) * 10;
      partial.gain.value = (index === 0 ? 0.34 : 0.16) * (0.97 + Math.random() * 0.06);
      osc.connect(partial);
      partial.connect(envelope);
      osc.start(when);
      osc.stop(when + duration + 0.03);
      osc.onended = () => {
        osc.disconnect();
        partial.disconnect();
      };
    });

    // Disconnect shared nodes after the last voice has ended.
    window.setTimeout(() => {
      envelope.disconnect();
      stone.disconnect();
    }, Math.max(0, (when + duration - ctx.currentTime + 0.1) * 1000));
  }
}
