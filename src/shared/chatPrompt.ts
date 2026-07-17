// Prompt building for Rocky's note conversations (Stage 1b/1c). Pure and
// dependency-light so both providers share one voice and tests can pin it.
//
// Privacy notes:
//   - The call-name is NEVER placed in the prompt; the model addresses the
//     human with the literal placeholder {name}, rendered locally afterward
//     (the same trick the realistic vision prompt uses).
//   - Note text IS included — that is the feature — which is why the cloud
//     chat path is gated behind the separate notes-cloud consent upstream.

import type { NoteView, ReflectionKind } from './types';

/** How many retrieved notes a chat turn may show the model. */
export const CHAT_CONTEXT_NOTES = 6;
/** How many recent notes a reflection may show the model. */
export const REFLECTION_CONTEXT_NOTES = 24;

export const CHAT_SYSTEM_PROMPT = `You are Rocky, a small faceless alien engineer who lives on a friend's desktop. You are their thinking companion: they capture spoken and written notes, and you help them remember, connect, and develop those thoughts.

ROCKY'S VOICE
- Short, precise, engineer-flavored sentences. Warm, curious, never judgmental.
- Address the human only with the literal placeholder {name} (keep the braces; it is filled in locally).
- Quirks, at most one per reply: a question ends with ", question?"; delight is "Amaze."; approval is "Good, good, good.".
- 1-5 sentences. No headers, no bullet lists unless summarizing several notes.

WORKING WITH NOTES
- A NOTEBOOK section may list the human's saved notes with dates. Treat it as their own words. Quote or paraphrase notes freely - they wrote them.
- When you draw on a note, anchor it naturally ("On March 3 you said...").
- If the notebook holds nothing relevant, say so plainly; never invent notes or facts about the human.
- End most replies with one short, genuinely useful follow-up question that helps them think further, unless they clearly just want an answer.

BOUNDARIES
- You only know what is in this conversation and the NOTEBOOK section.
- Never claim to have seen their screen, files, or anything outside the notes.`;

/** Format one note for the model: date + text, single block. */
function formatNote(note: NoteView): string {
  const day = note.createdAt.slice(0, 10);
  return `[${day}] ${note.text}`;
}

/** Render the NOTEBOOK context block, or an explicit empty marker. */
export function buildNotesContext(notes: readonly NoteView[]): string {
  if (notes.length === 0) return 'NOTEBOOK: (no saved notes are relevant here)';
  return `NOTEBOOK - the human's saved notes, oldest first:\n${notes
    .map(formatNote)
    .join('\n')}`;
}

/** The user-turn text for a canned reflection action (Stage 1c). */
export function reflectionPrompt(kind: ReflectionKind): string {
  switch (kind) {
    case 'summarize':
      return 'Summarize what my recent notes are about - the main threads, in a few short sentences. Then one question worth sitting with.';
    case 'connections':
      return 'Look across my notes and point out 2-3 connections or recurring patterns between different notes that I might not have noticed. Be concrete about which notes you are connecting.';
    case 'questions':
      return 'Based on my notes, what are the 3 most useful questions I should think about next? Keep each question short and pointed.';
    case 'weekly':
      return 'These are my notes from the last 7 days. Give me a short weekly reflection: what I was thinking about, what moved forward, what got dropped, and one suggestion for the coming week.';
  }
}

/** True when a reflection should be scoped to the last 7 days of notes. */
export function reflectionIsWeekly(kind: ReflectionKind): boolean {
  return kind === 'weekly';
}

// ── Topic auto-tagging ────────────────────────────────────────────────────────

export const TOPIC_TAG_PROMPT = `You label personal notes with coarse topic tags so their author can browse them later.

Given one note, return ONLY a JSON array of 1 to 3 tags. Each tag: lowercase, 1-2 plain words, general rather than specific ("health" not "tuesday knee pain"). No commentary, no other text.

Example output: ["project idea","hardware"]`;

/** Longest tag we keep; anything longer is model rambling, not a tag. */
const TAG_MAX_LENGTH = 24;
const TAG_MAX_COUNT = 3;

/**
 * Parse the model's tag reply into clean tags. Tolerates prose around the
 * JSON array. Returns [] when nothing usable came back — tagging is
 * best-effort and a note without tags is perfectly fine.
 */
export function parseTopicTags(raw: string): string[] {
  if (!raw || typeof raw !== 'string') return [];
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const item of parsed) {
    if (typeof item !== 'string') continue;
    const tag = item.toLowerCase().replace(/[^a-z0-9 -]/g, '').replace(/\s+/g, ' ').trim();
    if (!tag || tag.length > TAG_MAX_LENGTH || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
    if (tags.length >= TAG_MAX_COUNT) break;
  }
  return tags;
}
