// The TTS consent repair: legacy files that chose the OpenAI voice before the
// ttsConsentGiven field existed must keep their spoken voice; everyone else's
// file passes through untouched (same object, no accidental rewrites).

import assert from 'node:assert/strict';
import test from 'node:test';
import { migrateLegacyTtsConsent } from '../src/main/settingsMigrations';
import type { Settings } from '../src/shared/types';

test('grants consent for a legacy openai-voice file with a key', () => {
  const parsed: Partial<Settings> = { voiceMode: 'openai', ttsVoice: 'echo' };
  const repaired = migrateLegacyTtsConsent(parsed, true);
  assert.equal(repaired.ttsConsentGiven, true);
  assert.notEqual(repaired, parsed); // new object signals "persist the repair"
});

test('never overrides an explicit consent choice, even false', () => {
  const parsed: Partial<Settings> = { voiceMode: 'openai', ttsConsentGiven: false };
  const repaired = migrateLegacyTtsConsent(parsed, true);
  assert.equal(repaired, parsed);
  assert.equal(repaired.ttsConsentGiven, false);
});

test('leaves procedural-voice and fresh files untouched', () => {
  const procedural: Partial<Settings> = { voiceMode: 'procedural' };
  assert.equal(migrateLegacyTtsConsent(procedural, true), procedural);

  const fresh: Partial<Settings> = {};
  assert.equal(migrateLegacyTtsConsent(fresh, true), fresh);
});

test('does not grant consent without a usable key', () => {
  const parsed: Partial<Settings> = { voiceMode: 'openai' };
  const repaired = migrateLegacyTtsConsent(parsed, false);
  assert.equal(repaired, parsed);
  assert.equal('ttsConsentGiven' in repaired, false);
});
