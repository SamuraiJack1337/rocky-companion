import assert from 'node:assert/strict';
import test from 'node:test';
import { detectMilestones } from '../src/main/milestones';
import type { CompanionMemory } from '../src/shared/types';

function mem(patch: Partial<CompanionMemory> = {}): CompanionMemory {
  return {
    firstSeenAt: '2026-01-01T00:00:00.000Z',
    lastSeenAt: '2026-01-01T00:00:00.000Z',
    launches: 0,
    observations: 0,
    focusSessionsCompleted: 0,
    fistBumps: 0,
    calculationsCompleted: 0,
    relationshipStage: 'first-contact',
    focusDayStreak: 0,
    lastFocusDayISO: null,
    ...patch,
  };
}

test('crossing an observation mark fires once', () => {
  const events = detectMilestones(mem({ observations: 99 }), mem({ observations: 100 }));
  assert.deepEqual(events, [{ kind: 'observations', n: 100 }]);
  assert.deepEqual(detectMilestones(mem({ observations: 100 }), mem({ observations: 101 })), []);
});

test('stage promotion is detected', () => {
  const events = detectMilestones(
    mem({ relationshipStage: 'colleague' }),
    mem({ relationshipStage: 'buddy' }),
  );
  assert.deepEqual(events, [{ kind: 'stage-promotion', stage: 'buddy' }]);
});

test('a stage downgrade (reset) is not celebrated', () => {
  assert.deepEqual(
    detectMilestones(mem({ relationshipStage: 'buddy' }), mem({ relationshipStage: 'first-contact' })),
    [],
  );
});

test('focus streaks fire at their marks, including after a reset', () => {
  assert.deepEqual(
    detectMilestones(mem({ focusDayStreak: 1 }), mem({ focusDayStreak: 2 })),
    [{ kind: 'focus-streak', days: 2 }],
  );
  // Streak broke (5 → 1), later rebuilt: the 2-day mark may fire again.
  assert.deepEqual(detectMilestones(mem({ focusDayStreak: 5 }), mem({ focusDayStreak: 1 })), []);
  assert.deepEqual(
    detectMilestones(mem({ focusDayStreak: 1 }), mem({ focusDayStreak: 2 })),
    [{ kind: 'focus-streak', days: 2 }],
  );
});

test('fist bump marks fire', () => {
  assert.deepEqual(
    detectMilestones(mem({ fistBumps: 9 }), mem({ fistBumps: 10 })),
    [{ kind: 'fist-bumps', n: 10 }],
  );
});
