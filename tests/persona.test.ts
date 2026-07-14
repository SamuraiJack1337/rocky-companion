import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculationReply,
  composeRockyReply,
  fistBumpReply,
  focusCompletedReply,
  greetingReply,
  parseObservation,
  UNKNOWN_OBSERVATION,
} from '../src/shared/persona';
import { renderLine } from '../src/shared/lines';

test('parses only the fixed observation fields', () => {
  assert.deepEqual(
    parseObservation('{"activity":"coding","mood":"curious","sensitive":false}'),
    { activity: 'coding', mood: 'curious', sensitive: false, detail: 'none' },
  );
});

test('parses a legal detail for the activity', () => {
  assert.deepEqual(
    parseObservation('{"activity":"coding","detail":"debugging","mood":"curious","sensitive":false}'),
    { activity: 'coding', mood: 'curious', sensitive: false, detail: 'debugging' },
  );
});

test('clamps a detail that does not belong to the activity', () => {
  assert.equal(
    parseObservation('{"activity":"writing","detail":"debugging","mood":"calm","sensitive":false}').detail,
    'none',
  );
});

test('clamps an invented detail value', () => {
  assert.equal(
    parseObservation('{"activity":"coding","detail":"typescript-in-vscode","mood":"calm","sensitive":false}').detail,
    'none',
  );
});

test('sensitive observations always carry no detail', () => {
  assert.deepEqual(
    parseObservation('{"activity":"coding","detail":"debugging","mood":"calm","sensitive":true}'),
    { activity: 'sensitive', mood: 'calm', sensitive: true, detail: 'none' },
  );
});

test('discards arbitrary model-authored text', () => {
  const raw = JSON.stringify({
    activity: 'writing',
    mood: 'calm',
    sensitive: false,
    line: 'visible-secret@example.com',
    filename: 'private-plan.txt',
  });
  const observation = parseObservation(raw);
  assert.deepEqual(observation, { activity: 'writing', mood: 'calm', sensitive: false, detail: 'none' });
  assert.equal(JSON.stringify(observation).includes('visible-secret'), false);
  assert.equal(JSON.stringify(observation).includes('private-plan'), false);
});

test('sensitivity overrides an unsafe activity classification', () => {
  assert.deepEqual(
    parseObservation('{"activity":"reading","mood":"calm","sensitive":true}'),
    { activity: 'sensitive', mood: 'calm', sensitive: true, detail: 'none' },
  );
});

test('malformed responses become unknown observations', () => {
  assert.deepEqual(parseObservation('not json and not screen text'), UNKNOWN_OBSERVATION);
});

test('classic style discards a remark the model volunteers', () => {
  const raw = '{"activity":"coding","mood":"curious","sensitive":false,"remark":"You chase a bug, {name}?"}';
  assert.equal('remark' in parseObservation(raw, 'classic'), false);
  assert.equal('remark' in parseObservation(raw), false); // classic is the parse default
});

test('realistic style keeps a sanitized remark', () => {
  const raw =
    '{"activity":"coding","mood":"curious","sensitive":false,"remark":"  You chase a\\nstubborn bug, {name},   question?  "}';
  assert.equal(
    parseObservation(raw, 'realistic').remark,
    'You chase a stubborn bug, {name}, question?',
  );
});

test('realistic remarks are length-clamped and empty ones dropped', () => {
  const long = JSON.stringify({
    activity: 'reading', mood: 'calm', sensitive: false, remark: 'x'.repeat(1000),
  });
  const remark = parseObservation(long, 'realistic').remark;
  assert.ok(remark && remark.length <= 200);
  const empty = '{"activity":"reading","mood":"calm","sensitive":false,"remark":"   "}';
  assert.equal('remark' in parseObservation(empty, 'realistic'), false);
});

test('sensitive observations never keep a remark, even in realistic style', () => {
  const raw =
    '{"activity":"coding","mood":"calm","sensitive":true,"remark":"Your bank balance is visible."}';
  const observation = parseObservation(raw, 'realistic');
  assert.equal('remark' in observation, false);
  assert.equal(observation.activity, 'sensitive');
});

