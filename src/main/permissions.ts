// macOS permission helpers: Screen Recording (vision capture) and Microphone
// (push-to-talk voice notes). On non-darwin platforms there is no such gate,
// so we report 'granted'. We only ever READ the status, trigger the standard
// system prompt, or deep-link the user to System Settings — we never
// auto-grant anything.

import { app, desktopCapturer, systemPreferences, shell } from 'electron';
import { execFile } from 'node:child_process';
import type {
  MicPermissionStatus,
  ScreenPermissionResetResult,
  ScreenPermissionStatus,
} from '../shared/types';

/**
 * Current Screen Recording permission state.
 * - macOS: mirrors systemPreferences.getMediaAccessStatus('screen').
 * - other platforms: 'granted' (no equivalent restriction).
 * - any error: 'unknown'.
 */
export function getScreenPermission(): ScreenPermissionStatus {
  if (process.platform !== 'darwin') return 'granted';
  try {
    return systemPreferences.getMediaAccessStatus('screen') as ScreenPermissionStatus;
  } catch {
    return 'unknown';
  }
}

/** Convenience predicate: is screen capture allowed right now? */
export function isScreenGranted(): boolean {
  return getScreenPermission() === 'granted';
}

/** Current Microphone permission state (same vocabulary as screen). */
export function getMicPermission(): MicPermissionStatus {
  if (process.platform !== 'darwin') return 'granted';
  try {
    return systemPreferences.getMediaAccessStatus('microphone') as MicPermissionStatus;
  } catch {
    return 'unknown';
  }
}

/** Convenience predicate: is microphone capture allowed right now? */
export function isMicGranted(): boolean {
  return getMicPermission() === 'granted';
}

/**
 * Trigger the standard macOS microphone prompt when undetermined, then report
 * the resulting status. If access was previously denied, the prompt will not
 * reappear — the caller should point the user at System Settings instead.
 */
export async function requestMicPermission(): Promise<MicPermissionStatus> {
  if (process.platform !== 'darwin') return 'granted';
  try {
    await systemPreferences.askForMediaAccess('microphone');
  } catch {
    // Best-effort; fall through to a fresh status read.
  }
  return getMicPermission();
}

/** Deep-link the user to the Microphone privacy pane. */
export async function openMicSettings(): Promise<void> {
  await shell.openExternal(
    'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  );
}

/**
 * Make sure this binary shows up in the Screen Recording pane, then open it.
 *
 * macOS only lists an app there after it has actually attempted a capture, so
 * deep-linking alone can land the user on a pane with nothing to enable. A
 * tiny getSources() call registers us with TCC first (and, on the very first
 * attempt, triggers the system prompt). Note that in dev the entry appears as
 * "Electron" — permission is tied to the running binary, not the app name.
 */
export async function openScreenSettings(): Promise<void> {
  if (process.platform === 'darwin' && !isScreenGranted()) {
    await registerWithTcc();
  }
  await shell.openExternal(
    'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  );
}

/** A tiny getSources() call that registers this binary with TCC (best-effort). */
async function registerWithTcc(): Promise<void> {
  try {
    await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1, height: 1 },
      fetchWindowIcons: false,
    });
  } catch {
    // Registration is best-effort; callers proceed either way.
  }
}

/**
 * Clear this app's (possibly stale) Screen Recording grant and start a fresh
 * one — the in-app equivalent of `tccutil reset ScreenCapture <bundle-id>`.
 *
 * Why this exists: the app ships ad-hoc signed, so its code-signing identity
 * (cdhash) changes with every update. TCC keys the grant on that identity, so
 * after an update the old grant row no longer matches the running binary —
 * System Settings shows the toggle ON while captures come back denied/black.
 * Resetting removes the stale row; the user then re-grants once.
 *
 * tccutil talks to the user's own TCC records and needs no sudo. On MDM-managed
 * machines a system-level row can survive the reset — we surface the failure so
 * the UI can fall back to manual instructions. The running process keeps its
 * old TCC verdict either way, so the flow must end in an app relaunch.
 */
export async function resetScreenPermission(): Promise<ScreenPermissionResetResult> {
  if (process.platform !== 'darwin') {
    return { ok: false, error: 'Screen permission reset is only needed on macOS.' };
  }
  // Dev runs are registered under the Electron helper's identity, not our
  // appId (electron-builder.yml). Resetting com.github.Electron also clears
  // the grant for other Electron dev apps on this machine — acceptable in dev.
  const bundleId = app.isPackaged ? 'com.rockycompanion.app' : 'com.github.Electron';
  const reset = await new Promise<ScreenPermissionResetResult>((resolve) => {
    execFile(
      '/usr/bin/tccutil',
      ['reset', 'ScreenCapture', bundleId],
      { timeout: 10_000 },
      (error, _stdout, stderr) => {
        if (error) {
          const detail = (stderr || error.message || '').trim().slice(0, 200);
          resolve({ ok: false, error: detail || 'tccutil failed' });
        } else {
          resolve({ ok: true });
        }
      },
    );
  });
  if (!reset.ok) return reset;
  // Fresh registration so the pane immediately lists us again, then take the
  // user straight there to flip the toggle.
  await registerWithTcc();
  await shell.openExternal(
    'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  );
  return { ok: true };
}
