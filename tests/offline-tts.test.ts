import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { synthesizeWithKokoro, isPlausibleWav } from '../src/main/offlineTts';
import type { KokoroResources } from '../src/main/offlineTts';

// The synth core is deliberately electron-free so it can be exercised
// directly. We stand in a fake "sherpa-onnx-offline-tts" — a tiny node script —
// for the real engine, so these tests validate our arg construction,
// temp-file read-back, WAV guard, and cleanup without the real runtime.

/** A minimal but structurally valid WAV: RIFF/WAVE + fmt (mono 24 kHz) + data. */
function fakeWav(dataBytes = 32, sampleRate = 24_000): Buffer {
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16); // fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
  return buf;
}

/** Write an executable node script and return its path. */
function writeFakeExe(dir: string, body: string): string {
  const p = path.join(dir, 'sherpa-onnx-offline-tts');
  fs.writeFileSync(p, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
  return p;
}

function resFor(exe: string): KokoroResources {
  return { exe, model: 'm.onnx', voices: 'v.bin', tokens: 't.txt', espeakData: 'espeak' };
}

// The fake engine is a shebang node script we exec directly; Windows can't run
// a shebang, so the spawn-based cases are skipped there (a harness limitation
// only — the real engine DOES ship on Windows). The pure cases run everywhere.
const posixOnly =
  process.platform === 'win32'
    ? { skip: 'fake-exe harness needs a POSIX shebang (engine itself runs on Windows)' }
    : {};

/** Fake-engine body that writes a valid WAV to --output-filename. Uses its own
 *  variable name so tests can prepend argv-echo code without redeclaration. */
const WRITES_WAV = `const __wavOut = process.argv.find(a => a.startsWith('--output-filename=')).split('=')[1];
require('fs').writeFileSync(__wavOut, Buffer.from(${JSON.stringify(fakeWav().toString('base64'))}, 'base64'));`;

test('synthesizeWithKokoro returns the WAV the engine writes to --output-filename', posixOnly, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kokoro-ok-'));
  const exe = writeFakeExe(dir, WRITES_WAV);
  const buf = await synthesizeWithKokoro(resFor(exe), 'Yo, still standin?');
  assert.ok(buf, 'expected a buffer');
  assert.equal(buf!.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(buf!.length, fakeWav().length);
});

test('synthesizeWithKokoro passes the kokoro + speaker args to the engine', posixOnly, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kokoro-args-'));
  // The fake writes a WAV *and* echoes its argv to a sidecar so we can assert.
  const exe = writeFakeExe(
    dir,
    `const fs = require('fs');
     const out = process.argv.find(a => a.startsWith('--output-filename=')).split('=')[1];
     fs.writeFileSync(out.replace(/\\.wav$/, '.argv'), JSON.stringify(process.argv.slice(2)));
     ${WRITES_WAV}`,
  );
  const buf = await synthesizeWithKokoro(resFor(exe), '  hello  ', { sid: 9, lengthScale: 0.91 });
  assert.ok(buf, 'expected a buffer');
  // The output WAV is cleaned up, but the sidecar next to it survives.
  const sidecar = fs.readdirSync(os.tmpdir()).find((f) => f.startsWith('rocky-tts-') && f.endsWith('.argv'));
  assert.ok(sidecar, 'expected an argv sidecar');
  const argv: string[] = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), sidecar!), 'utf8'));
  assert.ok(argv.includes('--kokoro-model=m.onnx'));
  assert.ok(argv.includes('--kokoro-voices=v.bin'));
  assert.ok(argv.includes('--kokoro-tokens=t.txt'));
  assert.ok(argv.includes('--kokoro-data-dir=espeak'));
  assert.ok(argv.includes('--kokoro-length-scale=0.91'));
  assert.ok(argv.includes('--sid=9'));
  assert.equal(argv[argv.length - 1], 'hello', 'text is trimmed and passed last');
  fs.rmSync(path.join(os.tmpdir(), sidecar!), { force: true });
});

