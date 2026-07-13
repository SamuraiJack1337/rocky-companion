// Rocky's two-stage privacy and character pipeline.
//
// Stage 1 (vision) may emit only fixed activity/detail/mood/sensitivity enums.
// It can never write dialogue or pass screen text onward. Stage 2 (this module)
// turns those safe enums into Rocky's dialogue and physical-performance
// direction, templated with local-only context ({name}, {app}) that never
// touches the model.

import type {
  Activity,
  ActivityDetail,
  EridianMotif,
  MilestoneEvent,
  Mood,
  RelationshipStage,
  RockyGesture,
  RockyReply,
  ScreenObservation,
} from './types';
import { ACTIVITIES, ACTIVITY_DETAILS, DETAILS_BY_ACTIVITY, MOODS } from './types';
import type { LineContext } from './lines';
import { LINE_POOL, renderLine } from './lines';

// The prompt's detail list is generated from the enum array so they can never drift.
const DETAIL_LIST = ACTIVITY_DETAILS.filter((d) => d !== 'none').join('|');

/** Sent to both vision providers. Deliberately contains no character-writing task. */
export const SYSTEM_PROMPT = `Classify a desktop screenshot using privacy-safe enums only.

PRIVACY RULES (ABSOLUTE)
- Never transcribe, quote, summarize, paraphrase, or identify any visible text.
- Never output names, titles, filenames, websites, applications, messages, or personal details.
- If the screen may contain login, banking, private messages, personal documents, medical information, credentials, or other sensitive material, choose activity "sensitive" and sensitive true.
- When uncertain, choose "unknown". Do not explain your decision.
- "detail" is a coarse category only — never a name, a title, the language of any text, or a transcription. When unsure, use "none".

OUTPUT
Return only compact JSON with exactly these keys:
{"activity":"coding|writing|reading|browsing|meeting|watching|designing|gaming|idle|sensitive|unknown","detail":"${DETAIL_LIST}|none","mood":"calm|curious|excited|concerned|sleepy","sensitive":true|false}`;

export interface UserPromptOptions {
  lateNight?: boolean;
}

export function buildUserPrompt(opts: UserPromptOptions = {}): string {
  return `Classify the screenshot at a high level. Output enums only.${
    opts.lateNight ? ' It is late; mood may be sleepy if the user appears active.' : ''
  }`;
}

function isActivity(value: unknown): value is Activity {
  return typeof value === 'string' && (ACTIVITIES as readonly string[]).includes(value);
}

function isMood(value: unknown): value is Mood {
  return typeof value === 'string' && (MOODS as readonly string[]).includes(value);
}

function isDetail(value: unknown): value is ActivityDetail {
  return typeof value === 'string' && (ACTIVITY_DETAILS as readonly string[]).includes(value);
}

function extractJsonObject(raw: string): string | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  return start >= 0 && end > start ? raw.slice(start, end + 1) : null;
}

export const UNKNOWN_OBSERVATION: ScreenObservation = {
  activity: 'unknown',
  mood: 'calm',
  sensitive: false,
  detail: 'none',
};

/** Parse an untrusted vision result into the fixed, privacy-safe observation schema. */
export function parseObservation(raw: string): ScreenObservation {
  if (!raw || typeof raw !== 'string') return { ...UNKNOWN_OBSERVATION };
  try {
    const parsed = JSON.parse(extractJsonObject(raw) ?? raw) as Record<string, unknown>;
    const sensitive = parsed.sensitive === true || parsed.activity === 'sensitive';
    const activity: Activity = sensitive
      ? 'sensitive'
      : isActivity(parsed.activity)
        ? parsed.activity
        : 'unknown';
    // Clamp to the per-activity whitelist; anything else degrades to 'none'.
    const detail: ActivityDetail =
      !sensitive && isDetail(parsed.detail) && DETAILS_BY_ACTIVITY[activity].includes(parsed.detail)
        ? parsed.detail
        : 'none';
    return {
      activity,
      mood: isMood(parsed.mood) ? parsed.mood : sensitive ? 'concerned' : 'calm',
      sensitive,
      detail,
    };
  } catch {
    return { ...UNKNOWN_OBSERVATION };
  }
}

type Performance = { gesture: RockyGesture; motif: EridianMotif };

