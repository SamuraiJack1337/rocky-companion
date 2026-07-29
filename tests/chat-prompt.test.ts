import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildChatSystemPrompt,
  buildDecisionsContext,
  buildNotesContext,
  CHAT_SYSTEM_PROMPT,
  parseDecisionDraft,
  parseResearchQueries,
  reflectionPrompt,
} from '../src/shared/chatPrompt';
import { listeningReply, noteSavedReply, noteSnippet } from '../src/shared/persona';
import type { NoteView } from '../src/shared/types';

function note(text: string, createdAt: string): NoteView {
  return { id: 'x', text, createdAt, source: 'voice' };
}

test('the chat system prompt keeps the call-name a local placeholder', () => {
  // The privacy trick: the model must be told to use the literal {name}.
  assert.ok(CHAT_SYSTEM_PROMPT.includes('{name}'));
  assert.ok(CHAT_SYSTEM_PROMPT.includes('placeholder'));
});

test('the prompt builder gates the WEB section on access and always coaches', () => {
  const available = buildChatSystemPrompt({ web: 'available' });
  const offline = buildChatSystemPrompt({ web: 'offline' });
  const disabled = buildChatSystemPrompt({ web: 'disabled' });

  // Sounding-board coaching is present in every mode.
  for (const p of [available, offline, disabled]) {
    assert.ok(p.includes('SOUNDING BOARD'));
    assert.ok(p.includes('{name}'));
  }

  // WEB ACCESS only appears when web is available or explicitly offline.
  assert.ok(available.includes('WEB ACCESS'));
  assert.ok(available.includes('search the web'));
  assert.ok(offline.includes('network is unreachable'));
  assert.ok(!disabled.includes('WEB ACCESS'));

  // Boundaries name web tools only when they exist.
  assert.ok(available.includes('web tools return'));
  assert.ok(!disabled.includes('web tools return'));
});

test('the default constant is the notebook-only (web-disabled) voice', () => {
  assert.equal(CHAT_SYSTEM_PROMPT, buildChatSystemPrompt({ web: 'disabled' }));
});

test('decisions context lists entries and is empty when there are none', () => {
  const block = buildDecisionsContext([
    { createdAt: '2026-06-03T10:00:00.000Z', decision: 'Use a queue', status: 'open' },
  ]);
  assert.ok(block.includes('[2026-06-03]'));
  assert.ok(block.includes('Use a queue'));
  assert.ok(block.includes('(open)'));
  assert.equal(buildDecisionsContext([]), '');
});

test('parseDecisionDraft extracts fields and tolerates prose', () => {
  const draft = parseDecisionDraft(
    'Sure: {"decision":"Adopt RSC","reasons":"Faster loads","expectedOutcome":"Lower TTFB"} done',
  );
  assert.equal(draft?.decision, 'Adopt RSC');
  assert.equal(draft?.reasons, 'Faster loads');
  assert.equal(draft?.expectedOutcome, 'Lower TTFB');
  assert.equal(parseDecisionDraft('{"decision":""}'), null);
  assert.equal(parseDecisionDraft('no json here'), null);
});

test('parseResearchQueries returns distinct queries, capped at five', () => {
  const qs = parseResearchQueries('["a","a","b","c","d","e","f"]');
  assert.deepEqual(qs, ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(parseResearchQueries('not an array'), []);
});

test('notes context formats dates and marks an empty notebook explicitly', () => {
  const block = buildNotesContext([
    note('idea one', '2026-07-10T09:30:00.000Z'),
    note('idea two', '2026-07-12T18:00:00.000Z'),
  ]);
  assert.ok(block.includes('[2026-07-10] idea one'));
  assert.ok(block.includes('[2026-07-12] idea two'));
  assert.ok(buildNotesContext([]).includes('no saved notes'));
});

test('every reflection kind produces a distinct prompt', () => {
  const prompts = (['summarize', 'connections', 'questions', 'weekly'] as const).map(
    reflectionPrompt,
  );
  assert.equal(new Set(prompts).size, 4);
  for (const p of prompts) assert.ok(p.length > 20);
});

test('note snippet clamps long transcripts with an ellipsis', () => {
  const long = 'word '.repeat(40).trim();
  const snippet = noteSnippet(long, 60);
  assert.ok(snippet.length <= 60);
  assert.ok(snippet.endsWith('…'));
  assert.equal(noteSnippet('short thought'), 'short thought');
});

test('voice-note persona replies render the call-name', () => {
  assert.ok(listeningReply('Ryland').line.includes('Ryland'));
  const saved = noteSavedReply('build a better antenna', 'Ryland');
  assert.ok(saved.line.includes('build a better antenna'));
  assert.ok(saved.line.includes('Ryland'));
  assert.equal(saved.gesture, 'build');
});
