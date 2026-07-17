// Offline neural spoken voice (main process). A small, fast, fully-offline
// neural TTS is bundled with the app so Rocky has a natural spoken voice with
// NO API key — the right fit for the local / Ollama path, and far better than
// the OS speech engine.
//
// Two engines, one voice: WINDOWS ships Piper (MIT), macOS ships sherpa-onnx
// (Apache-2.0). Both run the SAME en_US-ryan-medium .onnx voice, so Rocky
// sounds identical across platforms; we use sherpa on macOS because the
// upstream Piper macOS binaries are broken/mislabeled (x86_64 under an
// "aarch64" name, mispackaged dylibs) while sherpa-onnx ships clean,
// self-contained universal2 (arm64 + x86_64) prebuilts. On any other platform
// this returns null and the renderer falls back to the OS voice.
//
// Piper writes a WAV to stdout (`-f -`); sherpa has no stdout mode, so it
// writes to a temp file we read back. Either way we hand the bytes to the
// renderer as a single TtsSegment (base64), so the audio flows through the
// exact same playback path (pitch, glow pulses) as the OpenAI voice. Only
// Rocky's short generated line is ever passed in; nothing touches the network.

import { spawn } from 'child_process';
import { app } from 'electron';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { TtsSegment } from '../shared/ipc';

/** Rocky's delivery tuning. Slightly deliberate; a beat between sentences. */
const LENGTH_SCALE = '1.05';
/** Piper-only: silence inserted between sentences. sherpa has no equivalent. */
const SENTENCE_SILENCE = '0.3';
/** Hard cap so a wedged process can never hang the voice. */
const SYNTH_TIMEOUT_MS = 15_000;

/** Piper engine (Windows): piper.exe, text on stdin, WAV on stdout. */
export interface PiperResources {
  engine: 'piper';
  exe: string;
  model: string;
  espeakData: string;
}

/** sherpa-onnx engine (macOS): CLI, text as an arg, WAV written to a file. */
export interface SherpaResources {
  engine: 'sherpa';
  exe: string;
  model: string;
  tokens: string;
  espeakData: string;
}

export type TtsResources = PiperResources | SherpaResources;

/**
 * Root of the bundled engine assets. Packaged (both platforms): the engine
 * lands at <resources>/piper with the voice under <resources>/piper/voice (see
 * electron-builder.yml extraResources). In dev the files live under vendor/,
 * laid out per-platform by scripts/fetch-piper.mjs.
 */
function engineRoot(): { binDir: string; voiceDir: string } {
  if (app.isPackaged) {
    const base = path.join(process.resourcesPath, 'piper');
    return { binDir: base, voiceDir: path.join(base, 'voice') };
  }
  const vendor = path.join(app.getAppPath(), 'vendor');
  if (process.platform === 'darwin') {
    return { binDir: path.join(vendor, 'piper', 'mac'), voiceDir: path.join(vendor, 'voices-mac') };
  }
  return { binDir: path.join(vendor, 'piper', 'win'), voiceDir: path.join(vendor, 'voices') };
}

