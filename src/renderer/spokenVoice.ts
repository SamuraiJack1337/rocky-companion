// Plays synthesized speech in the renderer via Web Audio. The audio bytes
// arrive from main as base64 (the OpenAI key never leaves main). We decode them
// in memory and schedule them on the AudioContext timeline — a line is one or
// more cadence segments, each followed by a micro-pause, so Rocky's delivery
// breathes. A small pitch shift can make him read a touch deeper.
//
// No files, no <audio> element (so it isn't subject to media-src CSP), no Node.

interface PlayableSegment {
  base64: string;
  mime: string;
  gapMsAfter: number;
}

export class SpokenVoice {
  private ctx: AudioContext | null = null;
  private muted = false;
  private sources: AudioBufferSourceNode[] = [];

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted) this.stop();
  }

  /** Stop anything currently being spoken. */
  stop(): void {
    for (const src of this.sources) {
      try {
        src.stop();
      } catch {
        /* already stopped */
      }
    }
    this.sources = [];
  }

  /**
   * Decode and play an ordered list of segments with their trailing gaps,
   * applying a semitone pitch shift. Resolves with the total spoken duration in
   * seconds (0 if muted/unavailable). Segments that fail to decode are skipped.
   */
  async playSequence(segments: PlayableSegment[], pitchSemitones = 0): Promise<number> {
    if (this.muted || !segments || segments.length === 0) return 0;
    const ctx = this.ensureContext();
    if (!ctx) return 0;
    if (ctx.state === 'suspended') void ctx.resume();

    // Decode all segments up front (in parallel); keep nulls for failures.
    const buffers = await Promise.all(
      segments.map(async (seg) => {
        try {
          return await ctx.decodeAudioData(base64ToArrayBuffer(seg.base64));
        } catch {
          return null;
        }
      }),
    );

    this.stop(); // never overlap with a previous line

    const startGap = 0.02; // tiny lead-in so the first sample isn't clipped
    let cursor = ctx.currentTime + startGap;
    const begin = cursor;

    for (let i = 0; i < buffers.length; i++) {
      const buffer = buffers[i];
      if (!buffer) continue;

      const src = ctx.createBufferSource();
      src.buffer = buffer;
      try {
        src.detune.value = pitchSemitones * 100; // semitones -> cents
      } catch {
        /* detune unsupported — natural pitch */
      }
      const gain = ctx.createGain();
      gain.gain.value = 1;
      src.connect(gain);
      gain.connect(ctx.destination);

      src.start(cursor);
      const self = src;
      src.onended = () => {
        self.disconnect();
        gain.disconnect();
        this.sources = this.sources.filter((s) => s !== self);
      };
      this.sources.push(src);

      cursor += buffer.duration + Math.max(0, segments[i].gapMsAfter) / 1000;
    }

    return Math.max(0, cursor - begin);
  }

  /** Convenience: play a single segment (no trailing gap). */
  async play(base64: string, mime: string, pitchSemitones = 0): Promise<number> {
    return this.playSequence([{ base64, mime, gapMsAfter: 0 }], pitchSemitones);
  }

  private ensureContext(): AudioContext | null {
    if (this.ctx) return this.ctx;
    const Ctor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    this.ctx = new Ctor();
    return this.ctx;
  }
}

/** Decode a base64 string into a fresh ArrayBuffer (browser-safe, no Node Buffer). */
function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const len = binary.length;
  const ab = new ArrayBuffer(len);
  const view = new Uint8Array(ab);
  for (let i = 0; i < len; i++) view[i] = binary.charCodeAt(i);
  return ab;
}
