// Offline spoken voice via the browser Speech Synthesis API (Web Speech). This
// is the OS's own text-to-speech — SAPI voices on Windows, the system voices on
// macOS — so Rocky can speak actual words with NO API key and fully on-device.
// It's the right fit for the local/Ollama setup, where there's no OpenAI key to
// drive cloud TTS.
//
// Everything runs in the renderer: `speechSynthesis` needs no main-process work
// and never touches the network. Only Rocky's short generated line is spoken;
// nothing is sent anywhere.

/** True if this runtime exposes a usable Speech Synthesis engine. */
export function systemVoiceAvailable(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
}

export class SystemVoice {
  private muted = false;
  private cachedVoice: SpeechSynthesisVoice | null = null;

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted) this.stop();
  }

  /** Stop anything currently being spoken. */
  stop(): void {
    if (!systemVoiceAvailable()) return;
    try {
      window.speechSynthesis.cancel();
    } catch {
      /* nothing to cancel */
    }
  }

  /**
   * Rough estimate (seconds) of how long `text` will take to speak, so the seam
   * glow can be scheduled to span the line before the utterance actually ends
   * (the Web Speech API doesn't report a duration up front). Tuned to a typical
   * ~2.8 words/sec delivery, with a small floor so very short lines still glow.
   */
  estimateDuration(text: string): number {
    const words = (text || '').trim().split(/\s+/).filter(Boolean).length;
    return Math.max(0.6, words / 2.8);
  }

  /**
   * Speak a line with an optional semitone pitch shift. Resolves true when the
   * line was actually spoken, or false when muted/unavailable/failed — the
   * caller then falls back to the procedural tone so Rocky is never silent.
   */
  speak(text: string, pitchSemitones = 0): Promise<boolean> {
    const clean = (text || '').trim();
    if (this.muted || !clean || !systemVoiceAvailable()) return Promise.resolve(false);

    return new Promise<boolean>((resolve) => {
      try {
        const synth = window.speechSynthesis;
        synth.cancel(); // never overlap with a previous line

        const utterance = new SpeechSynthesisUtterance(clean);
        const voice = this.pickVoice();
        if (voice) {
          utterance.voice = voice;
          utterance.lang = voice.lang;
        }
        // Web Speech pitch is a 0–2 multiplier; map semitones onto it (2^(n/12))
        // and clamp. Rate stays natural — pitch here does not resample/slow the
        // audio the way the cloud path's buffer detune does.
        utterance.pitch = Math.max(0, Math.min(2, 2 ** (pitchSemitones / 12)));
        utterance.rate = 1.0;

        let settled = false;
        const finish = (ok: boolean) => {
          if (settled) return;
          settled = true;
          resolve(ok);
        };
        utterance.onend = () => finish(true);
        utterance.onerror = () => finish(false);

        synth.speak(utterance);
        // Safety net: if the engine never fires onend/onerror (some platforms
        // go quiet when the app is backgrounded), resolve on an estimate so the
        // caller isn't left awaiting forever.
        window.setTimeout(() => finish(true), (this.estimateDuration(clean) + 2) * 1000);
      } catch {
        resolve(false);
      }
    });
  }

  /** Choose a stable, natural-sounding English voice, preferring local ones. */
  private pickVoice(): SpeechSynthesisVoice | null {
    if (this.cachedVoice) return this.cachedVoice;
    let voices: SpeechSynthesisVoice[] = [];
    try {
      voices = window.speechSynthesis.getVoices();
    } catch {
      return null;
    }
    if (!voices.length) return null; // list can populate asynchronously; retry next line

    const isEnglish = (v: SpeechSynthesisVoice) => /^en(-|_|$)/i.test(v.lang);
    const english = voices.filter(isEnglish);
    const pool = english.length ? english : voices;
    // Prefer a local (offline) voice over a network/remote one.
    this.cachedVoice = pool.find((v) => v.localService) ?? pool[0] ?? null;
    return this.cachedVoice;
  }
}
