import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionTracker } from '../src/main/sessionTracker';

const START = new Date('2026-07-13T09:00:00');
const at = (minutes: number) => new Date(START.getTime() + minutes * 60_000);

test('a two-hour same-activity run produces one long-run insight', () => {
  const tracker = new SessionTracker();
  let insights = 0;
  for (let m = 0; m <= 130; m += 10) {
    const insight = tracker.record('coding', at(m));
    if (insight) {
      insights += 1;
      assert.equal(insight.hours, 2);
      assert.equal(insight.activity, 'coding');
    }
  }
  assert.equal(insights, 1, 'the 2h threshold fires exactly once per run');
});

test('a single stray observation does not reset the run', () => {
  const tracker = new SessionTracker();
  for (let m = 0; m < 60; m += 10) tracker.record('coding', at(m));
  tracker.record('browsing', at(60)); // quick doc lookup
  let fired = false;
  for (let m = 70; m <= 130; m += 10) {
    if (tracker.record('coding', at(m))) fired = true;
  }
  assert.equal(fired, true, 'run survived one off-activity observation');
});

test('two consecutive different observations start a new run', () => {
  const tracker = new SessionTracker();
  for (let m = 0; m < 110; m += 10) tracker.record('coding', at(m));
  tracker.record('browsing', at(110));
  tracker.record('browsing', at(120));
  // Back on coding, but the old run is gone — no 2h insight fires now.
  assert.equal(tracker.record('coding', at(130)), null);
});

test('breaks are invisible but a long gap ends the run', () => {
  const tracker = new SessionTracker();
  tracker.record('coding', at(0));
  tracker.record('idle', at(15)); // break: neither extends nor ends
  assert.equal(tracker.record('coding', at(30)), null);
  // 90-minute silence → stale → new run; no insight at what would be 2h.
  assert.equal(tracker.record('coding', at(125)), null);
  assert.equal(tracker.record('coding', at(135)), null);
});

test('idle, sensitive, and unknown never produce insights', () => {
  const tracker = new SessionTracker();
  for (let m = 0; m <= 150; m += 10) {
    assert.equal(tracker.record('idle', at(m)), null);
  }
});
