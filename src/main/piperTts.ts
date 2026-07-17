// Offline neural spoken voice via Piper (main process). Piper is a small,
// fast, fully-offline neural TTS (MIT-licensed) bundled with the app; it gives
// Rocky a natural spoken voice with NO API key — the right fit for the local /
// Ollama path, and far better than the OS speech engine.
//
// Currently shipped on WINDOWS only. The upstream macOS binaries are broken
// (x86_64 under an "aarch64" label, mispackaged dylibs), so on macOS this
// returns null and the renderer falls back to the OS voice; a robust macOS
// engine (sherpa-onnx) is a planned follow-up.
//
// The engine writes a WAV to stdout (`-f -`); we hand those bytes to the
// renderer as a single TtsSegment (base64), so Piper audio flows through the
// exact same playback path (pitch, glow pulses) as the OpenAI voice. Only
// Rocky's short generated line is ever passed in; nothing touches the network.

import { spawn } from 'child_process';
import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import type { TtsSegment } from '../shared/ipc';

/** Rocky's delivery tuning. Slightly deliberate; a beat between sentences. */
const LENGTH_SCALE = '1.05';
const SENTENCE_SILENCE = '0.3';
/** Hard cap so a wedged process can never hang the voice. */
const SYNTH_TIMEOUT_MS = 15_000;

export interface PiperResources {
  exe: string;
  model: string;
  espeakData: string;
}

/** Root of the bundled piper assets: <resources>/piper packaged, vendor/ in dev. */
function piperRoot(): { binDir: string; voiceDir: string } {
  if (app.isPackaged) {
    const base = path.join(process.resourcesPath, 'piper');
    return { binDir: base, voiceDir: path.join(base, 'voice') };
  }
  const base = path.join(app.getAppPath(), 'vendor');
  return { binDir: path.join(base, 'piper', 'win'), voiceDir: path.join(base, 'voices') };
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
 * Resolve the bundled piper executable, voice model, and espeak data — or null
 * when Piper isn't available on this platform/build (macOS, or assets absent),
 * in which case callers fall back to the OS voice.
 */
export function piperResources(): PiperResources | null {
  if (process.platform !== 'win32') return null; // shipped on Windows only for now
  const { binDir, voiceDir } = piperRoot();
  const exe = path.join(binDir, 'piper.exe');
  const espeakData = path.join(binDir, 'espeak-ng-data');
  const model = findModel(voiceDir);
  if (!model || !fs.existsSync(exe) || !fs.existsSync(espeakData)) return null;
  return { exe, model, espeakData };
}

/** True when the offline neural voice can be used on this machine. */
export function piperAvailable(): boolean {
  return piperResources() !== null;
}

/**
 * Electron-free synthesis core (kept pure so it's directly testable): spawn the
 * piper binary, feed it `text` on stdin, and resolve with the WAV bytes it
 * writes to stdout — or null on failure/timeout. Logs go to stderr and are
 * ignored, so stdout is a clean WAV.
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
 * Synthesize a line with the bundled neural voice. Returns a single-segment
 * TtsSegment[] (so it plays through the shared SpokenVoice path), or null when
 * Piper is unavailable or synthesis fails — callers then fall back gracefully.
 */
export async function synthesizePiper(text: string): Promise<TtsSegment[] | null> {
  const res = piperResources();
  if (!res) return null;
  const wav = await synthesizeWithPiper(res, text);
  if (!wav) return null;
  return [{ base64: wav.toString('base64'), mime: 'audio/wav', gapMsAfter: 0 }];
}
