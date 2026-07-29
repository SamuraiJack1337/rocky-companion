import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { DecisionsStore } from '../src/main/decisions';

function tmpFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rocky-dec-'));
  return path.join(dir, 'decisions.json');
}

const T0 = new Date('2026-07-01T12:00:00.000Z');

test('add stores a normalized record and sets a follow-up horizon', () => {
  const file = tmpFile();
  const store = new DecisionsStore(() => file, () => T0);
  const rec = store.add({
    decision: '  Adopt   RSC  ',
    reasons: 'Faster loads',
    expectedOutcome: 'Lower TTFB',
  });
  assert.ok(rec);
  assert.equal(rec!.decision, 'Adopt RSC');
  assert.equal(rec!.status, 'open');
  // Default horizon is 14 days out.
  assert.equal(rec!.followUpAfter, new Date('2026-07-15T12:00:00.000Z').toISOString());

  // Persisted across instances.
  assert.equal(new DecisionsStore(() => file).list().length, 1);
});

test('add rejects an empty decision', () => {
  const store = new DecisionsStore(() => tmpFile(), () => T0);
  assert.equal(store.add({ decision: '   ', reasons: '', expectedOutcome: '' }), null);
});

test('resolve marks closed and removes it from open()', () => {
  const file = tmpFile();
  const store = new DecisionsStore(() => file, () => T0);
  const rec = store.add({ decision: 'Use a queue', reasons: '', expectedOutcome: '' })!;
  store.resolve(rec.id, 'It held up well');
  assert.equal(store.open().length, 0);
  const resolved = store.list()[0];
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.resolution, 'It held up well');
});

test('dueForFollowUp returns the oldest past-due open decision, or null', () => {
  const file = tmpFile();
  let clock = T0;
  const store = new DecisionsStore(() => file, () => clock);
  const rec = store.add({ decision: 'Ship beta', reasons: '', expectedOutcome: '' })!;

  // Before the horizon: nothing due.
  assert.equal(store.dueForFollowUp(), null);

  // After 15 days: it's due.
  clock = new Date('2026-07-16T12:00:00.000Z');
  assert.equal(store.dueForFollowUp()?.id, rec.id);

  // Resolving it clears the follow-up.
  store.resolve(rec.id, 'done');
  assert.equal(store.dueForFollowUp(), null);
});
