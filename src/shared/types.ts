// Shared types used across the main process, preload bridge, and renderer.
// This file is the single source of truth for the data contract. Both
// providers, the scheduler, the settings UI, and the creature renderer all
// import from here. Keep it dependency-free so any surface can use it.

/** Rocky's emotional register, drives both animation and tone-voice. */
export type Mood = 'calm' | 'curious' | 'excited' | 'concerned' | 'sleepy';

export const MOODS: readonly Mood[] = ['calm', 'curious', 'excited', 'concerned', 'sleepy'];

/** Privacy-safe activity categories emitted by vision. No screen text crosses this boundary. */
export type Activity =
  | 'coding'
  | 'writing'
  | 'reading'
  | 'browsing'
  | 'meeting'
  | 'watching'
  | 'designing'
  | 'gaming'
  | 'idle'
  | 'sensitive'
  | 'unknown';

export const ACTIVITIES: readonly Activity[] = [
  'coding', 'writing', 'reading', 'browsing', 'meeting', 'watching',
  'designing', 'gaming', 'idle', 'sensitive', 'unknown',
];

/**
 * A deliberately coarse second axis for an observation. Categories only —
 * never a language name, topic, filename, or anything derived from screen
 * text. 'none' is always safe and is forced whenever sensitive is true.
 */
export type ActivityDetail =
  | 'none'
  // coding
  | 'frontend' | 'backend' | 'scripting' | 'data' | 'terminal' | 'debugging' | 'code-review'
  // writing
  | 'docs' | 'email' | 'chat-message' | 'notes' | 'longform'
  // reading / browsing
  | 'reference' | 'news' | 'social' | 'shopping' | 'forum'
  // meeting
  | 'video-call' | 'presentation'
  // watching
  | 'film-video' | 'live-stream'
  // designing
  | 'ui-design' | 'graphics' | 'diagram' | 'three-d'
  // gaming
  | 'action-game' | 'strategy-game' | 'puzzle-game';

export const ACTIVITY_DETAILS: readonly ActivityDetail[] = [
  'none',
  'frontend', 'backend', 'scripting', 'data', 'terminal', 'debugging', 'code-review',
  'docs', 'email', 'chat-message', 'notes', 'longform',
  'reference', 'news', 'social', 'shopping', 'forum',
  'video-call', 'presentation',
  'film-video', 'live-stream',
  'ui-design', 'graphics', 'diagram', 'three-d',
  'action-game', 'strategy-game', 'puzzle-game',
];

const BROWSING_DETAILS: readonly ActivityDetail[] = ['reference', 'news', 'social', 'shopping', 'forum'];

/** Which details are legal for which activity — the parse-time validation clamp. */
export const DETAILS_BY_ACTIVITY: Record<Activity, readonly ActivityDetail[]> = {
  coding: ['frontend', 'backend', 'scripting', 'data', 'terminal', 'debugging', 'code-review'],
  writing: ['docs', 'email', 'chat-message', 'notes', 'longform'],
  reading: BROWSING_DETAILS,
  browsing: BROWSING_DETAILS,
  meeting: ['video-call', 'presentation'],
  watching: ['film-video', 'live-stream'],
  designing: ['ui-design', 'graphics', 'diagram', 'three-d'],
  gaming: ['action-game', 'strategy-game', 'puzzle-game'],
  idle: [],
  sensitive: [],
  unknown: [],
};

/** Faceless performance vocabulary, conveyed through silhouette and timing. */
export type RockyGesture =
  | 'observe'
  | 'listen'
  | 'calculate'
  | 'build'
  | 'delight'
  | 'alarm'
  | 'protect'
  | 'rest'
  | 'greet'
  | 'fistBump'
  | 'watch'
  | 'farewell';

/** Stable musical concepts. Each maps to a repeatable five-part Eridian phrase. */
export type EridianMotif =
  | 'greeting'
  | 'agreement'
  | 'question'
  | 'calculate'
  | 'build'
  | 'amaze'
  | 'concern'
  | 'focus'
  | 'complete'
  | 'rest'
  | 'farewell';

