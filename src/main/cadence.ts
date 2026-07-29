// Expressive cadence, shared by the cloud (OpenAI) and offline (Kokoro) spoken
// voices. Rocky's short, literal lines are split into phrases, each given a
// slight pace adjustment and a trailing micro-pause (a longer beat before a
// question, a quick clip on short affirmations). The renderer plays the
// resulting segments back-to-back with those gaps, so delivery breathes
// instead of one flat read.

/** Cap on phrases-per-line so a long line never fans out into too many calls. */
const MAX_SEGMENTS = 4;

/** Split a line into its short phrases, keeping terminating punctuation. */
export function splitPhrases(text: string): string[] {
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
export function shapePhrase(
  phrase: string,
  isLast: boolean,
): { speed: number; gapMsAfter: number } {
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
