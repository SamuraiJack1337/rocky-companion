// Offline neural spoken voice (main process). A fully-offline neural TTS is
// bundled with the app so Rocky has a natural spoken voice with NO API key —
// the right fit for the local / Ollama path, and far better than the OS
// speech engine.
//
// One engine, one voice, both platforms: sherpa-onnx (Apache-2.0) running the
// Kokoro (Apache-2.0) English voice model — macOS ships the universal2 CLI,
// Windows the x64 MT build, and both read the SAME model files, so Rocky
// sounds identical across platforms. (This replaced the old Piper-on-Windows
// path, whose WAV-over-stdout transport corrupted audio into static; sherpa
// always writes to a temp file we read back.) On any other platform this
// returns null and the renderer falls back to the OS voice.
//
// The WAV bytes are handed to the renderer as TtsSegments (base64), flowing
// through the exact same playback path (pitch, glow pulses, inter-segment
// gaps) as the OpenAI voice. When expressive cadence is on, a line is split
// into phrases synthesized one by one — sequentially on purpose, since each
// CLI spawn reloads the model. Only Rocky's short generated line is ever
// passed in; nothing touches the network.

import { spawn } from 'child_process';
import { app } from 'electron';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { TtsSegment } from '../shared/ipc';
import { splitPhrases, shapePhrase } from './cadence';

/** Rocky's base pace. Kokoro's natural pacing needs no ryan-era 1.05 stretch. */
const BASE_LENGTH_SCALE = 1.0;
/** Kokoro speaker id: am_michael — warm American male, Rocky's register. */
export const DEFAULT_SPEAKER = 6;
/** Hard cap so a wedged process can never hang the voice. */
const SYNTH_TIMEOUT_MS = 15_000;

/** sherpa-onnx + Kokoro assets: CLI, model, speaker bank, phonemizer data. */
export interface KokoroResources {
  exe: string;
  model: string;
  voices: string;
  tokens: string;
  espeakData: string;
}

/** Per-call synthesis knobs (resolved from settings by the IPC layer). */
export interface OfflineSynthOptions {
  /** Kokoro speaker id (row in voices.bin). Defaults to DEFAULT_SPEAKER. */
  sid?: number;
  /** Cloud-style expressive cadence: phrase splitting + per-phrase pacing. */
  cadence?: boolean;
}

/**
 * Root of the bundled engine assets. Packaged (both platforms): the engine
 * lands at <resources>/piper with the voice under <resources>/piper/voice (the
 * folder name is historical — keeping it avoids touching the signing hook and
 * keeps updates drop-in; see electron-builder.yml extraResources). In dev the
 * files live under vendor/, laid out by scripts/fetch-piper.mjs.
 */
function engineRoot(): { binDir: string; voiceDir: string } {
  if (app.isPackaged) {
    const base = path.join(process.resourcesPath, 'piper');
    return { binDir: base, voiceDir: path.join(base, 'voice') };
  }
  const vendor = path.join(app.getAppPath(), 'vendor');
  const sub = process.platform === 'darwin' ? 'mac' : 'win';
  return {
    binDir: path.join(vendor, 'sherpa', sub),
    voiceDir: path.join(vendor, 'voice-kokoro'),
  };
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
export function offlineTtsResources(): KokoroResources | null {
  if (process.platform !== 'darwin' && process.platform !== 'win32') {
    return null; // Linux et al. use the OS voice.
  }
  const { binDir, voiceDir } = engineRoot();
  const model = findModel(voiceDir);
  if (!model) return null;
  const exe = path.join(
    binDir,
    process.platform === 'win32' ? 'sherpa-onnx-offline-tts.exe' : 'sherpa-onnx-offline-tts',
  );
  const voices = path.join(voiceDir, 'voices.bin');
  const tokens = path.join(voiceDir, 'tokens.txt');
  const espeakData = path.join(voiceDir, 'espeak-ng-data');
  if (![exe, voices, tokens, espeakData].every((p) => fs.existsSync(p))) return null;
  return { exe, model, voices, tokens, espeakData };
}

/** True when the offline neural voice can be used on this machine. */
export function offlineTtsAvailable(): boolean {
  return offlineTtsResources() !== null;
}

/**
 * Sanity-check that a buffer is a playable WAV, beyond the old 4-byte RIFF
 * peek (which happily passed body-corrupted audio through as static): RIFF +
 * WAVE magics, a plausible RIFF size, an `fmt ` chunk with a sane sample rate,
 * and a non-empty `data` chunk. Pure, exported for tests.
 */
export function isPlausibleWav(buf: Buffer): boolean {
  if (buf.length <= 44) return false;
  if (buf.toString('ascii', 0, 4) !== 'RIFF') return false;
  if (buf.toString('ascii', 8, 12) !== 'WAVE') return false;
  const riffSize = buf.readUInt32LE(4);
  // The size field should roughly cover the file (tolerate trailing slack).
  if (riffSize < 36 || riffSize > buf.length) return false;

  let sampleRate = 0;
  let dataBytes = 0;
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ' && off + 16 <= buf.length) {
      sampleRate = buf.readUInt32LE(off + 12); // fmt data: fmt(2) ch(2) rate(4)
    } else if (id === 'data') {
      dataBytes = Math.min(size, buf.length - off - 8);
    }
    off += 8 + size + (size % 2); // chunks are word-aligned
  }
  return sampleRate >= 8000 && sampleRate <= 48000 && dataBytes > 0;
}