/** The only information the vision layer may return about a screenshot. */
export interface ScreenObservation {
  activity: Activity;
  mood: Mood;
  sensitive: boolean;
  /** Coarse category flavor; 'none' whenever uncertain or sensitive. */
  detail: ActivityDetail;
  /**
   * Realistic-mode only: Rocky's line written by the vision model about what
   * is actually on screen. Absent in classic mode and always stripped when
   * sensitive is true. Sanitized (one line, length-clamped) at parse time.
   */
  remark?: string;
}

/**
 * How Rocky's screenshot remarks are produced.
 * - 'realistic': the vision model writes Rocky's line directly about what it
 *   sees, so remarks reference the actual screen content. More alive; screen
 *   specifics may appear in the spoken/displayed line.
 * - 'classic': the vision model returns only privacy-safe enums and the line
 *   comes from Rocky's built-in template pool. Strictest privacy.
 */
export type RemarkStyle = 'realistic' | 'classic';

/** Which AI backend analyzes the screenshot. Local is the private default. */
export type ProviderKind = 'local' | 'cloud';

/**
 * How Rocky's voice is produced:
 * - 'procedural': on-device Eridian musical tones (private, no network).
 * - 'offline': spoken words via the OS's built-in text-to-speech (no key,
 *   fully on-device — the right fit for the local/Ollama setup).
 * - 'openai': spoken words via OpenAI TTS (needs a key + consent).
 */
export type VoiceMode = 'procedural' | 'offline' | 'openai';

/**
 * OpenAI's built-in synthetic TTS voices. These are OpenAI's own designed
 * voices — not modeled on, and not to be used to imitate, any real person.
 */
export const TTS_VOICES: readonly string[] = [
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'fable',
  'nova',
  'onyx',
  'sage',
  'shimmer',
  'verse',
];

/**
 * Default delivery instruction for gpt-4o-mini-tts. A light, warm, friendly
 * read at a natural pace — this lifts the voice so it isn't heavy/neutral.
 * Shapes delivery STYLE only (pace, warmth, brightness), never identity.
 * Set it empty in Settings to hear the raw preset. Ignored by tts-1 / tts-1-hd.
 */
export const DEFAULT_TTS_INSTRUCTIONS =
  'Speak in a warm, friendly, lightly bright voice at a natural, slightly quicker pace. Easy and gentle, not heavy or deep. Keep the phrasing simple.';

/** TTS models selectable in Settings. */
export const TTS_MODELS: readonly string[] = ['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd'];

// ── Creature skins (drop-in art pipeline) ─────────────────────────────────────
// The built-in creature is drawn procedurally. A "skin" lets a sprite sheet or
// a set of per-mood frames replace it without code changes — drop a folder into
// userData/skins/<name>/ with a skin.json manifest and image(s). This is how
// licensed/official art (or AI-generated stills) gets swapped in.

/** Identifier for the built-in procedural creature (no asset files). */
export const PROCEDURAL_SKIN = 'procedural';

/**
 * Folder id of the official Rocky skin that ships bundled with the app (the
 * curated high-fidelity art under samples/skins/rocky-hq). On first run it is
 * seeded into userData/skins (see main/assets.ts) so a fresh install shows the
 * official creature rather than the procedural fallback.
 */
export const OFFICIAL_SKIN = 'rocky-hq';

/** Per-mood animation spec within a skin manifest. */
export interface SkinStateSpec {
  /** 'frames' type: image filenames played in order. */
  files?: string[];
  /** 'sprite' type: frame indices into the sheet, played in order. */
  frames?: number[];
  /** Loop the animation (default true). */
  loop?: boolean;
  /** Per-state frame rate override. */
  fps?: number;
}

/** A creature skin manifest (skins/<name>/skin.json). */
export interface SkinManifest {
  name: string;
  displayName?: string;
  /** 'frames' = one image per frame; 'sprite' = a single grid sheet. */
  type: 'frames' | 'sprite';
  /** Sprite-sheet filename (type 'sprite'). */
  image?: string;
  /** Sprite frame size + grid columns (type 'sprite'). */
  frameWidth?: number;
  frameHeight?: number;
  columns?: number;
  /** Default frame rate (default 8). */
  fps?: number;
  /** Animation per creature mood: idle | talk | curious | concerned | sleep. */
  states: Record<string, SkinStateSpec>;
}

