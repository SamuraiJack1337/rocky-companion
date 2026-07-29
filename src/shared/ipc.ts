// IPC contract shared by the main process, the preload bridge, and the
// renderer. Channel names live here as constants so both sides never drift.
// The RockyAPI interface is exactly what preload.ts exposes on
// `window.rocky` via contextBridge; renderer code is typed against it.

import type {
  Settings,
  RockyReply,
  RockyState,
  ScreenPermissionStatus,
  ScreenPermissionResetResult,
  ScreenCaptureDiagnosis,
  OllamaStatus,
  KeyResult,
  ProviderKind,
  SkinInfo,
  LoadedSkin,
  CompanionMemory,
  EngineeringRequest,
  EngineeringResult,
  FocusState,
  ChatMessage,
  ChatResult,
  DecisionDraft,
  DecisionDraftResult,
  DecisionRecord,
  MicPermissionStatus,
  NoteView,
  ReflectionKind,
  ResearchResult,
  ResearchStart,
  SpeechSetupStatus,
  TranscriptionResult,
  VoiceCaptureState,
  VoiceNoteResult,
  WebSource,
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
  // offline neural spoken voice (Kokoro) — fully on-device, no key, no network
  TTS_SPEAK_OFFLINE: 'tts:speak-offline',
  // creature skins (drop-in art)
  SKINS_LIST: 'skins:list',
  SKIN_LOAD: 'skins:load',
  SKINS_OPEN_FOLDER: 'skins:open-folder',
  // connectivity / permissions
  OLLAMA_CHECK: 'provider:check-ollama',
  SCREEN_PERMISSION_CHECK: 'permission:check-screen',
  SCREEN_PERMISSION_OPEN: 'permission:open-screen',
  SCREEN_PERMISSION_RESET: 'permission:reset-screen',
  CAPTURE_DIAGNOSE: 'capture:diagnose',
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
  /** Manual companion-window drag (the canvas is no-drag so Rocky is clickable). */
  WINDOW_DRAG: 'window:drag',
  QUIT: 'app:quit',
  // notes + voice input (Stage 1)
  MIC_PERMISSION_CHECK: 'permission:check-mic',
  MIC_PERMISSION_REQUEST: 'permission:request-mic',
  SPEECH_SETUP_CHECK: 'speech:check-setup',
  /** Toggle push-to-talk (same action as the global shortcut). */
  PTT_TOGGLE: 'voice:ptt-toggle',
  /** Companion renderer hands the captured WAV back for transcribe + save. */
  VOICE_NOTE_SUBMIT: 'voice:note-submit',
  /** Companion renderer reports capture failed/empty so main leaves recording state. */
  VOICE_NOTE_CANCEL: 'voice:note-cancel',
  /** Transcribe-only (chat window mic button); nothing is saved. */
  VOICE_TRANSCRIBE: 'voice:transcribe',
  NOTES_LIST: 'notes:list',
  NOTES_ADD: 'notes:add',
  NOTES_DELETE: 'notes:delete',
  NOTES_CLEAR: 'notes:clear',
  CHAT_SEND: 'chat:send',
  CHAT_REFLECT: 'chat:reflect',
  OPEN_CHAT: 'window:open-chat',
  /** Persisted chat transcript. */
  CHAT_HISTORY_GET: 'chat:history-get',
  CHAT_HISTORY_CLEAR: 'chat:history-clear',
  /** Background research task (Stage 2). */
  RESEARCH_START: 'research:start',
  RESEARCH_CANCEL: 'research:cancel',
  /** Decision journal (Stage 2). */
  DECISION_DISTILL: 'decision:distill', // conversation → draft (for confirm)
  DECISION_LOG: 'decision:log', // confirmed draft → saved record
  DECISION_LIST: 'decision:list',
  DECISION_RESOLVE: 'decision:resolve',
  DECISION_DELETE: 'decision:delete',
  /** Open a validated http(s) URL in the user's browser. */
  OPEN_EXTERNAL: 'shell:open-external',
} as const;

/** main → renderer push events (webContents.send). */
export const EV = {
  REPLY: 'rocky:reply', // RockyReply  → show bubble, animate, tone
  CAPTURE_INDICATOR: 'rocky:capture-indicator', // pulse glow at capture moment
  STATE: 'rocky:state', // RockyState  → paused/muted mirror
  SETTINGS_UPDATED: 'settings:updated', // Settings → live UI refresh
  FOCUS_STATE: 'focus:state',
  UPDATE_AVAILABLE: 'update:available', // UpdatePrompt → Rocky offers the new DMG
  /** Main asks the companion renderer to start/stop microphone capture. */
  PTT: 'voice:ptt', // PttCommand
  /** Push-to-talk lifecycle mirror (idle/recording/processing) for any window. */
  VOICE_STATE: 'voice:state', // VoiceCaptureState
  /** A note was saved (voice or chat) — notebook views refresh on this. */
  NOTE_SAVED: 'notes:saved', // NoteView
  /** Deep-link into the chat window (e.g. auto-run a reflection). */
  CHAT_ACTION: 'chat:action', // ChatActionCommand
  /** A voice turn (global push-to-talk) landed in the persisted transcript —
   *  open chat windows append it live. */
  CHAT_TURN: 'chat:turn', // ChatTurn
  /** A progress line during a web/tool/research turn (targets the asking window). */
  CHAT_PROGRESS: 'chat:progress', // ChatProgress
  /** A research task finished (broadcast — the asking window may be long gone). */
  RESEARCH_DONE: 'research:done', // ResearchDone
} as const;

/** Instruction pushed to the companion renderer's recorder. */
export interface PttCommand {
  phase: 'start' | 'stop' | 'cancel';
}

