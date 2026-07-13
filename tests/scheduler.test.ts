// Scheduler behavior: the privacy-critical ordering and suppression rules.
// The scheduler is Electron-free by design (everything arrives via deps), so
// these tests drive the real class with fakes and assert on observable calls.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Scheduler } from '../src/main/scheduler';
import type { SchedulerDeps } from '../src/main/scheduler';
import type { RockyReply, ScreenObservation, Settings } from '../src/shared/types';
import { DEFAULT_SETTINGS } from '../src/shared/types';

const OBSERVATION: ScreenObservation = {
  activity: 'coding',
  mood: 'curious',
  sensitive: false,
  detail: 'none',
};

interface Harness {
  deps: SchedulerDeps;
  calls: { capture: number; replies: RockyReply[]; indicators: number; observations: number };
  setSettings: (patch: Partial<Settings>) => void;
  /** Drive one scheduled (non-forced) tick without waiting for the interval. */
  tick: (scheduler: Scheduler) => Promise<void>;
}

function makeHarness(overrides: Partial<SchedulerDeps> = {}): Harness {
  const calls = { capture: 0, replies: [] as RockyReply[], indicators: 0, observations: 0 };
  let settings: Settings = {
    ...DEFAULT_SETTINGS,
    consentGiven: true,
    paused: false,
    blockedApps: ['1Password', 'Bank*'],
  };
  const deps: SchedulerDeps = {
    getSettings: () => settings,
    getProvider: () => ({
      kind: 'local',
      model: 'test',
      analyze: async () => OBSERVATION,
      ready: async () => ({ ok: true }),
    }),
    capture: async () => {
      calls.capture += 1;
      return { base64: 'aGVsbG8=', mime: 'image/jpeg', blank: false };
    },
    emitReply: (reply) => {
      calls.replies.push(reply);
    },
    emitCaptureIndicator: () => {
      calls.indicators += 1;
    },
    isScreenGranted: () => true,
    isFocusActive: () => false,
    getActiveAppName: async () => null,
    recordObservation: () => {
      calls.observations += 1;
      return { relationshipStage: 'buddy' as const, specialReply: null };
    },
    ...overrides,
  };
  return {
    deps,
    calls,
    setSettings: (patch) => {
      settings = { ...settings, ...patch };
    },
    tick: (scheduler) =>
      (scheduler as unknown as { tick: (force: boolean) => Promise<void> }).tick(false),
  };
}

test('blocked app skips capture before any screenshot exists', async () => {
  const h = makeHarness({ getActiveAppName: async () => '1password' });
  await new Scheduler(h.deps).lookNow();
  assert.equal(h.calls.capture, 0, 'capture must never run for a blocked app');
  assert.equal(h.calls.indicators, 0, 'the capture indicator must not fire');
  assert.equal(h.calls.replies.length, 0, 'no reply may surface');
});

test('wildcard-blocked app also skips capture', async () => {
  const h = makeHarness({ getActiveAppName: async () => 'Bank of Somewhere' });
  await new Scheduler(h.deps).lookNow();
  assert.equal(h.calls.capture, 0);
});

test('unblocked app runs one full observe cycle', async () => {
  const h = makeHarness({ getActiveAppName: async () => 'Visual Studio Code' });
  await new Scheduler(h.deps).lookNow();
  assert.equal(h.calls.capture, 1);
  assert.equal(h.calls.indicators, 1, 'indicator fires once a frame exists');
  assert.equal(h.calls.observations, 1, 'memory records one observation');
  assert.equal(h.calls.replies.length, 1);
  assert.ok(h.calls.replies[0].line.length > 0);
});

test('pausing while analysis is in flight suppresses the reply', async () => {
  const h = makeHarness();
  h.deps.getProvider = () => ({
    kind: 'local',
    model: 'test',
    analyze: async () => {
      h.setSettings({ paused: true });
      return OBSERVATION;
    },
    ready: async () => ({ ok: true }),
  });
  const scheduler = new Scheduler(h.deps);
  await h.tick(scheduler);
  assert.equal(h.calls.replies.length, 0, 'pause must produce no output whatsoever');
});

test('lookNow while paused never captures and offers a resting line', async () => {
  const h = makeHarness();
  h.setSettings({ paused: true });
  await new Scheduler(h.deps).lookNow();
  assert.equal(h.calls.capture, 0);
  assert.equal(h.calls.replies.length, 1);
});

test('without first-run consent nothing happens, even on a manual look', async () => {
  const h = makeHarness();
  h.setSettings({ consentGiven: false });
  await new Scheduler(h.deps).lookNow();
  assert.equal(h.calls.capture, 0);
  assert.equal(h.calls.replies.length, 0);
});

test('missing-permission hint appears once per resume, not every tick', async () => {
  const h = makeHarness({
    capture: async () => ({ base64: '', mime: 'image/jpeg', blank: true }),
    isScreenGranted: () => false,
  });
  const scheduler = new Scheduler(h.deps);
  await h.tick(scheduler);
  await h.tick(scheduler);
  assert.equal(h.calls.replies.length, 1, 'the hint must not repeat back-to-back');
});

test('focus suppresses scheduled ticks but not a manual look', async () => {
  const h = makeHarness({ isFocusActive: () => true });
  const scheduler = new Scheduler(h.deps);
  await h.tick(scheduler);
  assert.equal(h.calls.capture, 0, 'scheduled observation must wait out the focus session');
  await scheduler.lookNow();
  assert.equal(h.calls.capture, 1, 'the user can still ask Rocky to look');
});
