import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldOfferWeeklyNudge } from '../src/main/weeklyNudge';
import { parseTopicTags } from '../src/shared/chatPrompt';

/** 2026-07-17 is a Friday; build local times on it. */
function friday(hour: number): Date {
  return new Date(2026, 6, 17, hour, 30, 0);
}

const ready = {
  enabled: true,
  paused: false,
  lastNudgeISO: null,
  recentNoteCount: 5,
};

test('offers on a Friday afternoon with enough notes', () => {
  assert.equal(shouldOfferWeeklyNudge(friday(15), ready), true);
});

test('never offers outside the Friday-afternoon window', () => {
  assert.equal(shouldOfferWeeklyNudge(friday(10), ready), false); // morning
  assert.equal(shouldOfferWeeklyNudge(friday(22), ready), false); // night
  const thursday = new Date(2026, 6, 16, 15, 0, 0);
  assert.equal(shouldOfferWeeklyNudge(thursday, ready), false);
});

test('respects the toggle, pause, and the note minimum', () => {
  assert.equal(shouldOfferWeeklyNudge(friday(15), { ...ready, enabled: false }), false);
  assert.equal(shouldOfferWeeklyNudge(friday(15), { ...ready, paused: true }), false);
  assert.equal(shouldOfferWeeklyNudge(friday(15), { ...ready, recentNoteCount: 2 }), false);
});

test('cools down for six days after an offer', () => {
  const twoDaysAgo = new Date(friday(15).getTime() - 2 * 86_400_000).toISOString();
  const eightDaysAgo = new Date(friday(15).getTime() - 8 * 86_400_000).toISOString();
  assert.equal(shouldOfferWeeklyNudge(friday(15), { ...ready, lastNudgeISO: twoDaysAgo }), false);
  assert.equal(shouldOfferWeeklyNudge(friday(15), { ...ready, lastNudgeISO: eightDaysAgo }), true);
  // A garbage timestamp never blocks the offer.
  assert.equal(shouldOfferWeeklyNudge(friday(15), { ...ready, lastNudgeISO: 'not-a-date' }), true);
});

// ── Topic tag parsing (Stage 1 polish: auto-tagging) ─────────────────────────

test('parses a clean tag array, normalizing case and spacing', () => {
  assert.deepEqual(parseTopicTags('["Project Idea", " hardware "]'), ['project idea', 'hardware']);
});

test('tolerates prose around the array and enforces the cap', () => {
  const raw = 'Sure! Here are the tags: ["a","b","c","d"] — hope that helps.';
  assert.deepEqual(parseTopicTags(raw), ['a', 'b', 'c']);
});

test('drops junk: non-strings, duplicates, over-long and empty tags', () => {
  const raw = JSON.stringify(['health', 'HEALTH', 42, '', 'x'.repeat(40), 'sleep!!']);
  assert.deepEqual(parseTopicTags(raw), ['health', 'sleep']);
});

test('returns [] for malformed replies', () => {
  assert.deepEqual(parseTopicTags('no array here'), []);
  assert.deepEqual(parseTopicTags('{"tags": true}'), []);
  assert.deepEqual(parseTopicTags(''), []);
});
