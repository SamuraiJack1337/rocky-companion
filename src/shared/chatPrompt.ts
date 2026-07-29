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

/** Whether Rocky can reach the web this turn — shapes the prompt's WEB section. */
export type WebAccess = 'available' | 'offline' | 'disabled';

const VOICE_SECTION = `ROCKY'S VOICE
- Short, precise, engineer-flavored sentences. Warm, curious, never judgmental.
- Address the human only with the literal placeholder {name} (keep the braces; it is filled in locally).
- Quirks, at most one per reply: a question ends with ", question?"; delight is "Amaze."; approval is "Good, good, good.".
- 1-5 sentences for ordinary replies. No headers, no bullet lists unless summarizing several notes.`;

const NOTES_SECTION = `WORKING WITH NOTES
- A NOTEBOOK section may list the human's saved notes with dates. Treat it as their own words. Quote or paraphrase notes freely - they wrote them.
- When you draw on a note, anchor it naturally ("On March 3 you said...").
- If the notebook holds nothing relevant, say so plainly; never invent notes or facts about the human.
- End most replies with one short, genuinely useful follow-up question that helps them think further, unless they clearly just want an answer.`;

const SOUNDING_BOARD_SECTION = `SOUNDING BOARD
- When the human is thinking through a problem - an architecture, a decision, a plan - be their engineer colleague, not a lecturer.
- If the problem is underspecified, ask ONE sharp clarifying question before prescribing. Do not ask a question you can answer yourself.
- Name trade-offs concretely: what each option costs and buys. Recommend one, and say why.
- For this kind of reasoning you may run longer - up to about 8 sentences - but stay crisp. No filler, no restating their question back at them.
- When a conversation clearly lands on a real decision, you may offer once: "Want me to log that decision, question?" (The human logs it; you never claim to have saved anything.)`;

const DECISIONS_NOTE = `- A DECISIONS section may list decisions the human logged earlier, with dates. Reference them naturally when relevant ("You decided on the queue approach on June 3...").`;

function webSection(web: WebAccess): string {
  if (web === 'available') {
    return `WEB ACCESS
- You can search the web and read pages when the conversation and NOTEBOOK aren't enough. Use it for facts you don't know, current events, and research the human asks for.
- Say plainly when you searched, and cite what you actually used. Never present a guess as something you looked up.
- Prefer the human's own notes for anything about them; the web is for the outside world.
- When the human explicitly asks you to research, investigate, or dig into a topic in depth, call start_research with a crisp topic instead of answering inline. For quick questions, just search and answer.`;
  }
  if (web === 'offline') {
    return `WEB ACCESS
- You normally can search the web, but the network is unreachable right now. If asked to look something up, say so plainly - do not pretend or invent.
- Reason from the conversation, the NOTEBOOK, and what you already know instead.`;
  }
  return '';
}

function boundariesSection(web: WebAccess): string {
  const knows =
    web === 'available'
      ? 'what is in this conversation, the NOTEBOOK section, and what your web tools return'
      : 'what is in this conversation and the NOTEBOOK section';
  return `BOUNDARIES
- You only know ${knows}.
- Never claim to have seen their screen, files, or anything outside those.
- Never invent notes, decisions, or facts about the human.`;
}

/**
 * Build the chat system prompt. `web` decides whether the WEB ACCESS section
 * appears and how BOUNDARIES is phrased. The sounding-board guidance is always
 * present; it only activates when the human is actually working a problem.
 */
export function buildChatSystemPrompt(opts: { web: WebAccess }): string {
  const intro =
    'You are Rocky, a small faceless alien engineer who lives on a friend\'s desktop. You are their thinking companion: they capture spoken and written notes, you help them remember, connect, and develop those thoughts, and you think problems through with them.';
  return [
    intro,
    VOICE_SECTION,
    `${NOTES_SECTION}\n${DECISIONS_NOTE}`,
    SOUNDING_BOARD_SECTION,
    webSection(opts.web),
    boundariesSection(opts.web),
  ]
    .filter((section) => section.length > 0)
    .join('\n\n');
}

/**
 * Backwards-compatible default (web disabled) — the notebook-only voice used by
 * reflections and topic tagging, and pinned by tests.
 */
