import assert from 'node:assert/strict';
import test from 'node:test';
import { isAppBlocked } from '../src/main/activeApp';

test('app blocking is case-insensitive and exact by default', () => {
  assert.equal(isAppBlocked('1Password', ['1password']), true);
  assert.equal(isAppBlocked('Google Chrome', ['Chrome']), false);
});

test('app blocking supports explicit wildcards', () => {
  assert.equal(isAppBlocked('Google Chrome', ['Google *']), true);
  assert.equal(isAppBlocked('Safari Technology Preview', ['Safari*']), true);
  assert.equal(isAppBlocked('Messages', ['Mail*']), false);
});

test('missing app identity never blocks capture', () => {
  assert.equal(isAppBlocked(null, ['*']), false);
});