/** First .onnx voice model in a directory, or null. */
function findModel(voiceDir: string): string | null {
  try {
    const onnx = fs.readdirSync(voiceDir).find((f) => f.endsWith('.onnx'));
    return onnx ? path.join(voiceDir, onnx) : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the bundled engine, voice model, and phonemizer data for this
 * platform — or null when the offline voice isn't available (unsupported
 * platform, or assets absent), in which case callers fall back to the OS voice.
 */
export function piperResources(): TtsResources | null {
  const { binDir, voiceDir } = engineRoot();
  const model = findModel(voiceDir);
  if (!model) return null;

  if (process.platform === 'win32') {
    const exe = path.join(binDir, 'piper.exe');
    const espeakData = path.join(binDir, 'espeak-ng-data');
    if (!fs.existsSync(exe) || !fs.existsSync(espeakData)) return null;
    return { engine: 'piper', exe, model, espeakData };
  }

  if (process.platform === 'darwin') {
    const exe = path.join(binDir, 'sherpa-onnx-offline-tts');
    const tokens = path.join(voiceDir, 'tokens.txt');
    const espeakData = path.join(voiceDir, 'espeak-ng-data');
    if (!fs.existsSync(exe) || !fs.existsSync(tokens) || !fs.existsSync(espeakData)) return null;
    return { engine: 'sherpa', exe, model, tokens, espeakData };
  }

  return null; // Linux et al. use the OS voice.
}

/** True when the offline neural voice can be used on this machine. */
export function piperAvailable(): boolean {
  return piperResources() !== null;
}

/**
 * Electron-free synthesis core for Piper (kept pure so it's directly testable):
 * spawn the piper binary, feed it `text` on stdin, and resolve with the WAV
 * bytes it writes to stdout — or null on failure/timeout. Logs go to stderr and
 * are ignored, so stdout is a clean WAV.
 */
export function synthesizeWithPiper(
  res: PiperResources,
  text: string,
): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const clean = (text || '').trim();
    if (!clean) return resolve(null);

    let child;
    try {
      child = spawn(
        res.exe,
        [
          '-m', res.model,
          '--espeak_data', res.espeakData,
          '--length_scale', LENGTH_SCALE,
          '--sentence_silence', SENTENCE_SILENCE,
          '-f', '-',
        ],
        { cwd: path.dirname(res.exe), stdio: ['pipe', 'pipe', 'ignore'] },
      );
    } catch {
      return resolve(null);
    }

    const chunks: Buffer[] = [];
    let settled = false;
    const done = (value: Buffer | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      resolve(value);
    };

    const timer = setTimeout(() => done(null), SYNTH_TIMEOUT_MS);

    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.on('error', () => done(null));
    child.on('close', (code) => {
      if (settled) return;
      const out = Buffer.concat(chunks);
      // A valid WAV starts with "RIFF"; guard against an empty/failed run.
      done(code === 0 && out.length > 44 && out.subarray(0, 4).toString('ascii') === 'RIFF' ? out : null);
    });

    try {
      child.stdin.end(clean);
    } catch {
      done(null);
    }
  });
}

/**
 * Electron-free synthesis core for sherpa-onnx (macOS), same pure/testable
 * shape as synthesizeWithPiper. sherpa has no stdout mode, so it synthesizes to
 * a unique temp WAV which we read back and delete. The engine's onnxruntime
 * dylib sits beside the binary and is found via the binary's @loader_path
 * rpath, so no DYLD_* env is needed. Resolves with the WAV bytes, or null.
 */
export function synthesizeWithSherpa(
  res: SherpaResources,
  text: string,
): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const clean = (text || '').trim();
    if (!clean) return resolve(null);

    const outPath = path.join(os.tmpdir(), `rocky-tts-${process.pid}-${Date.now()}.wav`);

    let child;
    try {
      child = spawn(
        res.exe,
        [
          `--vits-model=${res.model}`,
          `--vits-tokens=${res.tokens}`,
          `--vits-data-dir=${res.espeakData}`,
          `--vits-length-scale=${LENGTH_SCALE}`,
          '--num-threads=2',
          `--output-filename=${outPath}`,
          clean,
        ],
        { cwd: path.dirname(res.exe), stdio: 'ignore' },
      );
    } catch {
      return resolve(null);
    }

    let settled = false;
    const done = (value: Buffer | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      fs.rm(outPath, { force: true }, () => {}); // best-effort cleanup
      resolve(value);
    };

    const timer = setTimeout(() => done(null), SYNTH_TIMEOUT_MS);

    child.on('error', () => done(null));
    child.on('close', (code) => {
      if (settled) return;
      let out: Buffer | null = null;
      try {
        if (code === 0) {
          const buf = fs.readFileSync(outPath);
          // A valid WAV starts with "RIFF"; guard against an empty/failed run.
          if (buf.length > 44 && buf.subarray(0, 4).toString('ascii') === 'RIFF') out = buf;
        }
      } catch {
        out = null;
      }
      done(out);
    });
  });
}

/**
 * Synthesize a line with the bundled neural voice. Returns a single-segment
 * TtsSegment[] (so it plays through the shared SpokenVoice path), or null when
 * the engine is unavailable or synthesis fails — callers then fall back
 * gracefully to the OS voice.
 */
export async function synthesizePiper(text: string): Promise<TtsSegment[] | null> {
  const res = piperResources();
  if (!res) return null;
  const wav =
    res.engine === 'sherpa'
      ? await synthesizeWithSherpa(res, text)
      : await synthesizeWithPiper(res, text);
  if (!wav) return null;
  return [{ base64: wav.toString('base64'), mime: 'audio/wav', gapMsAfter: 0 }];
}
