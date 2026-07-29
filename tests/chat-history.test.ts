import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { ChatHistoryStore, sanitizeMessages, MAX_STORED_MESSAGES } from '../src/main/chatHistory';
import type { ChatMessage } from '../src/shared/types';

function tmpFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rocky-hist-'));
  return path.join(dir, 'chat-history.json');
}

test('sanitizeMessages drops malformed turns and trims to the cap', () => {
  const raw = [
    { role: 'user', text: 'hi' },
    { role: 'rocky', text: 'hello' },
    { role: 'bogus', text: 'nope' },
    { role: 'user', text: '   ' },
    { role: 'user' },
    'not an object',
  ];
  const clean = sanitizeMessages(raw);
  assert.deepEqual(clean, [
    { role: 'user', text: 'hi' },
    { role: 'rocky', text: 'hello' },
  ]);

  const many = Array.from({ length: MAX_STORED_MESSAGES + 50 }, (_, i): ChatMessage => ({
    role: 'user',
    text: `m${i}`,
  }));
  const trimmed = sanitizeMessages(many);
  assert.equal(trimmed.length, MAX_STORED_MESSAGES);
  assert.equal(trimmed[trimmed.length - 1].text, `m${MAX_STORED_MESSAGES + 49}`);
});

test('append persists across store instances and clear empties the file', () => {
  const file = tmpFile();
  const store = new ChatHistoryStore(() => file);
  store.appendTurn({ role: 'user', text: 'what is x' }, { role: 'rocky', text: 'x is y' });

  // A fresh instance reads what the first wrote.
  const reopened = new ChatHistoryStore(() => file);
  assert.deepEqual(reopened.list(), [
    { role: 'user', text: 'what is x' },
    { role: 'rocky', text: 'x is y' },
  ]);

  reopened.clear();
  assert.deepEqual(new ChatHistoryStore(() => file).list(), []);
});

test('append respects the cap over many turns', () => {
  const file = tmpFile();
  const store = new ChatHistoryStore(() => file);
  for (let i = 0; i < MAX_STORED_MESSAGES + 20; i++) {
    store.append({ role: 'user', text: `turn ${i}` });
  }
  const list = store.list();
  assert.equal(list.length, MAX_STORED_MESSAGES);
  assert.equal(list[list.length - 1].text, `turn ${MAX_STORED_MESSAGES + 19}`);
});
