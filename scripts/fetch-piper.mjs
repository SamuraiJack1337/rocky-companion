// Downloads the bundled offline neural TTS engine and Rocky's voice model into
// vendor/, ready for electron-builder to package as extraResources.
//
// Two engines, one voice (see src/main/piperTts.ts):
//   • Windows → Piper (MIT). Prebuilt piper_windows_amd64 + the en_US-ryan
//     .onnx voice from HuggingFace.
//   • macOS   → sherpa-onnx (Apache-2.0). The upstream Piper macOS binaries are
//     broken/mislabeled, so we ship sherpa-onnx's clean universal2 (arm64 +
//     x86_64) prebuilt, which runs the SAME .onnx voice. Its release model
//     package bundles model + tokens + espeak-ng-data.
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
const PIPER_TAG = '2023.11.14-2';
const SHERPA_TAG = 'v1.13.4';
const VOICE = 'en_US-ryan-medium'; // warm, clear male voice — a fitting Rocky register
const VOICE_URL_DIR =
  'https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/ryan/medium';

const PIPER_ZIP = {
  win32: `https://github.com/rhasspy/piper/releases/download/${PIPER_TAG}/piper_windows_amd64.zip`,
};

// sherpa-onnx macOS runtime (universal2: one binary/lib for arm64 + x86_64) and
// the matching Piper VITS voice package.
const SHERPA_MAC_TARBALL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/${SHERPA_TAG}/sherpa-onnx-${SHERPA_TAG}-osx-universal2-shared.tar.bz2`;
const SHERPA_MAC_TOPDIR = `sherpa-onnx-${SHERPA_TAG}-osx-universal2-shared`;
const SHERPA_VOICE_TARBALL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-${VOICE}.tar.bz2`;

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

// -- Windows: Piper --------------------------------------------------------

async function fetchVoiceWin() {
  const dir = path.join(VENDOR, 'voices');
  fs.mkdirSync(dir, { recursive: true });
  const model = path.join(dir, `${VOICE}.onnx`);
  const config = path.join(dir, `${VOICE}.onnx.json`);
  if (fs.existsSync(model) && fs.existsSync(config)) {
    console.log(`voice ${VOICE} (win): already present`);
    return;
  }
  console.log(`voice ${VOICE} (win):`);
  await download(`${VOICE_URL_DIR}/${VOICE}.onnx`, model);
  await download(`${VOICE_URL_DIR}/${VOICE}.onnx.json`, config);
}

async function fetchPiperWin() {
  const winDir = path.join(VENDOR, 'piper', 'win');
  if (fs.existsSync(path.join(winDir, 'piper.exe'))) {
    console.log('piper (win): already present');
    return;
  }
  console.log('piper (win):');
  const tmpZip = path.join(VENDOR, 'piper_win.zip');
  await download(PIPER_ZIP.win32, tmpZip);
  // The zip contains a top-level `piper/` folder; extract then hoist it to win/.
  const staging = path.join(VENDOR, '_piper_win_staging');
  fs.rmSync(staging, { recursive: true, force: true });
  extractArchive(tmpZip, staging);
  fs.rmSync(winDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(winDir), { recursive: true });
  fs.renameSync(path.join(staging, 'piper'), winDir);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.rmSync(tmpZip, { force: true });
  console.log(`  → ${path.relative(ROOT, winDir)}`);
}

// -- macOS: sherpa-onnx ----------------------------------------------------

async function fetchVoiceMac() {
  const dir = path.join(VENDOR, 'voices-mac');
  const model = path.join(dir, `${VOICE}.onnx`);
  const tokens = path.join(dir, 'tokens.txt');
  const espeak = path.join(dir, 'espeak-ng-data');
  if (fs.existsSync(model) && fs.existsSync(tokens) && fs.existsSync(espeak)) {
    console.log(`voice ${VOICE} (mac): already present`);
    return;
  }
  console.log(`voice ${VOICE} (mac):`);
  fs.mkdirSync(dir, { recursive: true });
  const tarball = path.join(VENDOR, 'sherpa_voice_mac.tar.bz2');
  await download(SHERPA_VOICE_TARBALL, tarball);
  const staging = path.join(VENDOR, '_sherpa_voice_staging');
  fs.rmSync(staging, { recursive: true, force: true });
  extractArchive(tarball, staging);
  const src = path.join(staging, `vits-piper-${VOICE}`);
  // sherpa's CLI needs the model, tokens, and espeak-ng-data phonemizer dir.
  fs.copyFileSync(path.join(src, `${VOICE}.onnx`), model);
  fs.copyFileSync(path.join(src, `${VOICE}.onnx.json`), path.join(dir, `${VOICE}.onnx.json`));
  fs.copyFileSync(path.join(src, 'tokens.txt'), tokens);
  fs.rmSync(espeak, { recursive: true, force: true });
  fs.cpSync(path.join(src, 'espeak-ng-data'), espeak, { recursive: true });
  fs.rmSync(staging, { recursive: true, force: true });
  fs.rmSync(tarball, { force: true });
  console.log(`  → ${path.relative(ROOT, dir)}`);
}

async function fetchSherpaMac() {
  const macDir = path.join(VENDOR, 'piper', 'mac');
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
  const top = path.join(staging, SHERPA_MAC_TOPDIR);
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

async function main() {
  const platform = targetPlatform();
  fs.mkdirSync(VENDOR, { recursive: true });
  if (platform === 'win32') {
    await fetchVoiceWin();
    await fetchPiperWin();
  } else if (platform === 'darwin') {
    await fetchSherpaMac();
    await fetchVoiceMac();
  } else {
    console.log(`offline voice: no bundled engine for ${platform} (OS voice is used there); skipping.`);
  }
  console.log('offline voice assets ready.');
}

main().catch((err) => {
  console.error(`fetch-piper failed: ${err.message}`);
  process.exit(1);
});
