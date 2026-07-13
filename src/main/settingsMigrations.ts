// One-time repairs for settings files written by older builds. Electron-free
// so the rules stay directly testable (mirrors the scheduler's deps pattern).

import type { Settings } from '../shared/types';

/**
 * Builds before the `ttsConsentGiven` field shipped let users pick the OpenAI
 * spoken voice with only an API key — storing that key WAS the consent act.
 * Merging such a file over today's defaults would silently flip their working
 * voice off (`ttsConsentGiven: false` blocks synthesis in tts.ts). Repair it:
 * a file that predates the field, already chose the openai voice, and has a
 * usable key keeps its spoken voice. Files that ever wrote the field —
 * including an explicit `false` — and fresh installs are left untouched.
 */
export function migrateLegacyTtsConsent(
  parsed: Partial<Settings>,
  hasOpenAIKey: boolean,
): Partial<Settings> {
  if (parsed.voiceMode === 'openai' && !('ttsConsentGiven' in parsed) && hasOpenAIKey) {
    return { ...parsed, ttsConsentGiven: true };
  }
  return parsed;
}
