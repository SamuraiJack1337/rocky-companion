// Minimal WAV (PCM 16-bit mono) encoding + linear resampling, dependency-free.
// Used by the renderer to turn captured microphone samples into a small WAV
// buffer that both the OpenAI transcription API and whisper.cpp accept.
// Pure functions so they are unit-testable outside Electron.

/** Target sample rate for speech-to-text; both backends are happiest at 16 kHz. */
export const STT_SAMPLE_RATE = 16_000;

/**
 * Linear-interpolation resample. Fine for speech (we do not need audiophile
 * quality — the transcriber only needs intelligible audio).
 */
export function resampleLinear(
  samples: Float32Array,
  fromRate: number,
  toRate: number,
): Float32Array {
  if (fromRate === toRate || samples.length === 0) return samples;
  const ratio = fromRate / toRate;
  const outLength = Math.max(1, Math.floor(samples.length / ratio));
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio;
    const left = Math.floor(pos);
    const right = Math.min(samples.length - 1, left + 1);
    const frac = pos - left;
    out[i] = samples[left] * (1 - frac) + samples[right] * frac;
  }
  return out;
}

/** Encode float samples in [-1, 1] as a complete 16-bit PCM mono WAV file. */
export function encodeWavPcm16(samples: Float32Array, sampleRate: number): Uint8Array {
  const dataLength = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);

  const writeAscii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataLength, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(36, 'data');
  view.setUint32(40, dataLength, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }
  return new Uint8Array(buffer);
}

/** Base64-encode bytes without Node's Buffer (renderer-safe), chunked so large
 *  recordings never blow the call stack. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Validate a renderer-produced WAV before it crosses the IPC boundary.
 * This is intentionally structural rather than content-aware: transcription
 * remains the provider's job, while malformed or oversized payloads are
 * rejected before they can reach a CLI or cloud SDK.
 */
export function isPlausibleWavBase64(value: unknown, maxBytes = 8 * 1024 * 1024): boolean {
  if (typeof value !== 'string' || value.length === 0 || value.length > Math.ceil(maxBytes * 4 / 3) + 16) {
    return false;
  }
  try {
    const decoded = atob(value);
    if (decoded.length < 44 || decoded.length > maxBytes) return false;
    const bytes = Uint8Array.from(decoded, (char) => char.charCodeAt(0));
    const ascii = (offset: number, length: number): string =>
      String.fromCharCode(...bytes.subarray(offset, offset + length));
    if (ascii(0, 4) !== 'RIFF' || ascii(8, 4) !== 'WAVE') return false;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const riffSize = view.getUint32(4, true);
    if (riffSize < 36 || riffSize > bytes.length - 8) return false;

    let sawFmt = false;
    let sawData = false;
    let offset = 12;
    while (offset + 8 <= bytes.length) {
      const id = ascii(offset, 4);
      const size = view.getUint32(offset + 4, true);
      const end = offset + 8 + size;
      if (end > bytes.length) return false;
      if (id === 'fmt ' && size >= 16) {
        const format = view.getUint16(offset + 8, true);
        const channels = view.getUint16(offset + 10, true);
        const sampleRate = view.getUint32(offset + 12, true);
        const bits = view.getUint16(offset + 22, true);
        sawFmt = format === 1 && channels === 1 && sampleRate >= 8000 && sampleRate <= 48000 && bits === 16;
      } else if (id === 'data' && size > 0) {
        sawData = true;
      }
      offset = end + (size % 2);
    }
    return sawFmt && sawData;
  } catch {
    return false;
  }
}
