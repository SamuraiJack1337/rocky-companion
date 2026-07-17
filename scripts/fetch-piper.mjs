// Downloads the bundled offline neural TTS engine (Piper) and Rocky's voice
// model into vendor/, ready for electron-builder to package as extraResources.
//
// Piper is MIT-licensed and fully offline. We currently ship it on WINDOWS
// only — the upstream macOS binaries are broken/mislabeled (x86_64 under an
// "aarch64" name, mispackaged dylibs), so macOS keeps the OS voice until a
// robust engine (sherpa-onnx) lands in a follow-up. See src/main/piperTts.ts.
//
// Run automatically before a Windows build (npm run dist:win / CI exe job).
// Idempotent: existing files are left in place. No npm dependencies — Node's
// built-in fetch downloads, and `tar` (present on windows-latest and macOS)
// extracts the .zip.

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = path.join(ROOT, 'vendor');

// Pinned upstream versions so builds are reproducible.
const PIPER_TAG = '2023.11.14-2';
const VOICE = 'en_US-ryan-medium'; // warm, clear male voice — a fitting Rocky register
const VOICE_URL_DIR =
  'https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/ryan/medium';

const PIPER_ZIP = {
  win32: `https://github.com/rhasspy/piper/releases/download/${PIPER_TAG}/piper_windows_amd64.zip`,
};

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

function extractZip(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  // bsdtar (the `tar` on Windows 10+ and macOS) extracts .zip transparently.
  const r = spawnSync('tar', ['-xf', zipPath, '-C', destDir], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`tar failed to extract ${zipPath}`);
}

async function fetchVoice() {
  const dir = path.join(VENDOR, 'voices');
  fs.mkdirSync(dir, { recursive: true });
  const model = path.join(dir, `${VOICE}.onnx`);
  const config = path.join(dir, `${VOICE}.onnx.json`);
  if (fs.existsSync(model) && fs.existsSync(config)) {
    console.log(`voice ${VOICE}: already present`);
    return;
  }
  console.log(`voice ${VOICE}:`);
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
  extractZip(tmpZip, staging);
  fs.rmSync(winDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(winDir), { recursive: true });
  fs.renameSync(path.join(staging, 'piper'), winDir);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.rmSync(tmpZip, { force: true });
  console.log(`  → ${path.relative(ROOT, winDir)}`);
}

async function main() {
  const platform = targetPlatform();
  fs.mkdirSync(VENDOR, { recursive: true });
  await fetchVoice();
  if (platform === 'win32') {
    await fetchPiperWin();
  } else {
    console.log(`piper: no bundled binary for ${platform} yet (OS voice is used there); skipping.`);
  }
  console.log('piper assets ready.');
}

main().catch((err) => {
  console.error(`fetch-piper failed: ${err.message}`);
  process.exit(1);
});
