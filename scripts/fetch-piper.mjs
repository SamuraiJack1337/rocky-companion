// Downloads the bundled offline neural TTS engine and Rocky's voice model into
// vendor/, ready for electron-builder to package as extraResources.
//
// One engine, one voice, both platforms (see src/main/offlineTts.ts):
//   • Engine → sherpa-onnx (Apache-2.0) offline-tts CLI. macOS gets the clean
//     universal2 (arm64 + x86_64) prebuilt; Windows gets the x64 MT build
//     (statically-linked MSVC CRT, so no VC++ Redistributable needed).
//   • Voice  → Kokoro (Apache-2.0), fp32 English model from the sherpa-onnx
//     tts-models release. Far more natural than the Piper/VITS voices this
//     replaced, and the SAME model files serve both platforms.
//
// Run automatically before a build (npm run dist:* / CI). Idempotent: existing
// files are left in place. No npm dependencies — Node's built-in fetch
// downloads, and `tar` (bsdtar on windows-latest and macOS) extracts .zip and
// .tar.bz2 transparently.

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = path.join(ROOT, 'vendor');

// Pinned upstream versions so builds are reproducible.
const SHERPA_TAG = 'v1.13.4';
const SHERPA_BASE = `https://github.com/k2-fsa/sherpa-onnx/releases/download/${SHERPA_TAG}`;
const SHERPA_MAC_TARBALL = `${SHERPA_BASE}/sherpa-onnx-${SHERPA_TAG}-osx-universal2-shared.tar.bz2`;
// MT = static MSVC CRT: users don't need the VC++ Redistributable installed.
const SHERPA_WIN_TARBALL = `${SHERPA_BASE}/sherpa-onnx-${SHERPA_TAG}-win-x64-shared-MT-Release.tar.bz2`;

// Kokoro voice — fp32 (~330 MB extracted). The int8 quantization was audibly
// muddier on the male speaker we ship (am_michael), so we take the size hit for
// the clearly better voice. int8 (`kokoro-int8-en-v0_19`, ~100 MB) remains a
// drop-in swap here if bundle size ever has to win over quality.
const KOKORO = 'kokoro-en-v0_19';
const KOKORO_TARBALL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/${KOKORO}.tar.bz2`;
/** Model file the chosen archive extracts (int8 archives ship model.int8.onnx). */
const KOKORO_MODEL = KOKORO.includes('int8') ? 'model.int8.onnx' : 'model.onnx';

/** Which platform to fetch for. Defaults to the host; override with --platform. */
function targetPlatform() {
  const flag = process.argv.find((a) => a.startsWith('--platform='));
  return flag ? flag.split('=')[1] : process.platform;
}

async function download(url, dest) {
  process.stdout.write(`  ↓ ${path.basename(dest)} … `);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  console.log(`${(buf.length / 1e6).toFixed(1)} MB`);
}

function extractArchive(archivePath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  // bsdtar (the `tar` on Windows 10+ and macOS) extracts .zip and .tar.bz2.
  const r = spawnSync('tar', ['-xf', archivePath, '-C', destDir], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`tar failed to extract ${archivePath}`);
}

/** The single directory an archive extracted into (upstream names vary). */
function soleSubdir(staging) {
  const entries = fs.readdirSync(staging).filter((f) => {
    return fs.statSync(path.join(staging, f)).isDirectory();
  });
  if (entries.length !== 1) {
    throw new Error(`expected one top-level dir in ${staging}, found: ${entries.join(', ')}`);
  }
  return path.join(staging, entries[0]);
}

/** Remove leftovers of the pre-Kokoro layout (Piper engine, ryan voices). */
function pruneLegacyLayout() {
  for (const stale of ['piper', 'voices', 'voices-mac']) {
    const dir = path.join(VENDOR, stale);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      console.log(`pruned stale vendor/${stale}`);
    }
  }
}

// -- Voice: Kokoro (shared by both platforms) --------------------------------

async function fetchKokoroVoice() {
  const dir = path.join(VENDOR, 'voice-kokoro');
  // Key the "already present" check on the EXACT expected model file, so
  // switching archives (e.g. int8 → fp32) re-fetches instead of leaving a
  // stale model.int8.onnx alongside a build that expects model.onnx.
  const complete =
    fs.existsSync(path.join(dir, KOKORO_MODEL)) &&
    fs.existsSync(path.join(dir, 'voices.bin')) &&
    fs.existsSync(path.join(dir, 'tokens.txt')) &&
    fs.existsSync(path.join(dir, 'espeak-ng-data'));
  if (complete) {
    console.log(`voice ${KOKORO}: already present`);
    return;
  }
  console.log(`voice ${KOKORO}:`);
  const tarball = path.join(VENDOR, 'kokoro.tar.bz2');
  await download(KOKORO_TARBALL, tarball);
  const staging = path.join(VENDOR, '_kokoro_staging');
  fs.rmSync(staging, { recursive: true, force: true });
  extractArchive(tarball, staging);
  const src = soleSubdir(staging);
  // sherpa's CLI needs the model, voices.bin (speaker embeddings), tokens, and
  // the espeak-ng-data phonemizer dir. Keep LICENSE for attribution.
  const model = fs.readdirSync(src).find((f) => f.endsWith('.onnx'));
  if (!model) throw new Error(`no .onnx model in ${src}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(src, model), path.join(dir, model));
  for (const f of ['voices.bin', 'tokens.txt', 'LICENSE']) {
    if (fs.existsSync(path.join(src, f))) fs.copyFileSync(path.join(src, f), path.join(dir, f));
  }
  fs.cpSync(path.join(src, 'espeak-ng-data'), path.join(dir, 'espeak-ng-data'), {
    recursive: true,
  });
  fs.rmSync(staging, { recursive: true, force: true });
  fs.rmSync(tarball, { force: true });
  console.log(`  → ${path.relative(ROOT, dir)}`);
}

