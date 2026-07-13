import assert from 'node:assert/strict';
import test from 'node:test';
import { isLoopbackOllamaHost } from '../src/main/providers/OllamaProvider';

test('accepts explicit loopback Ollama endpoints', () => {
  assert.equal(isLoopbackOllamaHost('http://localhost:11434'), true);
  assert.equal(isLoopbackOllamaHost('http://127.0.0.1:11434'), true);
  assert.equal(isLoopbackOllamaHost('http://[::1]:11434'), true);
});

test('rejects remote or deceptive Ollama endpoints', () => {
  assert.equal(isLoopbackOllamaHost('https://example.com'), false);
  assert.equal(isLoopbackOllamaHost('http://localhost.example.com:11434'), false);
  assert.equal(isLoopbackOllamaHost('not-a-url'), false);
});
