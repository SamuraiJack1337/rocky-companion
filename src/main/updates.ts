// Update check against GitHub Releases. No electron-updater / Squirrel — the
// app ships unsigned, so it cannot replace itself; instead Rocky offers the
// new DMG and the user drags it into Applications.
//
// Privacy: this is the app's only network call besides the user's chosen
// vision provider. It sends nothing beyond the HTTP request itself, runs at
// most ~once a day, and can be disabled in Settings (updateCheckEnabled).
//
// Electron-free by design (deps-injected, global fetch) so it is testable.

import type { Settings } from '../shared/types';

/** GitHub repo slug for releases. */
export const UPDATE_REPO = 'SamuraiJack1337/rocky-companion';

const RELEASES_LATEST_URL = `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`;
const FETCH_TIMEOUT_MS = 10_000;
/** Skip the check if the last one was under this old (~once a day, jittered by launch time). */
const CHECK_MIN_GAP_MS = 20 * 3_600_000;
/** First check waits until well after launch; then a daily timer. */
const FIRST_CHECK_DELAY_MS = 3 * 60_000;
const RECHECK_EVERY_MS = 24 * 3_600_000;

export interface UpdateInfo {
  version: string;
  /** Download page or DMG asset URL; always on https://github.com/. */
  url: string;
}

/** Compare dotted versions; any prerelease suffix sorts older. Returns a<b:-1, a=b:0, a>b:1. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const clean = v.trim().replace(/^v/i, '');
    const [core, pre] = clean.split(/[-+]/, 2);
    const nums = core.split('.').map((n) => Number.parseInt(n, 10) || 0);
    while (nums.length < 3) nums.push(0);
    return { nums, pre: pre ?? null };
  };
  const A = parse(a);
  const B = parse(b);
  for (let i = 0; i < 3; i++) {
    if (A.nums[i] !== B.nums[i]) return A.nums[i] < B.nums[i] ? -1 : 1;
  }
  if (A.pre && !B.pre) return -1;
  if (!A.pre && B.pre) return 1;
  return 0;
}

interface ReleaseAsset {
  name?: string;
  browser_download_url?: string;
}

interface LatestRelease {
  tag_name?: string;
  html_url?: string;
  assets?: ReleaseAsset[];
}

export interface UpdateCheckerDeps {
  currentVersion: string;
  getSettings: () => Settings;
  applySettings: (patch: Partial<Settings>) => Settings;
  /** Surface a newer version to the user (bubble + tray, wired in main.ts). */
  notify: (info: UpdateInfo) => void;
  /** Overridable fetch for tests. */
  fetchJson?: (url: string) => Promise<unknown>;
}

export class UpdateChecker {
  private pending: UpdateInfo | null = null;
  private notifiedThisLaunch = false;

  constructor(private readonly deps: UpdateCheckerDeps) {}

  /** Kick off the delayed first check and the daily re-check. Timers never hold the app open. */
  start(): void {
    const first = setTimeout(() => void this.checkNow(), FIRST_CHECK_DELAY_MS);
    first.unref?.();
    const daily = setInterval(() => void this.checkNow(), RECHECK_EVERY_MS);
    daily.unref?.();
  }

  /** The update currently on offer (drives the tray item), if any. */
  getPending(): UpdateInfo | null {
    return this.pending ? { ...this.pending } : null;
  }

  /** "Later": remember the version so this release never prompts again. */
  dismissPending(): void {
    if (!this.pending) return;
    this.deps.applySettings({ dismissedUpdateVersion: this.pending.version });
    this.pending = null;
  }

  async checkNow(force = false): Promise<UpdateInfo | null> {
    const settings = this.deps.getSettings();
    if (!settings.updateCheckEnabled) return null;
    if (!force && settings.lastUpdateCheckAt) {
      const last = Date.parse(settings.lastUpdateCheckAt);
      if (Number.isFinite(last) && Date.now() - last < CHECK_MIN_GAP_MS) return null;
    }
    this.deps.applySettings({ lastUpdateCheckAt: new Date().toISOString() });

    let release: LatestRelease;
    try {
      release = (await (this.deps.fetchJson ?? fetchGitHubJson)(RELEASES_LATEST_URL)) as LatestRelease;
    } catch {
      return null; // Offline or rate-limited — quietly try again next time.
    }

    const version = (release.tag_name ?? '').replace(/^v/i, '');
    if (!version || compareVersions(version, this.deps.currentVersion) <= 0) return null;
    if (settings.dismissedUpdateVersion === version) return null;

    const dmg = (release.assets ?? []).find(
      (a) => typeof a.browser_download_url === 'string' && (a.name ?? '').endsWith('.dmg'),
    );
    const url = dmg?.browser_download_url ?? release.html_url ?? '';
    // Only ever hand the OS a GitHub URL; anything else is discarded.
    if (!url.startsWith('https://github.com/')) return null;

    this.pending = { version, url };
    // Prompt at most once per launch; the tray item persists regardless.
    if (!this.notifiedThisLaunch) {
      this.notifiedThisLaunch = true;
      this.deps.notify(this.getPending()!);
    }
    return this.getPending();
  }
}

async function fetchGitHubJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`releases check failed: ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}
