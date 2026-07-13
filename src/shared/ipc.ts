// IPC contract shared by the main process, the preload bridge, and the
// renderer. Channel names live here as constants so both sides never drift.
// The RockyAPI interface is exactly what preload.ts exposes on
// `window.rocky` via contextBridge; renderer code is typed against it.

import type {
  Settings,
  RockyReply,
  RockyState,
  ScreenPermissionStatus,
  OllamaStatus,
  KeyResult,
  ProviderKind,
  SkinInfo,
  LoadedSkin,
  CompanionMemory,
  EngineeringRequest,
  EngineeringResult,
  FocusState,
} from './types';

/** invoke/handle channels (request → response). */
export const CH = {
  // settings
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  // cloud key (secret) — handled in main via safeStorage
  KEY_HAS: 'key:has-openai',
  KEY_SET: 'key:set-openai', // validates then stores
  KEY_DELETE: 'key:delete-openai',
  // spoken voice (TTS) — synthesized in main so the key never leaves it
  TTS_SPEAK: 'tts:speak',
  // creature skins (drop-in art)
  SKINS_LIST: 'skins:list',
  SKIN_LOAD: 'skins:load',
  SKINS_OPEN_FOLDER: 'skins:open-folder',
  // connectivity / permissions
  OLLAMA_CHECK: 'provider:check-ollama',
  SCREEN_PERMISSION_CHECK: 'permission:check-screen',
  SCREEN_PERMISSION_OPEN: 'permission:open-screen',
  RELAUNCH: 'app:relaunch',
  // consent + lifecycle
  CONSENT_SUBMIT: 'consent:submit',
  LOOK_NOW: 'rocky:look-now',
  SET_CLICK_THROUGH: 'window:set-click-through',
  DISMISS_BUBBLE: 'rocky:dismiss-bubble',
  OPEN_SETTINGS: 'window:open-settings',
  OPEN_LAB: 'window:open-lab',
  FOCUS_GET: 'focus:get',
  FOCUS_START: 'focus:start',
  FOCUS_CANCEL: 'focus:cancel',
  FIST_BUMP: 'rocky:fist-bump',
  MEMORY_GET: 'memory:get',
  MEMORY_RESET: 'memory:reset',
  ENGINEERING_SOLVE: 'engineering:solve',
  UPDATE_OPEN: 'update:open',
  UPDATE_DISMISS: 'update:dismiss',
  CLOSE_WINDOW: 'window:close-self',
  QUIT: 'app:quit',
} as const;

/** main → renderer push events (webContents.send). */
export const EV = {
  REPLY: 'rocky:reply', // RockyReply  → show bubble, animate, tone
  CAPTURE_INDICATOR: 'rocky:capture-indicator', // pulse glow at capture moment
  STATE: 'rocky:state', // RockyState  → paused/muted mirror
  SETTINGS_UPDATED: 'settings:updated', // Settings → live UI refresh
  FOCUS_STATE: 'focus:state',
  UPDATE_AVAILABLE: 'update:available', // UpdatePrompt → Rocky offers the new DMG
} as const;

/** A newer release, ready to offer. The URL stays in main; only display data crosses. */
export interface UpdatePrompt {
  version: string;
  /** Rocky's already-rendered offer line. */
  line: string;
}

export interface ConsentPayload {
  provider: ProviderKind;
  /** True only if the user explicitly accepted cloud (OpenAI) capture. */
  cloudConsent: boolean;
  /** Optional first-run answer to "what does Rocky call you?". */
  callName?: string;
}

/** Optional per-call overrides for a TTS request (e.g. the Settings auditioner). */
export interface TtsOverrides {
  ttsVoice?: string;
  ttsModel?: string;
  ttsInstructions?: string;
  expressiveCadence?: boolean;
}

/**
 * One synthesized speech segment (in memory, base64). A line is delivered as an
 * ordered list of these; `gapMsAfter` is the silence to insert before the next
 * segment, giving Rocky his expressive cadence.
 */
export interface TtsSegment {
  base64: string;
  mime: string;
  gapMsAfter: number;
}

/**
 * The safe, typed surface exposed to the renderer on `window.rocky`.
 * Every method maps to a channel above. Renderer code must use only this —
 * there is no direct Node or ipcRenderer access (contextIsolation: true).
 */
export interface RockyAPI {
  // ── settings ────────────────────────────────────────────────────────────
  getSettings(): Promise<Settings>;
  setSettings(patch: Partial<Settings>): Promise<Settings>;
  onSettingsUpdated(cb: (s: Settings) => void): () => void;

  // ── cloud key (BYOK) ──────────────────────────────────────────────────────
  hasOpenAIKey(): Promise<boolean>;
  /** Validates the key with a tiny test call, then stores it encrypted. */
  setOpenAIKey(key: string): Promise<KeyResult>;
  deleteOpenAIKey(): Promise<void>;

  // ── spoken voice (TTS) ────────────────────────────────────────────────────
  /** Synthesize speech for a line via the cloud TTS (key stays in main),
   *  returned as one or more cadence segments. Returns null when no key is set
   *  or synthesis fails (caller falls back to the procedural tone). */
  speakLine(text: string, overrides?: TtsOverrides): Promise<TtsSegment[] | null>;

  // ── creature skins (drop-in art) ──────────────────────────────────────────
  listSkins(): Promise<SkinInfo[]>;
  loadSkin(name: string): Promise<LoadedSkin | null>;
  openSkinsFolder(): Promise<void>;

  // ── connectivity / permissions ───────────────────────────────────────────
  checkOllama(host: string, model: string): Promise<OllamaStatus>;
  checkScreenPermission(): Promise<ScreenPermissionStatus>;
  openScreenSettings(): Promise<void>;
  relaunchApp(): Promise<void>;

  // ── consent + lifecycle ──────────────────────────────────────────────────
  submitConsent(payload: ConsentPayload): Promise<Settings>;
  lookNow(): Promise<void>;
  setClickThrough(enabled: boolean): Promise<void>;
  dismissBubble(): void;
  openSettings(): Promise<void>;
  openLab(): Promise<void>;
  getFocusState(): Promise<FocusState>;
  startFocus(minutes: number): Promise<FocusState>;
  cancelFocus(): Promise<FocusState>;
  fistBump(): Promise<void>;
  getMemory(): Promise<CompanionMemory>;
  resetMemory(): Promise<CompanionMemory>;
  solveEngineering(request: EngineeringRequest): Promise<EngineeringResult>;
  /** Open the pending release download in the browser (URL validated in main). */
  openUpdate(): Promise<void>;
  /** "Later" on the pending release; that version never prompts again. */
  dismissUpdate(): Promise<void>;
  closeSelf(): void;
  quit(): Promise<void>;

  // ── push events (main → renderer) ─────────────────────────────────────────
  onReply(cb: (reply: RockyReply) => void): () => void;
  onCaptureIndicator(cb: () => void): () => void;
  onState(cb: (state: RockyState) => void): () => void;
  onFocusState(cb: (state: FocusState) => void): () => void;
  onUpdateAvailable(cb: (update: UpdatePrompt) => void): () => void;
}

declare global {
  interface Window {
    rocky: RockyAPI;
  }
}
