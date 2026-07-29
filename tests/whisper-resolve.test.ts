import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { resolveWhisperCli, whisperNotFoundHint } from '../src/main/providers/whisperResolve';

// The resolver is electron-free and takes {platform, env} injection points,
// so win32 behavior (PATHEXT expansion, ';' PATH delimiter, main.exe
// fallback) is exercised with real temp files from any CI OS.

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-resolve-'));
}

function touchExe(dir: string, name: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, '#!/bin/sh\n', { mode: 0o755 });
  return p;
}

test('empty and whitespace input resolve to null', () => {
  assert.equal(resolveWhisperCli(''), null);
  assert.equal(resolveWhisperCli('   '), null);
});

// Simulating a POSIX PATH (':'-delimited) needs a colon-free filesystem path;
// on a Windows runner the temp dir is `C:\...`, whose drive-letter colon would
// (correctly) be split as a POSIX delimiter. Skip the darwin-on-disk positive
// case there — the win32 cases below cover Windows resolution directly.
const posixHostOnly =
  process.platform === 'win32'
    ? { skip: 'darwin PATH simulation needs a colon-free (POSIX) temp path' }
    : {};

test('bare name is found on PATH (posix)', posixHostOnly, () => {
  const dir = tempDir();
  const exe = touchExe(dir, 'whisper-cli');
  const found = resolveWhisperCli('whisper-cli', {
    platform: 'darwin',
    env: { PATH: dir },
  });
  assert.equal(found, exe);
});

test('explicit path that does not exist resolves to null', () => {
  assert.equal(
    resolveWhisperCli('/nonexistent/whisper-cli', { platform: 'darwin', env: { PATH: '' } }),
    null,
  );
});

test('win32: bare name resolves to the .exe via PATHEXT', () => {
  const dir = tempDir();
  const exe = touchExe(dir, 'whisper-cli.exe');
  const found = resolveWhisperCli('whisper-cli', {
    platform: 'win32',
    env: { PATH: dir, PATHEXT: '.COM;.EXE;.BAT' },
  });
  assert.equal(found, exe);
});

test('win32: PATHEXT default kicks in when the env var is unset', () => {
  const dir = tempDir();
  const exe = touchExe(dir, 'whisper-cli.exe');
  const found = resolveWhisperCli('whisper-cli', {
    platform: 'win32',
    env: { PATH: dir },
  });
  assert.equal(found, exe);
});

test('win32: PATH entries are split on ";"', () => {
  const a = tempDir();
  const b = tempDir();
  const exe = touchExe(b, 'whisper-cli.exe');
  const found = resolveWhisperCli('whisper-cli', {
    platform: 'win32',
    env: { PATH: `${a};${b}` },
  });
  assert.equal(found, exe);
});

test('win32: forward-slash explicit path is treated as a path, with .exe expansion', () => {
  const dir = tempDir();
  const exe = touchExe(dir, 'whisper-cli.exe');
  // User typed the path without the extension, using forward slashes.
  const typed = `${dir.replace(/\\/g, '/')}/whisper-cli`;
  const found = resolveWhisperCli(typed, { platform: 'win32', env: { PATH: '' } });
  assert.equal(found, `${typed}.exe`);
  // With the extension typed out it resolves as-is.
  assert.equal(
    resolveWhisperCli(exe, { platform: 'win32', env: { PATH: '' } }),
    exe,
  );
});

test('win32: name that already has a PATHEXT extension is not double-expanded', () => {
  const dir = tempDir();
  const exe = touchExe(dir, 'whisper-cli.exe');
  const found = resolveWhisperCli('whisper-cli.exe', {
    platform: 'win32',
    env: { PATH: dir },
  });
  assert.equal(found, exe);
});

test('win32: main.exe fallback applies only in whisper-specific dirs', () => {
  const pathDir = tempDir();
  touchExe(pathDir, 'main.exe'); // an unrelated main.exe on PATH must NOT match
  const found = resolveWhisperCli('whisper-cli', {
    platform: 'win32',
    env: { PATH: pathDir },
  });
  assert.equal(found, null);

  // %ProgramFiles%\whisper.cpp is the convention — main.exe there DOES match.
  const programFiles = tempDir();
  const conventional = path.join(programFiles, 'whisper.cpp');
  fs.mkdirSync(conventional, { recursive: true });
  const wanted = touchExe(conventional, 'main.exe');
  const found2 = resolveWhisperCli('whisper-cli', {
    platform: 'win32',
    env: { PATH: pathDir, ProgramFiles: programFiles },
  });
  assert.equal(found2, wanted);
});

test('win32: scoop/winget/chocolatey style extra dirs are searched', () => {
  const home = tempDir();
  const shims = path.join(home, 'scoop', 'shims');
  fs.mkdirSync(shims, { recursive: true });
  const exe = touchExe(shims, 'whisper-cli.exe');
  const found = resolveWhisperCli('whisper-cli', {
    platform: 'win32',
    env: { PATH: '', USERPROFILE: home },
  });
  assert.equal(found, exe);
});

test('darwin: homebrew fallback dirs still apply for bare names', () => {
  // Cannot create files in /opt/homebrew from tests; assert via PATH-miss
  // returning null (behavior unchanged) rather than a positive hit.
  const found = resolveWhisperCli('definitely-not-a-real-binary-name', {
    platform: 'darwin',
    env: { PATH: tempDir() },
  });
  assert.equal(found, null);
});

test('not-found hint is platform-appropriate', () => {
  assert.match(whisperNotFoundHint('darwin'), /brew install whisper-cpp/);
  assert.match(whisperNotFoundHint('win32'), /whisper-bin-x64\.zip/);
  assert.match(whisperNotFoundHint('linux'), /whisper\.cpp/);
});
