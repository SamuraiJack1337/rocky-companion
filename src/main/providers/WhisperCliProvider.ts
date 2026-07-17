// The private, on-device speech-to-text backend: whisper.cpp's CLI
// (`brew install whisper-cpp` provides `whisper-cli`), user-installed exactly
// like Ollama is for vision. Nothing leaves the machine.
//
// Privacy note: whisper-cli reads audio from a FILE, so the captured WAV is
// written briefly to an owner-only (0600) temp file inside userData and
// deleted in a finally block — this is the only moment note audio touches
// disk, and it is documented in the README. The transcript itself is returned
// in memory.

import { app } from 'electron';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ProviderKind, TranscriptionResult } from '../../shared/types';
import type { ProviderReadiness } from './VisionProvider';
import type { SpeechProvider } from './SpeechProvider';

/** Generous cap — local transcription of a few minutes of speech can be slow. */
const TRANSCRIBE_TIMEOUT_MS = 180_000;

const NOT_FOUND_ERROR =
  'Rocky cannot find the local ears (whisper-cli). Check the path in Settings, {name}.';
const NO_MODEL_ERROR =
  'Rocky needs a Whisper model file. Point Settings at a ggml model, {name}.';
const FAILED_ERROR = 'Rocky heard, but the local translation failed, {name}.';

/**
 * Resolve the CLI to an absolute executable path. A bare command name is
 * searched on PATH plus the common Homebrew locations, because a GUI app
 * launched from Finder does not inherit a shell PATH.
 */
export function resolveWhisperCli(configured: string): string | null {
  const trimmed = (configured || '').trim();
  if (!trimmed) return null;
  const isExecutable = (p: string): boolean => {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  };
  if (trimmed.includes(path.sep)) {
    return isExecutable(trimmed) ? trimmed : null;
  }
  const dirs = [
    ...(process.env.PATH ?? '').split(path.delimiter),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ].filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, trimmed);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

/** Readiness of the local whisper.cpp setup, reused by the Settings probe. */
export function probeWhisperCli(cliPath: string, modelPath: string): ProviderReadiness {
  if (!resolveWhisperCli(cliPath)) {
    return {
      ok: false,
      error:
        'whisper-cli was not found. Install it (brew install whisper-cpp) or set its full path.',
    };
  }
  const model = (modelPath || '').trim();
  if (!model) {
    return { ok: false, error: 'No Whisper model file set. Download a ggml model and set its path.' };
  }
  try {
    if (!fs.statSync(model).isFile()) throw new Error('not a file');
  } catch {
    return { ok: false, error: 'The Whisper model file was not found at that path.' };
  }
  return { ok: true };
}

let tempCounter = 0;

export class WhisperCliProvider implements SpeechProvider {
  readonly kind: ProviderKind = 'local';
  private readonly cliPath: string;
  private readonly modelPath: string;

  constructor(cliPath: string, modelPath: string) {
    this.cliPath = cliPath;
    this.modelPath = (modelPath || '').trim();
  }

  async transcribe(wavBase64: string): Promise<TranscriptionResult> {
    const cli = resolveWhisperCli(this.cliPath);
    if (!cli) return { ok: false, error: NOT_FOUND_ERROR };
    const readiness = probeWhisperCli(this.cliPath, this.modelPath);
    if (!readiness.ok) {
      return { ok: false, error: this.modelPath ? NOT_FOUND_ERROR : NO_MODEL_ERROR };
    }

    // Owner-only temp file inside userData; removed in finally. See file header.
    const tempPath = path.join(
      app.getPath('userData'),
      `stt-${process.pid}-${++tempCounter}.wav`,
    );
    try {
      fs.writeFileSync(tempPath, Buffer.from(wavBase64, 'base64'), { mode: 0o600 });
      const text = await this.run(cli, tempPath);
      return { ok: true, text };
    } catch {
      return { ok: false, error: FAILED_ERROR };
    } finally {
      try {
        fs.rmSync(tempPath, { force: true });
      } catch {
        /* best effort */
      }
    }
  }

  /** Run whisper-cli and collect the bare transcript from stdout. */
  private run(cli: string, wavPath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        cli,
        // -np: no debug prints; -nt: no timestamps → stdout is just the words.
        ['-m', this.modelPath, '-f', wavPath, '-np', '-nt'],
        { timeout: TRANSCRIBE_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout) => {
          if (error) {
            // Never include stderr/stdout in the error — keep failures generic.
            reject(new Error('whisper-cli failed'));
            return;
          }
          resolve(stdout.replace(/\s+/g, ' ').trim());
        },
      );
    });
  }

  async ready(): Promise<ProviderReadiness> {
    return probeWhisperCli(this.cliPath, this.modelPath);
  }
}
