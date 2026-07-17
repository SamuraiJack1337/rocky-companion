import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { synthesizeWithSherpa } from '../src/main/piperTts';
import type { SherpaResources } from '../src/main/piperTts';

// The synth cores are deliberately electron-free so they can be exercised
// directly. We stand in a fake "sherpa-onnx-offline-tts" — a tiny node script —
// for the real engine, so these tests validate our arg construction,
// temp-file read-back, RIFF guard, and cleanup without the 60 MB runtime.

/** A minimal but valid WAV (RIFF header + a little payload > 44 bytes). */
function fakeWav(): Buffer {
  const header = Buffer.alloc(60);
  header.write('RIFF', 0, 'ascii');
  header.write('WAVE', 8, 'ascii');
  return header;
}

/** Write an executable node script and return its path. */
function writeFakeExe(dir: string, body: string): string {
  const p = path.join(dir, 'sherpa-onnx-offline-tts');
  fs.writeFileSync(p, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
  return p;
}

function resFor(exe: string): SherpaResources {
  return { engine: 'sherpa', exe, model: 'm.onnx', tokens: 't.txt', espeakData: 'espeak' };
}

// The fake engine is a shebang node script we exec directly; Windows can't run
// a shebang, and sherpa is macOS-only anyway, so skip the spawn-based cases on
// Windows. The pure no-spawn guard still runs everywhere.
const posixOnly =
  process.platform === 'win32'
    ? { skip: 'sherpa engine is macOS-only; fake-exe harness needs a POSIX shebang' }
    : {};

test('synthesizeWithSherpa returns the WAV the engine writes to --output-filename', posixOnly, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sherpa-ok-'));
  const wav = fakeWav();
  const exe = writeFakeExe(
    dir,
    `const out = process.argv.find(a => a.startsWith('--output-filename=')).split('=')[1];
     require('fs').writeFileSync(out, Buffer.from(${JSON.stringify(wav.toString('base64'))}, 'base64'));`,
  );
  const buf = await synthesizeWithSherpa(resFor(exe), 'Yo, still standin?');
  assert.ok(buf, 'expected a buffer');
  assert.equal(buf!.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(buf!.length, wav.length);
});

test('synthesizeWithSherpa passes the tuning + voice args to the engine', posixOnly, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sherpa-args-'));
  // The fake writes a WAV *and* echoes its argv to a sidecar so we can assert.
  const exe = writeFakeExe(
    dir,
    `const fs = require('fs');
     const out = process.argv.find(a => a.startsWith('--output-filename=')).split('=')[1];
     fs.writeFileSync(out.replace(/\\.wav$/, '.argv'), JSON.stringify(process.argv.slice(2)));
     const h = Buffer.alloc(60); h.write('RIFF',0,'ascii');
     fs.writeFileSync(out, h);`,
  );
  const buf = await synthesizeWithSherpa(resFor(exe), '  hello  ');
  assert.ok(buf, 'expected a buffer');
  // The output WAV is cleaned up, but the sidecar next to it survives.
  const sidecar = fs.readdirSync(os.tmpdir()).find((f) => f.startsWith('rocky-tts-') && f.endsWith('.argv'));
  assert.ok(sidecar, 'expected an argv sidecar');
  const argv: string[] = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), sidecar!), 'utf8'));
  assert.ok(argv.includes('--vits-model=m.onnx'));
  assert.ok(argv.includes('--vits-tokens=t.txt'));
  assert.ok(argv.includes('--vits-data-dir=espeak'));
  assert.ok(argv.includes('--vits-length-scale=1.05'));
  assert.equal(argv[argv.length - 1], 'hello', 'text is trimmed and passed last');
  fs.rmSync(path.join(os.tmpdir(), sidecar!), { force: true });
});

test('synthesizeWithSherpa returns null when the engine exits non-zero', posixOnly, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sherpa-fail-'));
  const exe = writeFakeExe(dir, 'process.exit(1);');
  const buf = await synthesizeWithSherpa(resFor(exe), 'nope');
  assert.equal(buf, null);
});

test('synthesizeWithSherpa returns null on empty text without spawning', async () => {
  // A non-existent exe proves we never spawn when the text is blank.
  const buf = await synthesizeWithSherpa(resFor('/no/such/binary'), '   ');
  assert.equal(buf, null);
});

test('synthesizeWithSherpa cleans up its temp WAV', posixOnly, async () => {
  const before = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('rocky-tts-')).length;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sherpa-clean-'));
  const exe = writeFakeExe(
    dir,
    `const out = process.argv.find(a => a.startsWith('--output-filename=')).split('=')[1];
     const h = Buffer.alloc(60); h.write('RIFF',0,'ascii');
     require('fs').writeFileSync(out, h);`,
  );
  await synthesizeWithSherpa(resFor(exe), 'clean me');
  // Cleanup is best-effort/async; give the fs.rm a tick to land.
  await new Promise((r) => setTimeout(r, 50));
  const after = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('rocky-tts-') && f.endsWith('.wav')).length;
  assert.equal(after, before, 'temp WAV should be removed after synth');
});
