import assert from 'node:assert/strict';
import test from 'node:test';
import { ResearchController } from '../src/main/research';
import type { ResearchDeps } from '../src/main/research';
import { DEFAULT_SETTINGS } from '../src/shared/types';
import type { Settings } from '../src/shared/types';

function localWebSettings(): Settings {
  return {
    ...DEFAULT_SETTINGS,
    provider: 'local',
    webSearchEnabled: true,
    webSearchConsentGiven: true,
    callName: 'buddy',
  };
}

function fakeDeps(over: Partial<ResearchDeps> = {}): ResearchDeps {
  return {
    callModel: async (system) => {
      if (system.includes('plan web research') || system.includes('JSON array of 3 to 5'))
        return { text: '["alpha basics","alpha pitfalls"]', sources: [] };
      return { text: 'Rocky reports: alpha is solid. Good, good, good.', sources: [] };
    },
    searchWeb: async () => [
      { title: 'Alpha Docs', url: 'https://example.com/alpha', snippet: 's' },
    ],
    fetchPage: async (url) => ({ url, title: 'Alpha Docs', text: 'Alpha is a thing.' }),
    ...over,
  };
}

test('local research plans, reads, and synthesizes a cited report', async () => {
  const progress: string[] = [];
  const ctrl = new ResearchController(fakeDeps());
  const result = await ctrl.run('alpha', localWebSettings(), (l) => progress.push(l));
  assert.equal(result.ok, true);
  assert.ok(result.report?.includes('alpha is solid'));
  assert.ok((result.sources ?? []).some((s) => s.url === 'https://example.com/alpha'));
  assert.ok(progress.some((l) => l.includes('plans')));
  assert.ok(progress.some((l) => l.includes('reads')));
  assert.equal(ctrl.isRunning(), false);
});

test('research refuses without web access', async () => {
  const ctrl = new ResearchController(fakeDeps());
  const result = await ctrl.run('alpha', { ...localWebSettings(), webSearchEnabled: false });
  assert.equal(result.ok, false);
  assert.ok(/web access/i.test(result.error ?? ''));
});

test('research reports nothing when no page can be read', async () => {
  const ctrl = new ResearchController(fakeDeps({ fetchPage: async () => null }));
  const result = await ctrl.run('alpha', localWebSettings());
  assert.equal(result.ok, false);
  assert.ok(/nothing/i.test(result.error ?? ''));
});

test('a second run is rejected while one is in flight', async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const ctrl = new ResearchController(
    fakeDeps({
      callModel: async (system) => {
        if (system.includes('JSON array')) return { text: '["q"]', sources: [] };
        await gate; // hold the synthesis call open
        return { text: 'done', sources: [] };
      },
    }),
  );
  const first = ctrl.run('alpha', localWebSettings());
  // Give the first run a tick to enter the running state.
  await new Promise((r) => setTimeout(r, 10));
  const second = await ctrl.run('beta', localWebSettings());
  assert.equal(second.ok, false);
  assert.ok(/already/i.test(second.error ?? ''));
  release();
  await first;
});
