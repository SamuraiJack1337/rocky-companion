import assert from 'node:assert/strict';
import test from 'node:test';
import { buildNotesContext, CHAT_SYSTEM_PROMPT, reflectionPrompt } from '../src/shared/chatPrompt';
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