/** A skin available to pick in Settings. */
export interface SkinInfo {
  name: string;
  displayName: string;
  builtIn: boolean;
}

/** A loaded skin: its manifest plus every referenced image as a data URL. */
export interface LoadedSkin {
  manifest: SkinManifest;
  /** filename -> data URL, in-memory (no file paths exposed to the renderer). */
  assets: Record<string, string>;
}

/** A single in-character reaction from Rocky. */
export interface RockyReply {
  line: string;
  mood: Mood;
  activity: Activity;
  gesture: RockyGesture;
  motif: EridianMotif;
}

export type RelationshipStage = 'first-contact' | 'colleague' | 'buddy' | 'trusted-buddy';

/** Privacy-safe relationship memory: counters, day-stamps, and timestamps only — never screen content. */
export interface CompanionMemory {
  firstSeenAt: string;
  lastSeenAt: string;
  launches: number;
  observations: number;
  focusSessionsCompleted: number;
  fistBumps: number;
  calculationsCompleted: number;
  relationshipStage: RelationshipStage;
  /** Consecutive days (local) with at least one completed focus session. */
  focusDayStreak: number;
  /** Local YYYY-MM-DD of the last completed focus session, for streak math. */
  lastFocusDayISO: string | null;
}

/** A notable moment detected by diffing CompanionMemory before/after an event. */
export type MilestoneEvent =
  | { kind: 'stage-promotion'; stage: RelationshipStage }
  | { kind: 'observations'; n: number }
  | { kind: 'focus-streak'; days: number }
  | { kind: 'fist-bumps'; n: number };

export interface FocusState {
  active: boolean;
  startedAt: string | null;
  endsAt: string | null;
  durationMinutes: number;
}

export type EngineeringRequest =
  | { kind: 'calculate'; expression: string }
  | { kind: 'convert'; value: number; from: string; to: string };

export interface EngineeringResult {
  ok: boolean;
  value?: number;
  display?: string;
  error?: string;
}

/** macOS Screen Recording permission state (mirrors systemPreferences). */
export type ScreenPermissionStatus =
  | 'granted'
  | 'denied'
  | 'restricted'
  | 'not-determined'
  | 'unknown';

/**
 * Persisted, non-secret settings. The OpenAI key is NEVER stored here — it
 * lives encrypted in the OS keychain via safeStorage (see main/keys.ts).
 */
export interface Settings {
  /** Capture cadence in minutes. Clamped to [1, 120]. */
  intervalMinutes: number;
  /**
   * When true, Rocky looks exactly every intervalMinutes: no ±20% jitter and
   * no event-driven extra glances (app switches, idle-wake). Clicking Rocky
   * and the tray's Look now still work. Default false (natural rhythm).
   */
  strictInterval: boolean;
  /** Mute the procedural tone-voice. */
  muted: boolean;
  /** Selected vision backend. Defaults to the private, on-device 'local'. */
  provider: ProviderKind;
  /** Ollama model name (local). */
  ollamaModel: string;
  /** Ollama host URL (local). */
  ollamaHost: string;
  /** OpenAI vision model name (cloud). gpt-4o is retired — use GPT-5.x. */
  openaiModel: string;
  /** How Rocky's remarks are written: model-written 'realistic' or templated 'classic'. */
  remarkStyle: RemarkStyle;
  /** Voice mode: 'procedural' musical tones (private) or 'openai' spoken TTS. */
  voiceMode: VoiceMode;
  /** OpenAI TTS voice preset (one of TTS_VOICES). */
  ttsVoice: string;
  /** OpenAI TTS model (e.g. gpt-4o-mini-tts). */
  ttsModel: string;
  /** Explicit permission to send Rocky's generated translation text to cloud TTS. */
  ttsConsentGiven: boolean;
  /** Style instruction passed to gpt-4o-mini-tts to shape delivery (not identity). */
  ttsInstructions: string;
  /** Pitch shift for the spoken voice in semitones (applied on playback). */
  voicePitch: number;
  /** Play the procedural musical tone softly under the spoken line. */
  musicUnderlay: boolean;
  /**
   * Expressive cadence: speak Rocky's line as short phrases with deliberate
   * micro-pauses and slight per-phrase pace variation (a beat before a
   * question, quicker on short affirmations) instead of one flat read.
   */
  expressiveCadence: boolean;
  /** Active creature skin: PROCEDURAL_SKIN, or a folder name under userData/skins. */
  creatureSkin: string;
  /** Frontmost macOS app names for which capture is skipped entirely. */
  blockedApps: string[];
  /** When true the window ignores mouse events so it floats over work. */
  clickThrough: boolean;
  /** When true, no captures happen and Rocky sleeps. */
  paused: boolean;
  /** What Rocky calls the human. Normalized to 1–24 chars; falls back to 'buddy'. */
  callName: string;
  /** One-time upgrade nudge about the call-name setting has been shown. */
  namePromptShown: boolean;
  /**
   * Check GitHub Releases (about once a day) for a newer version. This is the
   * app's only network call besides the chosen vision provider; it sends no
   * data beyond the HTTP request itself and can be turned off.
   */
  updateCheckEnabled: boolean;
  /** ISO timestamp of the last releases check (rate limiting). */
  lastUpdateCheckAt: string | null;
  /** Version the user said "Later" to; never re-prompted for it. */
  dismissedUpdateVersion: string | null;
  /** First-run capture consent was explicitly granted. */
  consentGiven: boolean;
  /** Separate explicit opt-in required before any screenshot leaves the device. */
  cloudConsentGiven: boolean;
  /** Last on-screen window position (persisted across launches). */
  windowPosition: { x: number; y: number } | null;
}

