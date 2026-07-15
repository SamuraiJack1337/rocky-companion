import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeWavPcm16, resampleLinear, STT_SAMPLE_RATE } from '../src/shared/wav';

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function u32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset).getUint32(offset, true);
}

function u16(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset).getUint16(offset, true);
}

function i16(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset).getInt16(offset, true);
}

test('encodes a valid PCM16 mono WAV header', () => {
  const samples = new Float32Array([0, 0.5, -0.5, 1]);
  const wav = encodeWavPcm16(samples, STT_SAMPLE_RATE);

  assert.equal(wav.length, 44 + samples.length * 2);
  assert.equal(ascii(wav, 0, 4), 'RIFF');
  assert.equal(ascii(wav, 8, 4), 'WAVE');
  assert.equal(ascii(wav, 12, 4), 'fmt ');
  assert.equal(ascii(wav, 36, 4), 'data');
  assert.equal(u32(wav, 4), 36 + samples.length * 2); // RIFF size
  assert.equal(u16(wav, 20), 1); // PCM
  assert.equal(u16(wav, 22), 1); // mono
  assert.equal(u32(wav, 24), STT_SAMPLE_RATE);
  assert.equal(u32(wav, 28), STT_SAMPLE_RATE * 2); // byte rate
  assert.equal(u16(wav, 34), 16); // bits per sample
  assert.equal(u32(wav, 40), samples.length * 2); // data size
});

test('encodes sample values with clamping', () => {
  const wav = encodeWavPcm16(new Float32Array([0, 1, -1, 2, -2]), 16_000);
  assert.equal(i16(wav, 44), 0);
  assert.equal(i16(wav, 46), 0x7fff); // +1 → max
  assert.equal(i16(wav, 48), -0x8000); // -1 → min
  assert.equal(i16(wav, 50), 0x7fff); // clamped over-range
  assert.equal(i16(wav, 52), -0x8000);
});

test('resample halves the sample count for a 2:1 ratio', () => {
  const input = new Float32Array(1000).fill(0.25);
  const out = resampleLinear(input, 32_000, 16_000);
  assert.equal(out.length, 500);
  assert.ok(Math.abs(out[250] - 0.25) < 1e-6);
});

test('resample is identity at equal rates and interpolates between samples', () => {
  const input = new Float32Array([0, 1]);
  assert.equal(resampleLinear(input, 16_000, 16_000), input);
  const up = resampleLinear(input, 16_000, 32_000);
  assert.equal(up.length, 4);
  assert.ok(Math.abs(up[1] - 0.5) < 1e-6); // halfway point interpolated
});
