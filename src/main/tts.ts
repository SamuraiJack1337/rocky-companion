// Spoken-voice synthesis (cloud TTS). Runs in the main process so the OpenAI
// key never crosses into the renderer — the renderer only receives the
// resulting audio bytes (base64, in memory) to play.
//
// Expressive cadence: Rocky's short, literal lines are split into phrases and
// synthesized as separate segments, each with a slight pace adjustment and a
// trailing micro-pause (a longer beat before a question, a quick clip on short
// affirmations). The renderer plays the segments back-to-back with those gaps,
// giving a delivery that breathes instead of one flat read. Segments are
// synthesized in parallel so latency stays close to a single call.
//
// The voice is one of OpenAI's own synthetic presets; `instructions` shapes
// delivery STYLE only (never identity). Only Rocky's short line text is sent
// (never a screenshot). The key and audio bytes are never logged.

import OpenAI from 'openai';
import { getOpenAIKey } from './keys';
import { store } from './store';
import type { TtsOverrides, TtsSegment } from '../shared/ipc';

/** Cap on phrases-per-line so a long line never fans out into too many calls. */
const MAX_SEGMENTS = 4;

/** Split a line into its short phrases, keeping terminating punctuation. */
function splitPhrases(text: string): string[] {
  const matches = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g);
  let parts = (matches ?? [text]).map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) parts = [text];
  if (parts.length > MAX_SEGMENTS) {
    // Merge the overflow into the final kept segment to honor the cap.
    const head = parts.slice(0, MAX_SEGMENTS - 1);
    const tail = parts.slice(MAX_SEGMENTS - 1).join(' ');
    parts = [...head, tail];
  }
  return parts;
}

/** Per-phrase pace (speed) and trailing pause based on the phrase's shape. */
function shapePhrase(phrase: string, isLast: boolean): { speed: number; gapMsAfter: number } {
  const isQuestion = /\?\s*$/.test(phrase);
  const letters = phrase.replace(/[^a-zA-Z]/g, '');
  const isShort = letters.length <= 6 || /^(good|amaze)\b/i.test(phrase.trim());

  let speed = 1.0;
  let gapMsAfter = 200; // a natural beat between statements
  if (isQuestion) {
    speed = 0.97; // a touch slower, thoughtful
    gapMsAfter = 320; // a longer beat before/after a question lands
  } else if (isShort) {
    speed = 1.1; // quick, clipped affirmation
    gapMsAfter = 130;
  }
  if (isLast) gapMsAfter = 0;
  return { speed, gapMsAfter };
}

/**
 * Synthesize a line as one or more cadence segments. Returns null when no key
 * is available or synthesis fails — callers then fall back to the procedural
 * tone, so this never throws into the UI.
 */
export async function synthesizeSpeech(
  text: string,
  overrides?: TtsOverrides,
): Promise<TtsSegment[] | null> {
  const key = getOpenAIKey();
  if (!key) return null;

  const clean = (text || '').trim();
  if (!clean) return null;

  const s = store.get();
  if (!s.ttsConsentGiven) return null;
  const voice = (overrides?.ttsVoice || s.ttsVoice || 'echo').trim();
  const model = (overrides?.ttsModel || s.ttsModel || 'gpt-4o-mini-tts').trim();
  const instructions = (overrides?.ttsInstructions ?? s.ttsInstructions ?? '').trim();
  const cadence = overrides?.expressiveCadence ?? s.expressiveCadence;

  // Per-segment `speed` is only honored by the classic tts-1 / tts-1-hd models.
  const classic = /^tts-1/i.test(model);
  // The delivery-style instruction is only honored by gpt-4o-* TTS models.
  const styled = instructions.length > 0 && /gpt/i.test(model);

  const phrases = cadence ? splitPhrases(clean) : [clean];

  try {
    const client = new OpenAI({ apiKey: key });
    const segments = await Promise.all(
      phrases.map(async (phrase, i): Promise<TtsSegment> => {
        const { speed, gapMsAfter } = cadence
          ? shapePhrase(phrase, i === phrases.length - 1)
          : { speed: 1.0, gapMsAfter: 0 };

        const params: {
          model: string;
          voice: string;
          input: string;
          response_format: 'wav';
          instructions?: string;
          speed?: number;
        } = { model, voice, input: phrase, response_format: 'wav' };
        if (styled) params.instructions = instructions;
        if (classic && speed !== 1.0) params.speed = speed;

        const response = await client.audio.speech.create(params);
        const buffer = Buffer.from(await response.arrayBuffer());
        return { base64: buffer.toString('base64'), mime: 'audio/wav', gapMsAfter };
      }),
    );
    return segments;
  } catch {
    // Generic, silent failure — never leak the key/network detail; the caller
    // gracefully degrades to the procedural tone.
    return null;
  }
}
