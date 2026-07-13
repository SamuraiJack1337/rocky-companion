// Milestone detection: pure diffing over the privacy-safe CompanionMemory
// counters. No storage, no Electron — callers snapshot memory before/after an
// event and get back the notable moments that were crossed.

import type { CompanionMemory, MilestoneEvent, RelationshipStage } from '../shared/types';

const OBSERVATION_MARKS = [10, 50, 100, 500, 1000] as const;
const FOCUS_STREAK_MARKS = [2, 3, 5, 7, 14] as const;
const FIST_BUMP_MARKS = [10, 50] as const;

const STAGE_ORDER: readonly RelationshipStage[] = [
  'first-contact',
  'colleague',
  'buddy',
  'trusted-buddy',
];

/** Marks whose value was crossed (strictly) between before and after. */
function crossed(marks: readonly number[], before: number, after: number): number[] {
  return marks.filter((m) => before < m && after >= m);
}

export function detectMilestones(before: CompanionMemory, after: CompanionMemory): MilestoneEvent[] {
  const events: MilestoneEvent[] = [];
  if (STAGE_ORDER.indexOf(after.relationshipStage) > STAGE_ORDER.indexOf(before.relationshipStage)) {
    events.push({ kind: 'stage-promotion', stage: after.relationshipStage });
  }
  for (const n of crossed(OBSERVATION_MARKS, before.observations, after.observations)) {
    events.push({ kind: 'observations', n });
  }
  for (const days of crossed(FOCUS_STREAK_MARKS, before.focusDayStreak, after.focusDayStreak)) {
    events.push({ kind: 'focus-streak', days });
  }
  for (const n of crossed(FIST_BUMP_MARKS, before.fistBumps, after.fistBumps)) {
    events.push({ kind: 'fist-bumps', n });
  }
  return events;
}
