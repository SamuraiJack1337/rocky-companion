// Resolving the whisper.cpp CLI to an absolute executable path, on every
// platform. Deliberately electron-free so tests can exercise it directly
// (same pattern as the offline TTS synth core).
//
// Why this is not just a PATH walk: a GUI app launched from Finder does not
// inherit a shell PATH (macOS), and on Windows a PATH edited in the cmd
// session that installed whisper.cpp is not visible to an already-running
// desktop session. On top of that, Node's fs never applies PATHEXT — cmd
// finds `whisper-cli.exe` for a bare `whisper-cli`, fs.accessSync does not.

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Injection points so tests can simulate win32 resolution from any OS. */
export interface ResolveWhisperOptions {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
}

function isExecutable(p: string): boolean {
  try {
    // On Windows X_OK degrades to an existence check, which is what we want.
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** On win32, expand a bare or extensionless name with PATHEXT candidates. */
function withExtensions(name: string, win: boolean, env: ResolveWhisperOptions['env']): string[] {
  if (!win) return [name];
  const exts = (env?.PATHEXT || '.EXE;.CMD;.BAT')
    .split(';')
    .filter(Boolean)
    .map((e) => e.toLowerCase());
  const lower = name.toLowerCase();
  if (exts.some((e) => lower.endsWith(e))) return [name];
  return [name, ...exts.map((e) => name + e)];
}

/**
 * Resolve the configured whisper CLI (bare name or explicit path) to an
 * absolute executable path, or null when nothing usable is found.
 */
export function resolveWhisperCli(
  configured: string,
  opts: ResolveWhisperOptions = {},
): string | null {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const win = platform === 'win32';
  const trimmed = (configured || '').trim();
  if (!trimmed) return null;

  // Either separator style marks an explicit path — Windows users paste
  // forward-slash paths too, so do not test path.sep alone.
  if (trimmed.includes('/') || trimmed.includes('\\')) {
    for (const candidate of withExtensions(trimmed, win, env)) {
      if (isExecutable(candidate)) return candidate;
    }
    return null;
  }

  // Bare name: walk PATH, then per-platform conventional install locations.
  const delimiter = win ? ';' : ':';
  const pathDirs = (env.PATH ?? '').split(delimiter).filter(Boolean);
  const extraDirs = win
    ? [
        env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links'),
        'C:\\ProgramData\\chocolatey\\bin',
        env.USERPROFILE && path.join(env.USERPROFILE, 'scoop', 'shims'),
      ].filter((d): d is string => Boolean(d))
    : ['/opt/homebrew/bin', '/usr/local/bin'];
  // Dirs where finding an executable strongly implies whisper.cpp — here we
  // also accept `main`, the binary name in older whisper.cpp Windows zips.
  const whisperDirs = win
    ? ['C:\\whisper', env.ProgramFiles && path.join(env.ProgramFiles, 'whisper.cpp')].filter(
        (d): d is string => Boolean(d),
      )
    : [];

  for (const dir of [...pathDirs, ...extraDirs]) {
    for (const candidate of withExtensions(path.join(dir, trimmed), win, env)) {
      if (isExecutable(candidate)) return candidate;
    }
  }
  for (const dir of whisperDirs) {
    for (const name of [trimmed, 'main']) {
      for (const candidate of withExtensions(path.join(dir, name), win, env)) {
        if (isExecutable(candidate)) return candidate;
      }
    }
  }
  return null;
}

/** Platform-appropriate "not found" guidance, shared by probe + Settings. */
export function whisperNotFoundHint(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    return (
      'whisper-cli.exe was not found. Download the whisper.cpp Windows release ' +
      '(whisper-bin-x64.zip), extract it, and set the full path to whisper-cli.exe.'
    );
  }
  if (platform === 'darwin') {
    return 'whisper-cli was not found. Install it (brew install whisper-cpp) or set its full path.';
  }
  return 'whisper-cli was not found. Install whisper.cpp or set the full path to its CLI.';
}
