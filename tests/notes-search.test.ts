import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cosineSimilarity,
  keywordScore,
  rankNotes,
  tokenize,
} from '../src/shared/notesSearch';
import type { SearchableNote } from '../src/shared/notesSearch';

function note(id: string, text: string, embedding?: number[]): SearchableNote {
  return { id, text, createdAt: '2026-07-15T00:00:00.000Z', embedding };
}

test('tokenize lowercases and drops stop-words and single letters', () => {
  assert.deepEqual(tokenize('The Project is a GOOD idea, I think!'), [
    'project',
    'good',
    'idea',
    'think',
  ]);
});

test('keyword score is 1 when every query token appears in the note', () => {
  assert.equal(keywordScore('project deadline', 'my project has a deadline in june'), 1);
});

test('keyword score gives prefix matches half credit', () => {
  // "deploy" vs "deployment" — a prefix hit, not exact.
  const score = keywordScore('deploy', 'the deployment failed again');
  assert.equal(score, 0.5);
});

test('keyword score is 0 with no overlap or an empty query', () => {
  assert.equal(keywordScore('quantum banana', 'notes about the tax return'), 0);
  assert.equal(keywordScore('', 'anything'), 0);
  assert.equal(keywordScore('the a is', 'anything'), 0); // all stop-words
});

test('cosine similarity handles identical, orthogonal, and degenerate vectors', () => {
  assert.ok(Math.abs(cosineSimilarity([1, 2, 3], [1, 2, 3]) - 1) < 1e-9);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  assert.equal(cosineSimilarity([], []), 0);
  assert.equal(cosineSimilarity([1, 2], [1, 2, 3]), 0); // length mismatch
  assert.equal(cosineSimilarity([0, 0], [1, 2]), 0); // zero norm
});

test('rankNotes uses embeddings when both sides have them', () => {
  const notes = [
    note('close', 'alpha', [1, 0, 0]),
    note('far', 'alpha', [0, 1, 0]),
  ];
  const ranked = rankNotes('unrelated words entirely', notes, [1, 0.1, 0], 5);
  assert.equal(ranked[0].id, 'close');
  assert.ok(ranked[0].score > 0.9);
});

test('rankNotes falls back to keywords for notes without embeddings', () => {
  const notes = [
    note('hit', 'thoughts about the rocket engine project'),
    note('miss', 'grocery list: eggs and milk'),
  ];
  const ranked = rankNotes('rocket engine', notes, null, 5);
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].id, 'hit');
});

test('rankNotes drops notes below the relevance floor and honors topK', () => {
  const notes = [
    note('a', 'the fusion reactor design needs work'),
    note('b', 'fusion cooking recipes for dinner'),
    note('c', 'completely unrelated gardening note'),
  ];
  const ranked = rankNotes('fusion reactor', notes, null, 1);
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].id, 'a');
});

test('a note is scored by keywords when only IT lacks an embedding', () => {
  const notes = [
    note('embedded-far', 'zzz', [0, 1]),
    note('keyword-hit', 'the launch checklist for tomorrow'),
  ];
  const ranked = rankNotes('launch checklist', notes, [1, 0], 5);
  assert.deepEqual(ranked.map((r) => r.id), ['keyword-hit']);
});
