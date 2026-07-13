import assert from 'node:assert/strict';
import test from 'node:test';
import { FocusManager } from '../src/main/focus';

test('focus manager starts, clamps, broadcasts, and cancels', () => {
  const states: boolean[] = [];
  let completed = false;
  const focus = new FocusManager((state) => states.push(state.active), () => { completed = true; });
  const started = focus.start(999);
  assert.equal(started.active, true);
  assert.equal(started.durationMinutes, 180);
  assert.ok(started.startedAt);
  assert.ok(started.endsAt);
  const cancelled = focus.cancel();
  assert.equal(cancelled.active, false);
  assert.deepEqual(states, [true, false]);
  assert.equal(completed, false);
});
