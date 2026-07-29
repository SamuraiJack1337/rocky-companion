import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyUtterance, parseResearchIntent } from '../src/shared/voiceIntent';

test('recognizes the plain research command forms', () => {
  assert.equal(parseResearchIntent('research WebGPU browser support'), 'WebGPU browser support');
  assert.equal(parseResearchIntent('look into sqlite vs duckdb'), 'sqlite vs duckdb');
  assert.equal(parseResearchIntent('find out about the EU AI act'), 'the EU AI act');
  assert.equal(parseResearchIntent('investigate rust async runtimes'), 'rust async runtimes');
  assert.equal(parseResearchIntent('do some research on vector databases'), 'vector databases');
});

test('strips lead-in address and trailing politeness', () => {
  assert.equal(
    parseResearchIntent('Hey Rocky, can you please research kokoro tts voices for me?'),
    'kokoro tts voices',
  );
  assert.equal(parseResearchIntent('rocky research electron ipc security please.'), 'electron ipc security');
  assert.equal(parseResearchIntent('okay rocky, look into pgvector thanks'), 'pgvector');
});

test('ordinary conversation is not a research command', () => {
  assert.equal(parseResearchIntent('what did I say about the queue design?'), null);
  assert.equal(parseResearchIntent('I did some research on my own yesterday'), null);
  assert.equal(parseResearchIntent('my research is going badly'), null);
  assert.equal(parseResearchIntent('research'), null);
  assert.equal(parseResearchIntent(''), null);
});

test('"research on/about/into X" parses with the optional preposition', () => {
  assert.equal(parseResearchIntent('research on vector databases'), 'vector databases');
  assert.equal(parseResearchIntent('research about the EU AI act'), 'the EU AI act');
  assert.equal(parseResearchIntent('research into rust async runtimes'), 'rust async runtimes');
});

// ── classifyUtterance: the global push-to-talk router ────────────────────────

test('the bug-report phrases classify correctly', () => {
  assert.deepEqual(
    classifyUtterance("Hey Rocky, can you tell me what's the weather like right now in New York?"),
    { kind: 'chat' },
  );
  assert.deepEqual(
    classifyUtterance(
      'Hey Rocky, can you research on quantum energy theory and the recent developments in this field',
    ),
    { kind: 'research', topic: 'quantum energy theory and the recent developments in this field' },
  );
});

test('addressing Rocky makes it a conversation', () => {
  assert.deepEqual(classifyUtterance('rocky what do you think about this plan'), { kind: 'chat' });
  assert.deepEqual(classifyUtterance('Hey Rocky, good morning'), { kind: 'chat' });
  assert.deepEqual(classifyUtterance('okay rocky remind me what I said about caching'), {
    kind: 'chat',
  });
});

test('question-shaped utterances are conversation even without the address', () => {
  assert.deepEqual(classifyUtterance('what did I say about the queue design'), { kind: 'chat' });
  assert.deepEqual(classifyUtterance('is the meeting at four or five'), { kind: 'chat' });
  assert.deepEqual(classifyUtterance('could you summarize my notes from this week'), {
    kind: 'chat',
  });
  assert.deepEqual(classifyUtterance('that library supports streaming?'), { kind: 'chat' });
});

test('research commands win with or without the address', () => {
  assert.deepEqual(classifyUtterance('look into pgvector'), {
    kind: 'research',
    topic: 'pgvector',
  });
  assert.deepEqual(classifyUtterance('hey rocky, investigate sqlite wal mode for me'), {
    kind: 'research',
    topic: 'sqlite wal mode',
  });
});

test('plain statements stay notes', () => {
  assert.deepEqual(classifyUtterance('remember to rotate the API keys'), { kind: 'note' });
  assert.deepEqual(classifyUtterance('picked up the new ssd today, feels fast'), { kind: 'note' });
  assert.deepEqual(classifyUtterance('idea: batch the embeddings at midnight'), { kind: 'note' });
  assert.deepEqual(classifyUtterance('my research is going badly'), { kind: 'note' });
  assert.deepEqual(classifyUtterance(''), { kind: 'note' });
});
