import assert from 'node:assert/strict';
import test from 'node:test';
import { splitPhrases, shapePhrase } from '../src/main/cadence';

// Pure logic shared by the cloud and offline spoken voices — the phrase
// splitter and the per-phrase pace/pause shaping.

test('splitPhrases keeps terminating punctuation per phrase', () => {
  assert.deepEqual(splitPhrases('Buddy. You are here. We work, question?'), [
    'Buddy.',
    'You are here.',
    'We work, question?',
  ]);
});

test('splitPhrases returns the whole line when there is no punctuation', () => {
  assert.deepEqual(splitPhrases('no punctuation at all'), ['no punctuation at all']);
});

test('splitPhrases caps at 4 segments, merging overflow into the last', () => {
  const parts = splitPhrases('One. Two. Three. Four. Five. Six.');
  assert.equal(parts.length, 4);
  assert.deepEqual(parts.slice(0, 3), ['One.', 'Two.', 'Three.']);
  assert.equal(parts[3], 'Four. Five. Six.');
});

test('shapePhrase slows and pauses on questions', () => {
  const q = shapePhrase('We work, question?', false);
  assert.equal(q.speed, 0.97);
  assert.equal(q.gapMsAfter, 320);
});

test('shapePhrase clips short affirmations', () => {
  const s = shapePhrase('Good.', false);
  assert.equal(s.speed, 1.1);
  assert.equal(s.gapMsAfter, 130);
});

test('shapePhrase uses a plain beat for ordinary statements', () => {
  const p = shapePhrase('You are still at the code.', false);
  assert.equal(p.speed, 1.0);
  assert.equal(p.gapMsAfter, 200);
});

test('shapePhrase drops the trailing gap on the last phrase', () => {
  assert.equal(shapePhrase('We work, question?', true).gapMsAfter, 0);
  assert.equal(shapePhrase('Good.', true).gapMsAfter, 0);
});