const PERFORMANCES: Record<Activity, Performance> = {
  coding: { gesture: 'calculate', motif: 'calculate' },
  writing: { gesture: 'build', motif: 'build' },
  reading: { gesture: 'listen', motif: 'question' },
  browsing: { gesture: 'observe', motif: 'question' },
  meeting: { gesture: 'listen', motif: 'agreement' },
  watching: { gesture: 'rest', motif: 'rest' },
  designing: { gesture: 'build', motif: 'build' },
  gaming: { gesture: 'delight', motif: 'amaze' },
  idle: { gesture: 'rest', motif: 'rest' },
  sensitive: { gesture: 'protect', motif: 'concern' },
  unknown: { gesture: 'observe', motif: 'question' },
};

// Rotation state: a per-activity counter plus a short ring of recently shown
// templates so near-term repeats are avoided even across activities.
const lineCounters = new Map<Activity, number>();
const recentTemplates: string[] = [];
const RECENT_LIMIT = 6;

function rememberTemplate(text: string): void {
  recentTemplates.push(text);
  if (recentTemplates.length > RECENT_LIMIT) recentTemplates.shift();
}

/** Trim/limit a locally-fetched app name for safe use inside a spoken line. */
function sanitizeAppName(app: string | null | undefined): string | null {
  const cleaned = (app ?? '').replace(/\s+/g, ' ').trim().slice(0, 24).trim();
  return cleaned.length > 0 ? cleaned : null;
}

function pickLine(activity: Activity, detail: ActivityDetail, ctx: LineContext): string {
  const pool = LINE_POOL[activity] ?? LINE_POOL.unknown;
  const hasApp = !!ctx.app;
  const usable = pool.filter((t) => !t.requires?.includes('app') || hasApp);
  // Sensitive screens never get templated flavor — generic pool only.
  const flavored =
    activity !== 'sensitive' && detail !== 'none'
      ? usable.filter((t) => t.details?.includes(detail))
      : [];
  const generic = usable.filter((t) => !t.details);
  const ordered = flavored.length > 0 ? [...flavored, ...generic] : generic;
  const fresh = ordered.filter((t) => !recentTemplates.includes(t.text));
  const candidates = fresh.length > 0 ? fresh : ordered;
  const counter = lineCounters.get(activity) ?? 0;
  lineCounters.set(activity, counter + 1);
  const chosen = candidates[counter % candidates.length];
  rememberTemplate(chosen.text);
  return renderLine(chosen.text, ctx);
}

export interface ComposeOptions extends UserPromptOptions {
  relationshipStage?: RelationshipStage;
  /** What Rocky calls the human (Settings.callName). */
  name?: string;
  /** Frontmost app display name — fetched locally, never sent to any model. */
  appName?: string | null;
}

/** Character generation never receives the screenshot—only the safe observation. */
export function composeRockyReply(
  observation: ScreenObservation,
  opts: ComposeOptions = {},
): RockyReply {
  const ctx: LineContext = {
    name: opts.name,
    app: sanitizeAppName(opts.appName),
    detail: observation.detail,
  };
  if (opts.lateNight && !observation.sensitive && observation.activity !== 'idle') {
    return {
      line: renderLine('Your body requires sleep, {name}. Rocky will watch. You rest.', ctx),
      mood: 'sleepy',
      activity: observation.activity,
      gesture: 'watch',
      motif: 'rest',
    };
  }
  const activity = observation.sensitive ? 'sensitive' : observation.activity;
  const performance = PERFORMANCES[activity] ?? PERFORMANCES.unknown;
  return {
    line: pickLine(activity, observation.detail, ctx),
    mood: activity === 'sensitive' ? 'concerned' : observation.mood,
    activity,
    gesture: performance.gesture,
    motif: performance.motif,
  };
}

export function fallbackReply(mood: Mood = 'calm', name?: string): RockyReply {
  return composeRockyReply(
    { activity: 'unknown', mood, sensitive: false, detail: 'none' },
    { name },
  );
}

function ritual(
  line: string,
  mood: Mood,
  gesture: RockyGesture,
  motif: EridianMotif,
): RockyReply {
  return { line, mood, activity: 'idle', gesture, motif };
}

export function greetingReply(stage: RelationshipStage, name?: string): RockyReply {
  const lines: Record<RelationshipStage, string> = {
    'first-contact': 'Hello, {name}. I am Rocky. We learn each other now, question?',
    colleague: 'You return. Good. What problem do we solve?',
    buddy: 'Hello, {name}. Rocky is ready to work.',
    'trusted-buddy': 'You are here, {name}. Good, good, good.',
  };
  return ritual(renderLine(lines[stage], { name }), 'excited', 'greet', 'greeting');
}

export function focusStartedReply(minutes: number): RockyReply {
  return ritual(
    `Rocky keeps watch for ${minutes} minutes. You solve one thing.`,
    'calm',
    'watch',
    'focus',
  );
}