// -- Engine: sherpa-onnx ------------------------------------------------------

async function fetchSherpaMac() {
  const macDir = path.join(VENDOR, 'sherpa', 'mac');
  const exe = path.join(macDir, 'sherpa-onnx-offline-tts');
  if (fs.existsSync(exe)) {
    console.log('sherpa-onnx (mac): already present');
    return;
  }
  console.log('sherpa-onnx (mac):');
  fs.mkdirSync(macDir, { recursive: true });
  const tarball = path.join(VENDOR, 'sherpa_mac.tar.bz2');
  await download(SHERPA_MAC_TARBALL, tarball);
  const staging = path.join(VENDOR, '_sherpa_mac_staging');
  fs.rmSync(staging, { recursive: true, force: true });
  extractArchive(tarball, staging);
  const top = soleSubdir(staging);
  // We only need the offline-tts CLI (sherpa's C++ is static-linked into it)
  // and its onnxruntime dylib; the binary's @loader_path rpath finds the dylib
  // as a sibling. Everything else in the tarball is unused.
  fs.copyFileSync(path.join(top, 'bin', 'sherpa-onnx-offline-tts'), exe);
  fs.chmodSync(exe, 0o755);
  const libDir = path.join(top, 'lib');
  const dylib = fs
    .readdirSync(libDir)
    .find((f) => /^libonnxruntime\.\d[\d.]*\.dylib$/.test(f));
  if (!dylib) throw new Error(`no versioned libonnxruntime dylib in ${libDir}`);
  fs.copyFileSync(path.join(libDir, dylib), path.join(macDir, dylib));
  fs.rmSync(staging, { recursive: true, force: true });
  fs.rmSync(tarball, { force: true });
  console.log(`  → ${path.relative(ROOT, macDir)} (${dylib})`);
}

async function fetchSherpaWin() {
  const winDir = path.join(VENDOR, 'sherpa', 'win');
  const exe = path.join(winDir, 'sherpa-onnx-offline-tts.exe');
  if (fs.existsSync(exe)) {
    console.log('sherpa-onnx (win): already present');
    return;
  }
  console.log('sherpa-onnx (win):');
  fs.mkdirSync(winDir, { recursive: true });
  const tarball = path.join(VENDOR, 'sherpa_win.tar.bz2');
  await download(SHERPA_WIN_TARBALL, tarball);
  const staging = path.join(VENDOR, '_sherpa_win_staging');
  fs.rmSync(staging, { recursive: true, force: true });
  extractArchive(tarball, staging);
  const top = soleSubdir(staging);
  // The CLI resolves its DLLs (onnxruntime + sherpa shared libs) as siblings,
  // mirroring the mac dylib layout. Copy the exe plus every DLL we can find.
  fs.copyFileSync(path.join(top, 'bin', 'sherpa-onnx-offline-tts.exe'), exe);
  let dlls = 0;
  for (const sub of ['bin', 'lib']) {
    const dir = path.join(top, sub);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (f.toLowerCase().endsWith('.dll')) {
        fs.copyFileSync(path.join(dir, f), path.join(winDir, f));
        dlls += 1;
      }
    }
  }
  if (dlls === 0) throw new Error(`no DLLs found under ${top} — CLI would not start`);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.rmSync(tarball, { force: true });
  console.log(`  → ${path.relative(ROOT, winDir)} (${dlls} DLLs)`);
}

async function main() {
  const platform = targetPlatform();
  fs.mkdirSync(VENDOR, { recursive: true });
  pruneLegacyLayout();
  if (platform === 'win32') {
    await fetchSherpaWin();
    await fetchKokoroVoice();
  } else if (platform === 'darwin') {
    await fetchSherpaMac();
    await fetchKokoroVoice();
  } else {
    console.log(`offline voice: no bundled engine for ${platform} (OS voice is used there); skipping.`);
  }
  console.log('offline voice assets ready.');
}

main().catch((err) => {
  console.error(`fetch-piper failed: ${err.message}`);
  process.exit(1);
});
