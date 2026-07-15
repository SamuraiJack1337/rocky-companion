// analyze() must map each Ollama failure mode to a DISTINCT in-character
// message. The regression these guard against: the old code funneled every
// failure into "cannot reach the local brain", so a merely slow or misbehaving
// model read to users as "not connected" even though Ollama was running.

import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { OllamaProvider } from '../src/main/providers/OllamaProvider';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** A tiny valid base64 payload; the stubs never inspect it. */
const IMG = 'aGVsbG8=';
const HOST = 'http://localhost:11434';

function stubFetch(impl: typeof globalThis.fetch): void {
  globalThis.fetch = impl;
}

test('transport failure surfaces the "cannot reach" message', async () => {
  stubFetch(async () => {
    throw new TypeError('fetch failed');
  });
  const provider = new OllamaProvider(HOST, 'moondream');
  await assert.rejects(provider.analyze(IMG, 'image/png'), /cannot reach the local brain/i);
});

test('a non-OK status is a model problem, not "cannot reach"', async () => {
  stubFetch(async () => new Response('no such model', { status: 404 }));
  const provider = new OllamaProvider(HOST, 'not-installed');
  await assert.rejects(provider.analyze(IMG, 'image/png'), (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    assert.match(msg, /can't run that model/i);
    assert.doesNotMatch(msg, /cannot reach the local brain/i);
    return true;
  });
});

test('a malformed (non-JSON) reply surfaces the parse message', async () => {
  stubFetch(
    async () =>
      ({
        ok: true,
        json: async () => {
          throw new Error('unexpected token');
        },
      }) as unknown as Response,
  );
  const provider = new OllamaProvider(HOST, 'moondream');
  await assert.rejects(provider.analyze(IMG, 'image/png'), /couldn't read it/i);
});

test('an external cancel is rethrown, never as "cannot reach"', async () => {
  // fetch rejects with an AbortError once its signal fires.
  stubFetch(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      }),
  );
  const controller = new AbortController();
  const provider = new OllamaProvider(HOST, 'moondream');
  const promise = provider.analyze(IMG, 'image/png', { signal: controller.signal });
  controller.abort();
  await assert.rejects(promise, (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    // A user-initiated pause/quit must not read as a connectivity error.
    assert.doesNotMatch(msg, /cannot reach the local brain/i);
    return true;
  });
});

test('a well-formed reply parses into an observation', async () => {
  const body = JSON.stringify({
    message: { content: JSON.stringify({ activity: 'unknown', mood: 'calm' }) },
  });
  stubFetch(async () => new Response(body, { status: 200 }));
  const provider = new OllamaProvider(HOST, 'moondream');
  const obs = await provider.analyze(IMG, 'image/png');
  assert.equal(typeof obs.activity, 'string');
  assert.equal(typeof obs.mood, 'string');
});