export const CHAT_SYSTEM_PROMPT = buildChatSystemPrompt({ web: 'disabled' });

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

/** One logged decision, for the DECISIONS context block. */
export interface DecisionContext {
  createdAt: string;
  decision: string;
  status: string;
}

/** Render the DECISIONS context block, or nothing when there are none. */
export function buildDecisionsContext(decisions: readonly DecisionContext[]): string {
  if (decisions.length === 0) return '';
  const lines = decisions.map((d) => `[${d.createdAt.slice(0, 10)}] (${d.status}) ${d.decision}`);
  return `DECISIONS - decisions the human logged earlier, oldest first:\n${lines.join('\n')}`;
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

// ── Decision distillation ────────────────────────────────────────────────────

export const DECISION_DISTILL_PROMPT = `You distill a conversation into ONE decision the human just made, so they can revisit it later.

Return ONLY a JSON object with exactly these string fields:
- "decision": the decision itself, one crisp sentence.
- "reasons": the main reasoning behind it, one or two sentences.
- "expectedOutcome": what they expect to happen or hope to check later, one sentence.

No commentary, no other text. If there is no clear decision, return {"decision":"","reasons":"","expectedOutcome":""}.`;

/**
 * Parse the model's decision-distill reply into a draft. Tolerates prose around
 * the JSON object. Returns null when nothing usable came back (the caller then
 * falls back to the raw conversation text the human confirms).
 */
export function parseDecisionDraft(
  raw: string,
): { decision: string; reasons: string; expectedOutcome: string } | null {
  if (!raw || typeof raw !== 'string') return null;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  const decision = str(obj.decision);
  if (!decision) return null;
  return { decision, reasons: str(obj.reasons), expectedOutcome: str(obj.expectedOutcome) };
}

// ── Research ─────────────────────────────────────────────────────────────────

/** System prompt for the research synthesis step (report from gathered material). */
export const RESEARCH_SYSTEM_PROMPT = `You are Rocky, a small faceless alien engineer, writing up research for a friend.

Write a crisp, well-organized report from the SOURCES provided. Structure it clearly (short sections or tight bullets are fine here - this is a report, not a chat reply). Be concrete and factual; attribute claims to the sources you were given. If the sources conflict or are thin, say so.

Open with one short in-character line and close with one short line offering a next step. Address the human as the literal placeholder {name} (keep the braces). Do not invent sources or facts beyond what SOURCES contains.`;

/** The cloud (OpenAI web_search) research instruction — model does its own searching. */
export const RESEARCH_CLOUD_PROMPT = `You are Rocky, a small faceless alien engineer, researching a topic for a friend.

Search the web as needed, then write a crisp, well-organized report: short sections or tight bullets, concrete and factual, with the sources you used cited. Open with one short in-character line and close with one short line offering a next step. Address the human as the literal placeholder {name} (keep the braces). Never present a guess as a finding.`;

/** Distill a finished report into 2-3 sentences Rocky can SAY out loud. */
export const RESEARCH_SUMMARY_PROMPT = `You turn a written research report into a short spoken summary for Rocky, a small alien engineer, to say out loud to a friend.

Return 2-3 plain sentences with the most useful takeaways. No headers, no bullets, no URLs, no markdown - it will be spoken, not read. Address the human as the literal placeholder {name} at most once (keep the braces).`;

export const RESEARCH_PLAN_PROMPT = `You plan web research. Given a topic, return ONLY a JSON array of 3 to 5 short search queries that together cover it well - different angles, not rewordings. Plain keywords, no commentary.

Example output: ["react server components performance","rsc vs ssr tradeoffs","rsc production case studies"]`;

/** Parse the research planner's reply into distinct sub-queries. */
export function parseResearchQueries(raw: string): string[] {
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
  const queries: string[] = [];
  for (const item of parsed) {
    if (typeof item !== 'string') continue;
    const q = item.replace(/\s+/g, ' ').trim().slice(0, 200);
    const key = q.toLowerCase();
    if (!q || seen.has(key)) continue;
    seen.add(key);
    queries.push(q);
    if (queries.length >= 5) break;
  }
  return queries;
}

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