test('synthesizeWithKokoro defaults the speaker and pace', posixOnly, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kokoro-defaults-'));
  const exe = writeFakeExe(
    dir,
    `const fs = require('fs');
     const out = process.argv.find(a => a.startsWith('--output-filename=')).split('=')[1];
     fs.writeFileSync(out.replace(/\\.wav$/, '.dargv'), JSON.stringify(process.argv.slice(2)));
     ${WRITES_WAV}`,
  );
  const buf = await synthesizeWithKokoro(resFor(exe), 'defaults');
  assert.ok(buf, 'expected a buffer');
  const sidecar = fs.readdirSync(os.tmpdir()).find((f) => f.startsWith('rocky-tts-') && f.endsWith('.dargv'));
  assert.ok(sidecar, 'expected an argv sidecar');
  const argv: string[] = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), sidecar!), 'utf8'));
  assert.ok(argv.includes('--sid=6'), 'default speaker is am_michael (6)');
  assert.ok(argv.includes('--kokoro-length-scale=1.00'), 'default pace is 1.0');
  fs.rmSync(path.join(os.tmpdir(), sidecar!), { force: true });
});

test('synthesizeWithKokoro returns null when the engine exits non-zero', posixOnly, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kokoro-fail-'));
  const exe = writeFakeExe(dir, 'process.exit(1);');
  const buf = await synthesizeWithKokoro(resFor(exe), 'nope');
  assert.equal(buf, null);
});

test('synthesizeWithKokoro rejects a structurally bogus WAV', posixOnly, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kokoro-bogus-'));
  // RIFF magic but no fmt/data chunks — the old 4-byte guard passed this.
  const exe = writeFakeExe(
    dir,
    `const out = process.argv.find(a => a.startsWith('--output-filename=')).split('=')[1];
     const h = Buffer.alloc(60); h.write('RIFF',0,'ascii'); h.write('WAVE',8,'ascii');
     require('fs').writeFileSync(out, h);`,
  );
  const buf = await synthesizeWithKokoro(resFor(exe), 'static?');
  assert.equal(buf, null);
});

test('synthesizeWithKokoro returns null on empty text without spawning', async () => {
  // A non-existent exe proves we never spawn when the text is blank.
  const buf = await synthesizeWithKokoro(resFor('/no/such/binary'), '   ');
  assert.equal(buf, null);
});

test('synthesizeWithKokoro cleans up its temp WAV', posixOnly, async () => {
  // Let the previous tests' best-effort async cleanups land before counting.
  await new Promise((r) => setTimeout(r, 100));
  const before = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('rocky-tts-') && f.endsWith('.wav')).length;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kokoro-clean-'));
  const exe = writeFakeExe(dir, WRITES_WAV);
  await synthesizeWithKokoro(resFor(exe), 'clean me');
  // Cleanup is best-effort/async; give the fs.rm a tick to land.
  await new Promise((r) => setTimeout(r, 50));
  const after = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('rocky-tts-') && f.endsWith('.wav')).length;
  assert.equal(after, before, 'temp WAV should be removed after synth');
});

// ── isPlausibleWav (pure — runs on every platform, incl. Windows CI) ─────────

test('isPlausibleWav accepts a well-formed PCM WAV', () => {
  assert.equal(isPlausibleWav(fakeWav()), true);
  assert.equal(isPlausibleWav(fakeWav(1000, 22_050)), true);
});

test('isPlausibleWav rejects truncated or magic-less buffers', () => {
  assert.equal(isPlausibleWav(Buffer.alloc(10)), false);
  assert.equal(isPlausibleWav(Buffer.alloc(100)), false); // zeros, no magics
  const noWave = fakeWav();
  noWave.write('XXXX', 8, 'ascii');
  assert.equal(isPlausibleWav(noWave), false);
});

test('isPlausibleWav rejects a bare RIFF header with no chunks (the old guard passed this)', () => {
  const h = Buffer.alloc(60);
  h.write('RIFF', 0, 'ascii');
  h.write('WAVE', 8, 'ascii');
  assert.equal(isPlausibleWav(h), false);
});

test('isPlausibleWav rejects implausible sample rates and empty data', () => {
  assert.equal(isPlausibleWav(fakeWav(32, 4_000)), false); // below speech range
  assert.equal(isPlausibleWav(fakeWav(32, 96_000)), false); // absurd for this engine
  assert.equal(isPlausibleWav(fakeWav(0)), false); // data chunk present but empty
});
