// macOS Screen Recording permission helpers. Rocky needs Screen Recording
// access to capture the screen for the vision provider. On non-darwin platforms
// there is no such gate, so we report 'granted'. We only ever READ the status
// and deep-link the user to System Settings — we never auto-grant anything.

import { desktopCapturer, systemPreferences, shell } from 'electron';
import type { ScreenPermissionStatus } from '../shared/types';

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
    try {
      await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 1, height: 1 },
        fetchWindowIcons: false,
      });
    } catch {
      // Registration is best-effort; still take the user to the pane.
    }
  }
  await shell.openExternal(
    'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  );
}