test('a realistic remark becomes the spoken line with placeholders rendered', () => {
  const reply = composeRockyReply(
    {
      activity: 'coding',
      mood: 'curious',
      sensitive: false,
      detail: 'debugging',
      remark: 'That bug hides well, {name}. We corner it, question?',
    },
    { name: 'Grace' },
  );
  assert.equal(reply.line, 'That bug hides well, Grace. We corner it, question?');
  assert.equal(reply.gesture, 'calculate'); // performance still comes from the enums
});

test('without a remark the reply falls back to the template pool', () => {
  const reply = composeRockyReply({ activity: 'coding', mood: 'curious', sensitive: false, detail: 'none' });
  assert.ok(reply.line.length > 0);
});

test('late night keeps a realistic remark but forces the sleepy performance', () => {
  const reply = composeRockyReply(
    { activity: 'coding', mood: 'curious', sensitive: false, detail: 'none', remark: 'Still coding? Rest soon, {name}.' },
    { lateNight: true, name: 'Grace' },
  );
  assert.equal(reply.mood, 'sleepy');
  assert.equal(reply.gesture, 'watch');
  assert.equal(reply.line, 'Still coding? Rest soon, Grace.');
});

test('late night without a remark falls back to the templated rest nudge', () => {
  const reply = composeRockyReply(
    { activity: 'coding', mood: 'curious', sensitive: false, detail: 'none' },
    { lateNight: true },
  );
  assert.equal(reply.mood, 'sleepy');
  assert.ok(reply.line.includes('sleep'));
});

test('character stage receives enums and adds performance direction', () => {
  const reply = composeRockyReply({ activity: 'coding', mood: 'curious', sensitive: false, detail: 'none' });
  assert.equal(reply.activity, 'coding');
  assert.equal(reply.gesture, 'calculate');
  assert.equal(reply.mood, 'curious');
  assert.equal(reply.motif, 'calculate');
  assert.ok(reply.line.length > 0);
});

test('rendered lines never leak template placeholders', () => {
  for (let i = 0; i < 30; i++) {
    const reply = composeRockyReply(
      { activity: 'coding', mood: 'curious', sensitive: false, detail: 'debugging' },
      { name: 'Grace', appName: 'Visual Studio Code' },
    );
    assert.equal(/\{(name|app|detail)\}/.test(reply.line), false, reply.line);
  }
});

test('the call-name reaches lines that use it', () => {
  assert.equal(renderLine('Hello, {name}.', { name: 'Grace' }), 'Hello, Grace.');
  assert.equal(renderLine('Hello, {name}.', {}), 'Hello, buddy.');
  assert.equal(renderLine('Hello, {name}.', { name: '   ' }), 'Hello, buddy.');
});

test('late-night activity triggers the watch-and-rest performance', () => {
  const reply = composeRockyReply(
    { activity: 'browsing', mood: 'curious', sensitive: false, detail: 'none' },
    { lateNight: true },
  );
  assert.equal(reply.mood, 'sleepy');
  assert.equal(reply.gesture, 'watch');
  assert.equal(reply.motif, 'rest');
});

test('sensitive replies stay generic even when context exists', () => {
  const reply = composeRockyReply(
    { activity: 'sensitive', mood: 'calm', sensitive: true, detail: 'none' },
    { name: 'Grace', appName: 'Banking App' },
  );
  assert.equal(reply.activity, 'sensitive');
  assert.equal(reply.line.includes('Banking App'), false);
});

test('greeting uses the custom call-name', () => {
  assert.equal(greetingReply('buddy', 'Grace').line.includes('Grace'), true);
  assert.equal(greetingReply('buddy').line.includes('buddy'), true);
});

test('ritual replies carry stable gesture and musical intent', () => {
  assert.deepEqual(
    [greetingReply('buddy').motif, focusCompletedReply().motif, fistBumpReply().gesture, calculationReply().gesture],
    ['greeting', 'complete', 'fistBump', 'build'],
  );
});
