// Preload bridge. Runs with contextIsolation ON and nodeIntegration OFF, so the
// renderer never touches Node or ipcRenderer directly. It only sees the typed,
// minimal `window.rocky` surface defined by RockyAPI. Every method here maps to
// a channel in shared/ipc.ts.

import { contextBridge, ipcRenderer } from 'electron';
import { CH, EV } from '../shared/ipc';
import type {
  RockyAPI,
  ConsentPayload,
  PttCommand,
  TtsOverrides,
  TtsSegment,
  UpdatePrompt,
} from '../shared/ipc';
import type {
  Settings,
  RockyReply,
  RockyState,
  ScreenPermissionStatus,
  OllamaStatus,
  KeyResult,
  SkinInfo,
  LoadedSkin,
  CompanionMemory,
  EngineeringRequest,
  EngineeringResult,
  FocusState,
  ChatMessage,
  ChatResult,
  MicPermissionStatus,
  NoteView,
  ReflectionKind,
  SpeechSetupStatus,
  TranscriptionResult,
  VoiceCaptureState,
  VoiceNoteResult,
} from '../shared/types';

/** Subscribe to a push event; returns an unsubscribe function. */
function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: Electron.IpcRendererEvent, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: RockyAPI = {
  // settings
  getSettings: () => ipcRenderer.invoke(CH.SETTINGS_GET) as Promise<Settings>,
  setSettings: (patch: Partial<Settings>) =>
    ipcRenderer.invoke(CH.SETTINGS_SET, patch) as Promise<Settings>,
  onSettingsUpdated: (cb: (s: Settings) => void) => subscribe<Settings>(EV.SETTINGS_UPDATED, cb),

  // cloud key (BYOK)
  hasOpenAIKey: () => ipcRenderer.invoke(CH.KEY_HAS) as Promise<boolean>,
  setOpenAIKey: (key: string) => ipcRenderer.invoke(CH.KEY_SET, key) as Promise<KeyResult>,
  deleteOpenAIKey: () => ipcRenderer.invoke(CH.KEY_DELETE) as Promise<void>,

  // spoken voice (TTS)
  speakLine: (text: string, overrides?: TtsOverrides) =>
    ipcRenderer.invoke(CH.TTS_SPEAK, { text, overrides }) as Promise<TtsSegment[] | null>,

  // creature skins (drop-in art)
  listSkins: () => ipcRenderer.invoke(CH.SKINS_LIST) as Promise<SkinInfo[]>,
  loadSkin: (name: string) => ipcRenderer.invoke(CH.SKIN_LOAD, name) as Promise<LoadedSkin | null>,
  openSkinsFolder: () => ipcRenderer.invoke(CH.SKINS_OPEN_FOLDER) as Promise<void>,

  // connectivity / permissions
  checkOllama: (host: string, model: string) =>
    ipcRenderer.invoke(CH.OLLAMA_CHECK, { host, model }) as Promise<OllamaStatus>,
  checkScreenPermission: () =>
    ipcRenderer.invoke(CH.SCREEN_PERMISSION_CHECK) as Promise<ScreenPermissionStatus>,
  openScreenSettings: () => ipcRenderer.invoke(CH.SCREEN_PERMISSION_OPEN) as Promise<void>,
  relaunchApp: () => ipcRenderer.invoke(CH.RELAUNCH) as Promise<void>,

  // consent + lifecycle
  submitConsent: (payload: ConsentPayload) =>
    ipcRenderer.invoke(CH.CONSENT_SUBMIT, payload) as Promise<Settings>,
  lookNow: () => ipcRenderer.invoke(CH.LOOK_NOW) as Promise<void>,
  beginWindowDrag: () => ipcRenderer.send(CH.WINDOW_DRAG, { phase: 'start' }),
  dragWindowBy: (dx: number, dy: number) =>
    ipcRenderer.send(CH.WINDOW_DRAG, { phase: 'move', dx, dy }),
  setClickThrough: (enabled: boolean) =>
    ipcRenderer.invoke(CH.SET_CLICK_THROUGH, enabled) as Promise<void>,
  dismissBubble: () => ipcRenderer.send(CH.DISMISS_BUBBLE),
  openSettings: () => ipcRenderer.invoke(CH.OPEN_SETTINGS) as Promise<void>,
  openLab: () => ipcRenderer.invoke(CH.OPEN_LAB) as Promise<void>,
  getFocusState: () => ipcRenderer.invoke(CH.FOCUS_GET) as Promise<FocusState>,
  startFocus: (minutes: number) => ipcRenderer.invoke(CH.FOCUS_START, minutes) as Promise<FocusState>,
  cancelFocus: () => ipcRenderer.invoke(CH.FOCUS_CANCEL) as Promise<FocusState>,
  fistBump: () => ipcRenderer.invoke(CH.FIST_BUMP) as Promise<void>,
  getMemory: () => ipcRenderer.invoke(CH.MEMORY_GET) as Promise<CompanionMemory>,
  resetMemory: () => ipcRenderer.invoke(CH.MEMORY_RESET) as Promise<CompanionMemory>,
  solveEngineering: (request: EngineeringRequest) =>
    ipcRenderer.invoke(CH.ENGINEERING_SOLVE, request) as Promise<EngineeringResult>,
  openUpdate: () => ipcRenderer.invoke(CH.UPDATE_OPEN) as Promise<void>,
  dismissUpdate: () => ipcRenderer.invoke(CH.UPDATE_DISMISS) as Promise<void>,
  closeSelf: () => ipcRenderer.send(CH.CLOSE_WINDOW),
  quit: () => ipcRenderer.invoke(CH.QUIT) as Promise<void>,

  // notes + voice input (Stage 1)
  checkMicPermission: () =>
    ipcRenderer.invoke(CH.MIC_PERMISSION_CHECK) as Promise<MicPermissionStatus>,
  requestMicPermission: () =>
    ipcRenderer.invoke(CH.MIC_PERMISSION_REQUEST) as Promise<MicPermissionStatus>,
  checkSpeechSetup: () => ipcRenderer.invoke(CH.SPEECH_SETUP_CHECK) as Promise<SpeechSetupStatus>,
  togglePushToTalk: () => ipcRenderer.invoke(CH.PTT_TOGGLE) as Promise<void>,
  submitVoiceNote: (wavBase64: string) =>
    ipcRenderer.invoke(CH.VOICE_NOTE_SUBMIT, wavBase64) as Promise<VoiceNoteResult>,
  cancelVoiceNote: (reason?: string) => ipcRenderer.send(CH.VOICE_NOTE_CANCEL, reason),
  transcribeVoice: (wavBase64: string) =>
    ipcRenderer.invoke(CH.VOICE_TRANSCRIBE, wavBase64) as Promise<TranscriptionResult>,
  listNotes: () => ipcRenderer.invoke(CH.NOTES_LIST) as Promise<NoteView[]>,
  addNote: (text: string) => ipcRenderer.invoke(CH.NOTES_ADD, text) as Promise<VoiceNoteResult>,
  deleteNote: (id: string) => ipcRenderer.invoke(CH.NOTES_DELETE, id) as Promise<void>,
  clearNotes: () => ipcRenderer.invoke(CH.NOTES_CLEAR) as Promise<void>,
  sendChat: (messages: ChatMessage[]) =>
    ipcRenderer.invoke(CH.CHAT_SEND, messages) as Promise<ChatResult>,
  reflect: (kind: ReflectionKind) =>
    ipcRenderer.invoke(CH.CHAT_REFLECT, kind) as Promise<ChatResult>,
  openChat: () => ipcRenderer.invoke(CH.OPEN_CHAT) as Promise<void>,

  // push events (main → renderer)
  onPtt: (cb: (cmd: PttCommand) => void) => subscribe<PttCommand>(EV.PTT, cb),
  onVoiceState: (cb: (state: VoiceCaptureState) => void) =>
    subscribe<VoiceCaptureState>(EV.VOICE_STATE, cb),
  onNoteSaved: (cb: (note: NoteView) => void) => subscribe<NoteView>(EV.NOTE_SAVED, cb),
  onReply: (cb: (reply: RockyReply) => void) => subscribe<RockyReply>(EV.REPLY, cb),
  onCaptureIndicator: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on(EV.CAPTURE_INDICATOR, listener);
    return () => ipcRenderer.removeListener(EV.CAPTURE_INDICATOR, listener);
  },
  onState: (cb: (state: RockyState) => void) => subscribe<RockyState>(EV.STATE, cb),
  onFocusState: (cb: (state: FocusState) => void) => subscribe<FocusState>(EV.FOCUS_STATE, cb),
  onUpdateAvailable: (cb: (update: UpdatePrompt) => void) =>
    subscribe<UpdatePrompt>(EV.UPDATE_AVAILABLE, cb),
};

contextBridge.exposeInMainWorld('rocky', api);