/** Something the chat window should do on arrival (from tray/bubble/popover). */
export interface ChatActionCommand {
  /** Auto-run a reflection, or seed the composer with a decision follow-up. */
  reflect?: ReflectionKind;
  /** Seed the composer with this text (e.g. a decision follow-up prompt). */
  seed?: string;
}

/** A progress line pushed while Rocky searches, reads, or researches. */
export interface ChatProgress {
  line: string;
}

/** A complete voice turn (user + Rocky), already persisted by main. */
export interface ChatTurn {
  user: string;
  rocky: string;
  sources?: WebSource[];
}

/** A finished research task, broadcast to every window. */
export interface ResearchDone extends ResearchResult {
  /** The topic the task was started with, for labeling the result. */
  topic: string;
}

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
  /** Host OS ('darwin' | 'win32' | 'linux') — a plain value, not a channel;
   *  the renderer uses it for platform-appropriate help text. */
  readonly platform: NodeJS.Platform;

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

  /** Synthesize a line with the bundled offline neural voice (Kokoro via
   *  sherpa-onnx, macOS + Windows) — no key, on-device. Returns null when
   *  unavailable (unsupported platform, assets missing) or synthesis fails,
   *  so the caller can fall back to the OS voice / tone. */
  speakLineOffline(text: string): Promise<TtsSegment[] | null>;

  // ── creature skins (drop-in art) ──────────────────────────────────────────
  listSkins(): Promise<SkinInfo[]>;
  loadSkin(name: string): Promise<LoadedSkin | null>;
  openSkinsFolder(): Promise<void>;

  // ── connectivity / permissions ───────────────────────────────────────────
  checkOllama(host: string, model: string): Promise<OllamaStatus>;
  checkScreenPermission(): Promise<ScreenPermissionStatus>;
  openScreenSettings(): Promise<void>;
  /** In-app `tccutil reset ScreenCapture` fix flow for stale grants (macOS). */
  resetScreenPermission(): Promise<ScreenPermissionResetResult>;
  /** One test capture + status — detects the granted-but-black stale-grant case. */
  diagnoseScreenCapture(): Promise<ScreenCaptureDiagnosis>;
  relaunchApp(): Promise<void>;

  // ── consent + lifecycle ──────────────────────────────────────────────────
  submitConsent(payload: ConsentPayload): Promise<Settings>;
  lookNow(): Promise<void>;
  /** Anchor a manual window drag at the window's current position. */
  beginWindowDrag(): void;
  /** Move the window to (anchor + dx/dy), in screen pixels since the anchor. */
  dragWindowBy(dx: number, dy: number): void;
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

  // ── notes + voice input (Stage 1) ─────────────────────────────────────────
  checkMicPermission(): Promise<MicPermissionStatus>;
  /** Trigger the macOS microphone prompt; resolves with the resulting status. */
  requestMicPermission(): Promise<MicPermissionStatus>;
  /** Probe the configured speech-to-text backend (for Settings). */
  checkSpeechSetup(): Promise<SpeechSetupStatus>;
  /** Toggle push-to-talk exactly like the global shortcut. */
  togglePushToTalk(): Promise<void>;
  /** Companion recorder → main: transcribe + save the captured WAV as a note. */
  submitVoiceNote(wavBase64: string): Promise<VoiceNoteResult>;
  /** Companion recorder → main: capture failed or was empty. */
  cancelVoiceNote(reason?: string): void;
  /** Transcribe audio without saving (chat window mic). */
  transcribeVoice(wavBase64: string): Promise<TranscriptionResult>;
  listNotes(): Promise<NoteView[]>;
  addNote(text: string): Promise<VoiceNoteResult>;
  deleteNote(id: string): Promise<void>;
  clearNotes(): Promise<void>;
  /** One chat turn: full visible history in, Rocky's reply out. */
  sendChat(messages: ChatMessage[]): Promise<ChatResult>;
  /** Canned reflection over recent notes (Stage 1c). */
  reflect(kind: ReflectionKind): Promise<ChatResult>;
  /** Open the Notes & chat window, optionally auto-running a reflection. */
  openChat(reflect?: ReflectionKind): Promise<void>;

  // ── chat history, research, decisions, external links (Stage 2) ────────────
  /** The persisted transcript, oldest first. */
  getChatHistory(): Promise<ChatMessage[]>;
  /** Wipe the persisted transcript (file + memory). */
  clearChatHistory(): Promise<void>;
  /** Kick off a background research task; resolves immediately with whether it
   *  started. The finished report arrives later via onResearchDone. */
  startResearch(topic: string): Promise<ResearchStart>;
  /** Ask the in-flight research task to stop. */
  cancelResearch(): Promise<void>;
  /** Distill the conversation into a decision draft for the user to confirm. */
  distillDecision(messages: ChatMessage[]): Promise<DecisionDraftResult>;
  /** Save a confirmed decision draft. */
  logDecision(draft: DecisionDraft): Promise<DecisionRecord | null>;
  listDecisions(): Promise<DecisionRecord[]>;
  resolveDecision(id: string, resolution: string): Promise<void>;
  deleteDecision(id: string): Promise<void>;
  /** Open a URL in the user's browser (http/https only; validated in main). */
  openExternal(url: string): Promise<void>;

  // ── push events (main → renderer) ─────────────────────────────────────────
  onPtt(cb: (cmd: PttCommand) => void): () => void;
  onVoiceState(cb: (state: VoiceCaptureState) => void): () => void;
  onNoteSaved(cb: (note: NoteView) => void): () => void;
  onChatAction(cb: (cmd: ChatActionCommand) => void): () => void;
  onChatTurn(cb: (turn: ChatTurn) => void): () => void;
  onChatProgress(cb: (progress: ChatProgress) => void): () => void;
  onResearchDone(cb: (done: ResearchDone) => void): () => void;
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
