import assert from 'node:assert/strict';
import test from 'node:test';
import { compareVersions, UpdateChecker } from '../src/main/updates';
import type { Settings } from '../src/shared/types';
import { DEFAULT_SETTINGS } from '../src/shared/types';

test('compareVersions orders plain and prerelease versions', () => {
  assert.equal(compareVersions('0.1.0', '0.2.0'), -1);
  assert.equal(compareVersions('v1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(compareVersions('1.0.0-beta', '1.0.0'), -1);
  assert.equal(compareVersions('0.2', '0.2.0'), 0);
});

interface Harness {
  checker: UpdateChecker;
  notifications: Array<{ version: string; url: string }>;
  settings: Settings;
}

function makeHarness(release: unknown, current = '0.1.0'): Harness {
  const h: Harness = { checker: null as unknown as UpdateChecker, notifications: [], settings: { ...DEFAULT_SETTINGS } };
  h.checker = new UpdateChecker({
    currentVersion: current,
    getSettings: () => ({ ...h.settings }),
    applySettings: (patch) => {
      h.settings = { ...h.settings, ...patch };
      return { ...h.settings };
    },
    notify: (info) => h.notifications.push(info),
    fetchJson: async () => release,
  });
  return h;
}

const RELEASE = {
  tag_name: 'v0.2.0',
  html_url: 'https://github.com/owner/repo/releases/tag/v0.2.0',
  assets: [
    { name: 'RockyCompanion-0.2.0-mac.dmg', browser_download_url: 'https://github.com/owner/repo/releases/download/v0.2.0/RockyCompanion-0.2.0-mac.dmg' },
  ],
};

test('a newer release notifies once with the dmg url', async () => {
  const h = makeHarness(RELEASE);
  const info = await h.checker.checkNow(true);
  assert.equal(info?.version, '0.2.0');
  assert.ok(info?.url.endsWith('.dmg'));
  assert.equal(h.notifications.length, 1);
  // Second check in the same launch: still pending, but no second prompt.
  await h.checker.checkNow(true);
  assert.equal(h.notifications.length, 1);
});

test('the current or older version never prompts', async () => {
  const h = makeHarness(RELEASE, '0.2.0');
  assert.equal(await h.checker.checkNow(true), null);
  assert.equal(h.notifications.length, 0);
});

test('a dismissed version never prompts again', async () => {
  const h = makeHarness(RELEASE);
  h.settings.dismissedUpdateVersion = '0.2.0';
  assert.equal(await h.checker.checkNow(true), null);
});

test('checks are rate limited unless forced', async () => {
  const h = makeHarness(RELEASE);
  h.settings.lastUpdateCheckAt = new Date().toISOString();
  assert.equal(await h.checker.checkNow(false), null);
  assert.notEqual(await h.checker.checkNow(true), null);
});

test('the opt-out disables checking entirely', async () => {
  const h = makeHarness(RELEASE);
  h.settings.updateCheckEnabled = false;
  assert.equal(await h.checker.checkNow(true), null);
});

test('non-GitHub URLs are discarded', async () => {
  const h = makeHarness({
    tag_name: 'v9.9.9',
    html_url: 'https://evil.example.com/download',
    assets: [{ name: 'x.dmg', browser_download_url: 'https://evil.example.com/x.dmg' }],
  });
  assert.equal(await h.checker.checkNow(true), null);
  assert.equal(h.notifications.length, 0);
});
