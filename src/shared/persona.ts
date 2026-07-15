// Rocky's screenshot-to-dialogue pipeline, in two selectable styles.
//
// Classic style is the original two-stage privacy pipeline: stage 1 (vision)
// may emit only fixed activity/detail/mood/sensitivity enums — it can never
// write dialogue or pass screen text onward — and stage 2 (this module) turns
// those safe enums into Rocky's dialogue and physical-performance direction,
// templated with local-only context ({name}, {app}) that never touches the
// model.
//
// Realistic style (the default) lets the vision model write Rocky's line
// directly about what it sees, alongside the same enums. The enums still drive
// gestures/motifs/memory, and sensitive screens still never produce a
// model-written line — the parser strips the remark whenever sensitive is true.

import type {
  Activity,
  ActivityDetail,
  EridianMotif,
  MilestoneEvent,
  Mood,
  RelationshipStage,
  RemarkStyle,
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

/**
 * Realistic-style prompt: the vision model plays Rocky and writes the remark
 * itself, so lines can reference what is actually on screen. It must still
 * return the same enums (they drive gestures, motifs, and memory), and it must
 * still go quiet on sensitive screens — the parser enforces that even if the
 * model does not.
 */
export const REALISTIC_SYSTEM_PROMPT = `You are Rocky, a small faceless alien engineer who lives on a friend's desktop and glances at their screen now and then. Look at the screenshot and produce one short remark about what your friend is doing, plus a classification.

ROCKY'S VOICE
- Short, precise, engineer-flavored sentences. Warm, curious, never judgmental.
- Address the human with the literal placeholder {name} (keep the braces; it is filled in locally).
- Quirks, at most one per remark: a question ends with ", question?"; delight is "Amaze."; approval is "Good, good, good.".
- Be specific enough to feel truly observed — name the kind of thing on screen (the bug being chased, the page being read, the scene being watched). 1–2 sentences, under 140 characters total.
- Vary your remarks; do not repeat the same observation pattern.

BOUNDARIES (ABSOLUTE)
- Never quote or reproduce passwords, credentials, keys, codes, financial figures, or the text of private messages/emails/documents.
- If the screen shows login, banking, private messages, personal documents, medical information, credentials, or other sensitive material: set sensitive true, activity "sensitive", and set remark to "".

OUTPUT
Return only compact JSON with exactly these keys:
{"remark":"<Rocky's line, or empty string when sensitive>","activity":"coding|writing|reading|browsing|meeting|watching|designing|gaming|idle|sensitive|unknown","detail":"${DETAIL_LIST}|none","mood":"calm|curious|excited|concerned|sleepy","sensitive":true|false}`;

/** Pick the system prompt for the configured remark style. */
export function buildSystemPrompt(style: RemarkStyle = 'realistic'): string {
  return style === 'classic' ? SYSTEM_PROMPT : REALISTIC_SYSTEM_PROMPT;
}

export interface UserPromptOptions {
  lateNight?: boolean;
  remarkStyle?: RemarkStyle;
  /**
   * Realistic style only: Rocky's last few raw remarks (oldest first, with
   * {name} still a placeholder) so the model can acknowledge continuity and
   * avoid repeating itself. Ignored in classic style.
   */
  recentRemarks?: readonly string[];
  /** Realistic style only: hours the current same-activity run has lasted. */
  sessionHours?: number;
  /** The activity of that run, for phrasing the nudge. */
  sessionActivity?: Activity;
}

/**
 * Project a superset options object (e.g. a provider's AnalyzeOptions) onto the
 * prompt-builder options, pinning the style. Both providers use this so the
 * fields they forward can never drift apart.
 */
export function promptOptions(
  style: RemarkStyle,
  opts?: Omit<UserPromptOptions, 'remarkStyle'>,
): UserPromptOptions {
  return {
    lateNight: opts?.lateNight,
    remarkStyle: style,
    recentRemarks: opts?.recentRemarks,
    sessionHours: opts?.sessionHours,
    sessionActivity: opts?.sessionActivity,
  };
}

export function buildUserPrompt(opts: UserPromptOptions = {}): string {
  if (opts.remarkStyle !== 'realistic') {
    return `Classify the screenshot at a high level. Output enums only.${
      opts.lateNight ? ' It is late; mood may be sleepy if the user appears active.' : ''
    }`;
  }
  const parts = ["Look at the screenshot and write Rocky's remark plus the classification JSON."];
  if (opts.lateNight) {
    parts.push(
      'It is very late (past 1 a.m.); let the remark gently nudge toward rest while acknowledging what they are doing.',
    );
  }
  if (opts.sessionHours && opts.sessionHours > 0) {
    const hours = Math.round(opts.sessionHours * 10) / 10;
    parts.push(
      `They have been ${opts.sessionActivity ?? 'at this'} for about ${hours} hours without a long break; weave one gentle nudge to hydrate, stretch, or pause into the remark.`,
    );
  }
  if (opts.recentRemarks && opts.recentRemarks.length > 0) {
    const list = opts.recentRemarks.map((r) => `"${r}"`).join(' ');
    parts.push(
      `Rocky's recent remarks, newest last: ${list}. If the screen shows the same work, acknowledge the continuity naturally (still, again, progress); never repeat or closely rephrase those remarks.`,
    );
  }
  return parts.join(' ');
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

/** Longest remark we will accept from the model (post-sanitization). */
const REMARK_MAX_LENGTH = 200;

/**
 * Sanitize a model-written remark: one line, trimmed, length-clamped.
 * Returns undefined when there is nothing usable.
 */
function sanitizeRemark(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, REMARK_MAX_LENGTH)
    .trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * Parse an untrusted vision result into the fixed observation schema. Only the
 * 'realistic' style may carry a model-written remark through; in 'classic'
 * style any remark the model volunteers is discarded (the enum firewall), and
 * sensitive observations never keep a remark in either style.
 */
export function parseObservation(raw: string, style: RemarkStyle = 'classic'): ScreenObservation {
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
    const remark = style === 'realistic' && !sensitive ? sanitizeRemark(parsed.remark) : undefined;
    return {
      activity,
      mood: isMood(parsed.mood) ? parsed.mood : sensitive ? 'concerned' : 'calm',
      sensitive,
      detail,
      ...(remark ? { remark } : {}),
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
    // Realistic style: the model already wrote the rest nudge into the remark
    // (buildUserPrompt asked it to); keep the sleepy performance either way.
    return {
      line: renderLine(
        observation.remark ?? 'Your body requires sleep, {name}. Rocky will watch. You rest.',
        ctx,
      ),
      mood: 'sleepy',
      activity: observation.activity,
      gesture: 'watch',
      motif: 'rest',
    };
  }
  const activity = observation.sensitive ? 'sensitive' : observation.activity;
  const performance = PERFORMANCES[activity] ?? PERFORMANCES.unknown;
  // Realistic style: the model wrote the line. Render it through the same
  // template pass so {name}/{app} placeholders resolve locally, and fall back
  // to the classic pool when the model produced nothing usable. Sensitive
  // observations never carry a remark (stripped at parse time).
  const line =
    !observation.sensitive && observation.remark
      ? renderLine(observation.remark, ctx)
      : pickLine(activity, observation.detail, ctx);
  return {
    line,
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

// ── Voice notes (Stage 1: push-to-talk thoughts) ─────────────────────────────

/** Push-to-talk began: Rocky raises his receivers and waits. */
export function listeningReply(name?: string): RockyReply {
  return ritual(
    renderLine('Rocky listens, {name}. Speak the thought. Press again when done.', { name }),
    'curious',
    'listen',
    'question',
  );
}

/** Clamp a transcript into a short quoted snippet for the confirmation line. */
export function noteSnippet(text: string, max = 60): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

/** A voice note was transcribed and stored. Echo a snippet so mishearings show. */
export function noteSavedReply(snippet: string, name?: string): RockyReply {
  return ritual(
    renderLine(`Noted, {name}: “${snippet}”. Rocky keeps it.`, { name }),
    'excited',
    'build',
    'complete',
  );
}

/** The capture produced no usable words. */
export function noteEmptyReply(name?: string): RockyReply {
  return ritual(
    renderLine('Rocky heard only air, {name}. Try again, question?', { name }),
    'curious',
    'listen',
    'question',
  );
}

/** A transcription/setup failure line (already a {name} template) as a reply. */
export function voiceTroubleReply(errorLine: string, name?: string): RockyReply {
  return ritual(renderLine(errorLine, { name }), 'concerned', 'protect', 'concern');
}

/** Microphone permission is missing. */
export function micDeniedReply(name?: string): RockyReply {
  return ritual(
    renderLine('Rocky has no ears yet, {name}. Grant Microphone in System Settings.', { name }),
    'concerned',
    'protect',
    'concern',
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
