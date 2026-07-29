// Microphone capture for voice notes. Runs in a renderer (companion or chat
// window): getUserMedia → raw PCM chunks → downsample to 16 kHz mono → WAV →
// base64, all in memory. Nothing is written to disk here and no audio API is
// touched until start() is called (macOS shows the mic indicator only while a
// capture is live).

import { bytesToBase64, encodeWavPcm16, resampleLinear, STT_SAMPLE_RATE } from '../shared/wav';

/** Hard cap on captured audio, matching main's recording window. */
const MAX_SECONDS = 125;

export class VoiceRecorder {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private chunks: Float32Array[] = [];
  private capturedSamples = 0;
  private active = false;

  isActive(): boolean {
    return this.active;
  }

  /** Begin capturing. Throws when the microphone is unavailable/denied. */
  async start(): Promise<void> {
    if (this.active) return;
    this.chunks = [];
    this.capturedSamples = 0;

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
    });
    this.ctx = new AudioContext();
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    this.source = this.ctx.createMediaStreamSource(this.stream);
    // ScriptProcessor is deprecated but simple and reliable here; an
    // AudioWorklet needs a separate module file, awkward with the IIFE bundles.
    this.processor = this.ctx.createScriptProcessor(4096, 1, 1);
    const maxSamples = this.ctx.sampleRate * MAX_SECONDS;
    this.processor.onaudioprocess = (event) => {
      if (!this.active || this.capturedSamples >= maxSamples) return;
      const input = event.inputBuffer.getChannelData(0);
      this.chunks.push(new Float32Array(input));
      this.capturedSamples += input.length;
    };
    this.source.connect(this.processor);
    // A processor only runs while connected to the destination; it outputs
    // silence (we never write to the output buffer), so nothing is audible.
    this.processor.connect(this.ctx.destination);
    this.active = true;
  }

  /**
   * Stop capturing and return the recording as a base64 16 kHz mono WAV, or
   * null when nothing usable was captured (too short / silent).
   */
  async stop(): Promise<string | null> {
    if (!this.active) return null;
    this.active = false;
    const sampleRate = this.ctx?.sampleRate ?? 48_000;
    this.teardown();

    const total = this.chunks.reduce((n, c) => n + c.length, 0);
    // Under a quarter second cannot hold a word.
    if (total < sampleRate * 0.25) return null;
    const samples = new Float32Array(total);
    let offset = 0;
    for (const chunk of this.chunks) {
      samples.set(chunk, offset);
      offset += chunk.length;
    }
    this.chunks = [];

    // Reject de-facto silence so a pocket press never becomes a note.
    let peak = 0;
    for (let i = 0; i < samples.length; i++) {
      const value = Math.abs(samples[i]);
      if (value > peak) peak = value;
    }
    if (peak < 0.01) return null;

    const resampled = resampleLinear(samples, sampleRate, STT_SAMPLE_RATE);
    return bytesToBase64(encodeWavPcm16(resampled, STT_SAMPLE_RATE));
  }

  /** Abort capturing and discard everything. */
  cancel(): void {
    this.active = false;
    this.chunks = [];
    this.teardown();
  }

  private teardown(): void {
    try {
      this.processor?.disconnect();
      this.source?.disconnect();
    } catch {
      /* already disconnected */
    }
    this.processor = null;
    this.source = null;
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
  }
}
