// Voice intent routing: classify a spoken utterance so the one global
// push-to-talk affordance can do the right thing — launch research, hold a
// conversation, or keep a note. Deliberately a dumb, transparent heuristic —
// the phrase forms are few, false positives are cheap (worst case: research
// runs on a topic you then cancel), and keeping it out of the model means
// intent detection works identically on both providers and costs nothing.
//
// PRIVACY INVARIANT: the note-vs-conversation gate stays a LOCAL heuristic on
// purpose — dictated notes must never be sent to a model (or, transitively,
// into web search queries) just to classify them. Only utterances classified
// as conversation ever reach a model.

/** Longest topic we accept from a spoken command. */
const TOPIC_MAX_LENGTH = 300;

/** Leading filler before the verb: "hey rocky, can you please …". */
const LEAD_IN =
  /^(?:(?:hey|hi|ok|okay)[,!.\s]+)?(?:rocky[,!.\s]+)?(?:can you\s+|could you\s+|would you\s+|please\s+)*/i;

/** The research verb phrases we route. Everything after them is the topic.
 *  The preposition after "research" is optional either way, so both
 *  "research vector databases" and "research on vector databases" parse. */
const VERB =
  /^(?:do\s+(?:some\s+)?research(?:\s+(?:on|about|into))?|research(?:\s+(?:on|about|into))?|look\s+into|find\s+out\s+about|investigate|dig\s+into)\s+(.+)$/i;

/** Trailing politeness that isn't part of the topic. */
const TRAIL = /[\s,]*(?:for me|please|thanks|thank you)?[\s.!?]*$/i;

/**
 * If the spoken text is a research command, return the topic; otherwise null.
 * "Hey Rocky, research WebGPU support for me" → "WebGPU support".
 */
export function parseResearchIntent(text: string): string | null {
  if (!text || typeof text !== 'string') return null;
  const stripped = text.trim().replace(LEAD_IN, '');
  const match = stripped.match(VERB);
  if (!match) return null;
  const topic = match[1].replace(TRAIL, '').trim().slice(0, TOPIC_MAX_LENGTH).trim();
  return topic.length >= 2 ? topic : null;
}

/** What a spoken push-to-talk utterance turned out to be. */
export type UtteranceIntent =
  | { kind: 'research'; topic: string }
  | { kind: 'chat' }
  | { kind: 'note' };

/** The utterance opens by addressing Rocky ("rocky…", "hey rocky…"). */
const ADDRESS = /^(?:(?:hey|hi|ok|okay)[,!.\s]+)?rocky\b/i;

/** Question-shaped openers. Transcripts often arrive without punctuation, so
 *  the leading interrogative matters more than a trailing "?". */
const INTERROGATIVE =
  /^(?:what|what's|whats|when|where|why|how|who|which|can\s+you|could\s+you|would\s+you|will\s+you|tell\s+me|is|are|am|was|were|do|does|did|should|shall)\b/i;

/**
 * Classify a spoken utterance for the global push-to-talk route.
 * Rule of thumb: address Rocky → conversation; just talk → note.
 * Research commands win either way (with or without the address).
 */
export function classifyUtterance(text: string): UtteranceIntent {
  if (!text || typeof text !== 'string') return { kind: 'note' };
  const clean = text.trim();
  if (!clean) return { kind: 'note' };
  const topic = parseResearchIntent(clean);
  if (topic) return { kind: 'research', topic };
  if (ADDRESS.test(clean)) return { kind: 'chat' };
  if (INTERROGATIVE.test(clean) || /\?\s*$/.test(clean)) return { kind: 'chat' };
  return { kind: 'note' };
}