export const INTERVAL_MIN = 1;
export const INTERVAL_MAX = 120;

/** Interval presets surfaced in the tray submenu (minutes). */
export const INTERVAL_PRESETS: readonly number[] = [1, 5, 15, 30, 60, 120];

export const DEFAULT_SETTINGS: Settings = {
  intervalMinutes: 15,
  strictInterval: false,
  muted: false,
  provider: 'local',
  ollamaModel: 'llama3.2-vision',
  ollamaHost: 'http://localhost:11434',
  openaiModel: 'gpt-5.4-mini',
  remarkStyle: 'realistic',
  voiceMode: 'procedural',
  ttsVoice: 'echo',
  ttsModel: 'tts-1',
  ttsConsentGiven: false,
  ttsInstructions: DEFAULT_TTS_INSTRUCTIONS,
  voicePitch: 0,
  musicUnderlay: true,
  expressiveCadence: true,
  // Fresh installs show the bundled official skin (seeded into userData/skins on
  // first run). If that art is ever missing, the renderer falls back to the
  // procedural creature, so this is always safe.
  creatureSkin: OFFICIAL_SKIN,
  blockedApps: [],
  clickThrough: false,
  paused: false,
  callName: 'buddy',
  namePromptShown: false,
  updateCheckEnabled: true,
  lastUpdateCheckAt: null,
  dismissedUpdateVersion: null,
  consentGiven: false,
  cloudConsentGiven: false,
  windowPosition: null,
};

/** Result of probing the local Ollama server. */
export interface OllamaStatus {
  reachable: boolean;
  modelAvailable: boolean;
  models: string[];
  /** Whether a warmup generation actually ran within the timeout. undefined
   *  when no warmup was requested; false when the model failed to respond in
   *  time (this is the state a user hits when Settings "verifies" but the app
   *  then reads "not connected"). */
  modelResponsive?: boolean;
  /** Rough wall-clock of the warmup generation (ms), for honest UI messaging. */
  warmupMs?: number;
  error?: string;
}

/** Result of attempting to store/validate a cloud key. */
export interface KeyResult {
  ok: boolean;
  error?: string;
}

/** Lightweight runtime state mirrored to the companion window. */
export interface RockyState {
  paused: boolean;
  muted: boolean;
}

/** Clamp an interval value into the allowed range. */
export function clampInterval(minutes: number): number {
  if (!Number.isFinite(minutes)) return DEFAULT_SETTINGS.intervalMinutes;
  return Math.min(INTERVAL_MAX, Math.max(INTERVAL_MIN, Math.round(minutes)));
}