/**
 * Electron-free synthesis core (kept pure so it's directly testable): spawn
 * the sherpa-onnx CLI with the Kokoro model. sherpa has no stdout mode, so it
 * synthesizes to a unique temp WAV which we read back and delete — which also
 * sidesteps the binary-over-stdout corruption the old Windows Piper path had.
 * The engine's onnxruntime dylib/DLLs sit beside the binary (found via
 * @loader_path on mac, sibling lookup on win), so no env vars are needed.
 * Resolves with the WAV bytes, or null on failure/timeout.
 */
export function synthesizeWithKokoro(
  res: KokoroResources,
  text: string,
  opts: { sid?: number; lengthScale?: number } = {},
): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const clean = (text || '').trim();
    if (!clean) return resolve(null);

    const sid = opts.sid ?? DEFAULT_SPEAKER;
    const lengthScale = opts.lengthScale ?? BASE_LENGTH_SCALE;
    const outPath = path.join(os.tmpdir(), `rocky-tts-${process.pid}-${Date.now()}.wav`);

    let child;
    try {
      child = spawn(
        res.exe,
        [
          `--kokoro-model=${res.model}`,
          `--kokoro-voices=${res.voices}`,
          `--kokoro-tokens=${res.tokens}`,
          `--kokoro-data-dir=${res.espeakData}`,
          `--kokoro-length-scale=${lengthScale.toFixed(2)}`,
          `--sid=${sid}`,
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
          if (isPlausibleWav(buf)) out = buf;
        }
      } catch {
        out = null;
      }
      done(out);
    });
  });
}

/**
 * Synthesize a line with the bundled neural voice. With cadence on, the line
 * becomes one segment per phrase (the renderer honors the gaps, matching the
 * cloud voice's delivery); otherwise a single segment. Returns null when the
 * engine is unavailable or synthesis fails — callers then fall back gracefully
 * to the OS voice.
 */
export async function synthesizeOffline(
  text: string,
  opts: OfflineSynthOptions = {},
): Promise<TtsSegment[] | null> {
  const res = offlineTtsResources();
  if (!res) return null;
  const clean = (text || '').trim();
  if (!clean) return null;

  const phrases = opts.cadence ? splitPhrases(clean) : [clean];
  const segments: TtsSegment[] = [];
  // Sequential on purpose: each spawn reloads the model, so parallel phrase
  // synthesis would spike memory/CPU without helping playback (also serial).
  for (let i = 0; i < phrases.length; i++) {
    const { speed, gapMsAfter } = opts.cadence
      ? shapePhrase(phrases[i], i === phrases.length - 1)
      : { speed: 1.0, gapMsAfter: 0 };
    // Cloud `speed` maps inversely onto Kokoro's length-scale.
    const wav = await synthesizeWithKokoro(res, phrases[i], {
      sid: opts.sid,
      lengthScale: BASE_LENGTH_SCALE / speed,
    });
    if (!wav) return null;
    segments.push({ base64: wav.toString('base64'), mime: 'audio/wav', gapMsAfter });
  }
  return segments;
}