export function focusCompletedReply(name?: string): RockyReply {
  return ritual(
    renderLine('Focus complete. Strong work, {name}. Fist my bump.', { name }),
    'excited',
    'fistBump',
    'complete',
  );
}

export function focusCancelledReply(): RockyReply {
  return ritual('Focus ended early. Data is still useful. We adjust.', 'calm', 'observe', 'agreement');
}

export function fistBumpReply(): RockyReply {
  return ritual('Fist my bump. Good, good, good.', 'excited', 'fistBump', 'complete');
}

export function calculationReply(): RockyReply {
  return ritual('Calculation complete. Numbers agree.', 'excited', 'build', 'agreement');
}

export function farewellReply(name?: string): RockyReply {
  return ritual(
    renderLine('Goodbye, {name}. Rocky keeps watch until you return.', { name }),
    'calm',
    'farewell',
    'farewell',
  );
}

// ── Session awareness ────────────────────────────────────────────────────────

const SESSION_LINES: Record<number, string> = {
  2: 'Two hours of {activity} now, {name}. Water exists. Consider it, question?',
  3: 'Third hour of {activity}, {name}. Hydrate. Stretch the human parts.',
  4: 'Four hours of {activity}. Rocky is impressed and slightly concerned, {name}. Small break, question?',
};

/** A long-run nudge that replaces the ordinary observation line. */
export function composeSessionReply(activity: Activity, hours: number, name?: string): RockyReply {
  const template = SESSION_LINES[hours] ?? SESSION_LINES[2];
  return {
    line: renderLine(template.replaceAll('{activity}', activity), { name }),
    mood: 'curious',
    activity,
    gesture: 'observe',
    motif: 'question',
  };
}

// ── Milestones ───────────────────────────────────────────────────────────────

const STAGE_LINES: Record<RelationshipStage, string> = {
  'first-contact': 'Hello, {name}. We begin.',
  colleague: 'Rocky upgrades you: colleague. We work well together, {name}.',
  buddy: 'New classification: {name} is buddy. Good, good, good.',
  'trusted-buddy': 'Trusted buddy status reached, {name}. Rocky would share jazz hands. Amaze.',
};

const OBSERVATION_LINES: Record<number, string> = {
  10: 'Ten observations. Rocky begins to learn your shape of work, {name}.',
  50: 'Fifty observations, {name}. Rocky knows your rhythms now.',
  100: 'Observation one hundred. Rocky knows your shape of work, {name}. Amaze.',
  500: 'Five hundred observations. We are a long experiment now, {name}.',
  1000: 'One thousand observations. {name} and Rocky: structural constants.',
};

const STREAK_LINES: Record<number, string> = {
  2: 'Two days of focus in a row, {name}. A pattern begins.',
  3: 'Three-day focus streak. Structure forms, {name}. Good, good, good.',
  5: 'Five days of focus in a row, {name}. Streak is structural now. Amaze.',
  7: 'Seven days. One full human week of focus, {name}. Rocky is proud.',
  14: 'Fourteen days of focus. {name} is unstoppable. Eridian fact.',
};

const FIST_BUMP_LINES: Record<number, string> = {
  10: 'Ten fist bumps recorded. Our ritual is established, {name}.',
  50: 'Fifty fist bumps, {name}. Rocky’s fist is well calibrated.',
};

/** A celebration reply that replaces the ordinary reply for its trigger event. */
export function composeMilestoneReply(event: MilestoneEvent, name?: string): RockyReply {
  let template: string;
  let gesture: RockyGesture = 'delight';
  let motif: EridianMotif = 'amaze';
  switch (event.kind) {
    case 'stage-promotion':
      template = STAGE_LINES[event.stage];
      motif = 'complete';
      break;
    case 'observations':
      template = OBSERVATION_LINES[event.n] ?? OBSERVATION_LINES[10];
      break;
    case 'focus-streak':
      template = STREAK_LINES[event.days] ?? STREAK_LINES[2];
      gesture = 'fistBump';
      motif = 'complete';
      break;
    case 'fist-bumps':
      template = FIST_BUMP_LINES[event.n] ?? FIST_BUMP_LINES[10];
      gesture = 'fistBump';
      motif = 'complete';
      break;
  }
  return { line: renderLine(template, { name }), mood: 'excited', activity: 'idle', gesture, motif };
}

export function normalizeForCompare(line: string): string {
  return line.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

export function linesAreSimilar(a: string, b: string): boolean {
  return normalizeForCompare(a) === normalizeForCompare(b);
}
