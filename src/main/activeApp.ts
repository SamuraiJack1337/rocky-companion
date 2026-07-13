// Frontmost-app detection for macOS capture blocking. lsappinfo is a built-in
// LaunchServices utility and does not require Accessibility permission. Only
// the display name is retained; window titles and URLs are never requested.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function getFrontmostAppName(): Promise<string | null> {
  if (process.platform !== 'darwin') return null;
  try {
    const front = await execFileAsync('/usr/bin/lsappinfo', ['front'], { timeout: 1500 });
    const asn = front.stdout.trim();
    if (!asn.startsWith('ASN:')) return null;
    const info = await execFileAsync('/usr/bin/lsappinfo', ['info', '-only', 'name', asn], {
      timeout: 1500,
    });
    const match = info.stdout.match(/"LSDisplayName"="([^"]+)"/);
    return match?.[1]?.trim() || null;
  } catch {
    return null;
  }
}

export function isAppBlocked(appName: string | null, patterns: readonly string[]): boolean {
  if (!appName) return false;
  const name = appName.trim().toLocaleLowerCase();
  return patterns.some((raw) => {
    const pattern = raw.trim().toLocaleLowerCase();
    if (!pattern) return false;
    if (!pattern.includes('*')) return name === pattern;
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`, 'i').test(name);
  });
}
