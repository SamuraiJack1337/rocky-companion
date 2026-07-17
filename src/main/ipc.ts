// Registers every IPC handler, mapping the channels in shared/ipc.ts to the
// main-process modules. Renderer surfaces only ever reach these handlers via
// the typed window.rocky bridge (preload.ts).
//
// Secrets never cross into the renderer: the OpenAI key is validated and stored
// here and never returned to any window.

import { app, ipcMain, BrowserWindow } from 'electron';
import { CH, EV } from '../shared/ipc';
import type { ConsentPayload } from '../shared/ipc';
import type {
  ChatMessage,
  EngineeringRequest,
  NoteView,
  ReflectionKind,
  RockyReply,
  Settings,
} from '../shared/types';
import { store } from './store';
import { hasOpenAIKey, setOpenAIKey, deleteOpenAIKey } from './keys';
import {
  getMicPermission,
  getScreenPermission,
  openScreenSettings,
  requestMicPermission,
} from './permissions';
import { probeOllama, validateOpenAIKey } from './providers/VisionProvider';
import { createSpeechProvider } from './providers/SpeechProvider';
import { synthesizeSpeech } from './tts';
import { synthesizePiper } from './piperTts';
import { listSkins, loadSkin, openSkinsFolder } from './assets';
import { sendToChat, showChatWindow, showLabWindow, showSettingsWindow } from './windows';
import type { TtsOverrides } from '../shared/ipc';
import type { Scheduler } from './scheduler';
import type { FocusManager } from './focus';
import { memory } from './memory';
import { notes } from './notes';
import { solveEngineering } from './engineering';
import { chatWithRocky, reflectOnNotes } from './chat';
import type { VoiceNotesController } from './voiceNotes';
import {
  calculationReply,
  focusCancelledReply,
  focusStartedReply,
} from '../shared/persona';

export interface IpcDeps {
  /** Centralized settings mutation + side effects (defined in main.ts). */
  applySettings: (patch: Partial<Settings>) => Settings;
  scheduler: Scheduler;
  /** Rebuild the cached provider after a provider/model/key change. */
  rebuildProvider: () => void;
  /** Called once first-run consent is submitted, to spin up the companion. */
  onConsentComplete: () => void;
  focus: FocusManager;
  emitReply: (reply: RockyReply) => void;
  /** Record + celebrate a fist bump (milestone-aware; defined in main.ts). */
  fistBump: () => void;
  /** Open / dismiss the pending release offer (URL validated in main.ts). */
  openUpdate: () => void;
  dismissUpdate: () => void;
  farewellAndQuit: () => void;
  /** Push-to-talk orchestration (defined in main.ts, one instance). */
  voiceNotes: VoiceNotesController;
  /** A note was saved from any surface — broadcast so notebooks refresh. */
  broadcastNoteSaved: (note: NoteView) => void;
}

export function registerIpc(deps: IpcDeps): void {
  // ── settings ───────────────────────────────────────────────────────────
  ipcMain.handle(CH.SETTINGS_GET, () => store.get());
  ipcMain.handle(CH.SETTINGS_SET, (_e, patch: Partial<Settings>) => deps.applySettings(patch ?? {}));

  // ── cloud key (BYOK) — validated + stored here, never echoed back ────────
  ipcMain.handle(CH.KEY_HAS, () => hasOpenAIKey());
  ipcMain.handle(CH.KEY_SET, async (_e, key: string) => {
    const model = store.get().openaiModel;
    const valid = await validateOpenAIKey(key, model);
    if (!valid.ok) return valid;
    const stored = setOpenAIKey(key);
    if (stored.ok) deps.rebuildProvider();
    return stored;
  });
  ipcMain.handle(CH.KEY_DELETE, () => {
    deleteOpenAIKey();
    deps.rebuildProvider();
  });

  // ── spoken voice (TTS) — key stays in main; only audio crosses to renderer ─
  ipcMain.handle(
    CH.TTS_SPEAK,
    (_e, args: { text: string; overrides?: TtsOverrides }) =>
      synthesizeSpeech(args?.text ?? '', args?.overrides),
  );

  // Offline neural voice (Piper) — no key, fully on-device. Null when the
  // engine isn't bundled for this platform, so callers fall back to the OS voice.
  ipcMain.handle(CH.TTS_SPEAK_OFFLINE, (_e, args: { text: string }) =>
    synthesizePiper(args?.text ?? ''),
  );

  // ── creature skins (drop-in art) ──────────────────────────────────────────
  ipcMain.handle(CH.SKINS_LIST, () => listSkins());
  ipcMain.handle(CH.SKIN_LOAD, (_e, name: string) => loadSkin(name));
  ipcMain.handle(CH.SKINS_OPEN_FOLDER, () => openSkinsFolder());

  // ── connectivity / permissions ───────────────────────────────────────────
  ipcMain.handle(CH.OLLAMA_CHECK, (_e, args: { host: string; model: string }) =>
    // Warm up the model here so Settings reproduces the app's real behavior
    // instead of only pinging /api/tags.
    probeOllama(args.host, args.model, { warmup: true }),
  );
  ipcMain.handle(CH.SCREEN_PERMISSION_CHECK, () => getScreenPermission());
  ipcMain.handle(CH.SCREEN_PERMISSION_OPEN, () => openScreenSettings());
  // macOS applies a Screen Recording grant only to a fresh launch, so the
  // settings window offers a one-click relaunch after the user flips the toggle.
  ipcMain.handle(CH.RELAUNCH, () => {
    app.relaunch();
    app.exit(0);
  });

  // ── consent + lifecycle ──────────────────────────────────────────────────
  ipcMain.handle(CH.CONSENT_SUBMIT, (_e, payload: ConsentPayload) => {
    deps.applySettings({
      provider: payload.provider,
      consentGiven: true,
      cloudConsentGiven: payload.cloudConsent || store.get().cloudConsentGiven,
      // The consent flow already asked for a name, so the upgrade nudge about
      // the setting never needs to fire for this install.
      ...(typeof payload.callName === 'string' && payload.callName.trim()
        ? { callName: payload.callName }
        : {}),
      namePromptShown: true,
    });
    deps.rebuildProvider();
    deps.onConsentComplete();
    return store.get();
  });

  ipcMain.handle(CH.LOOK_NOW, () => deps.scheduler.lookNow());
  ipcMain.handle(CH.SET_CLICK_THROUGH, (_e, enabled: boolean) =>
    void deps.applySettings({ clickThrough: !!enabled }),
  );
  ipcMain.handle(CH.OPEN_SETTINGS, () => {
    showSettingsWindow();
  });
  ipcMain.handle(CH.OPEN_LAB, () => {
    showLabWindow();
  });
  ipcMain.handle(CH.FOCUS_GET, () => deps.focus.get());
  ipcMain.handle(CH.FOCUS_START, (_e, minutes: number) => {
    const state = deps.focus.start(minutes);
    deps.emitReply(focusStartedReply(state.durationMinutes));
    return state;
  });
  ipcMain.handle(CH.FOCUS_CANCEL, () => {
    const wasActive = deps.focus.isActive();
    const state = deps.focus.cancel();
    if (wasActive) deps.emitReply(focusCancelledReply());
    return state;
  });
  ipcMain.handle(CH.FIST_BUMP, () => deps.fistBump());
  ipcMain.handle(CH.MEMORY_GET, () => memory.get());
  ipcMain.handle(CH.MEMORY_RESET, () => memory.reset());
  ipcMain.handle(CH.ENGINEERING_SOLVE, (_e, request: EngineeringRequest) => {
    const result = solveEngineering(request);
    if (result.ok) {
      memory.recordCalculation();
      deps.emitReply(calculationReply());
    }
    return result;
  });
  ipcMain.handle(CH.UPDATE_OPEN, () => deps.openUpdate());
  ipcMain.handle(CH.UPDATE_DISMISS, () => deps.dismissUpdate());

  // ── notes + voice input (Stage 1) ─────────────────────────────────────────
  ipcMain.handle(CH.MIC_PERMISSION_CHECK, () => getMicPermission());
  ipcMain.handle(CH.MIC_PERMISSION_REQUEST, () => requestMicPermission());
  ipcMain.handle(CH.SPEECH_SETUP_CHECK, async () => {
    const s = store.get();
    const provider = createSpeechProvider(s);
    const readiness = await provider.ready();
    return { ok: readiness.ok, provider: provider.kind, error: readiness.error };
  });
  ipcMain.handle(CH.PTT_TOGGLE, () => deps.voiceNotes.toggle());
  ipcMain.handle(CH.VOICE_NOTE_SUBMIT, (_e, wavBase64: string) =>
    deps.voiceNotes.submit(typeof wavBase64 === 'string' ? wavBase64 : ''),
  );
  ipcMain.on(CH.VOICE_NOTE_CANCEL, (_e, reason?: string) =>
    deps.voiceNotes.cancel(typeof reason === 'string' ? reason : undefined),
  );
  ipcMain.handle(CH.VOICE_TRANSCRIBE, (_e, wavBase64: string) =>
    deps.voiceNotes.transcribe(typeof wavBase64 === 'string' ? wavBase64 : ''),
  );
  ipcMain.handle(CH.NOTES_LIST, () => notes.list());
  ipcMain.handle(CH.NOTES_ADD, (_e, text: string) => {
    const note = notes.add(typeof text === 'string' ? text : '', 'chat');
    if (!note) return { ok: false, error: 'Nothing to keep.' };
    deps.broadcastNoteSaved(note);
    // Embedding + topic tags in the background; retrieval falls back to
    // keywords and the notebook shows no chips until they land.
    deps.voiceNotes.enrichInBackground(note);
    return { ok: true, note };
  });
  ipcMain.handle(CH.NOTES_DELETE, (_e, id: string) => {
    if (typeof id === 'string') notes.delete(id);
  });
  ipcMain.handle(CH.NOTES_CLEAR, () => notes.clear());
  ipcMain.handle(CH.CHAT_SEND, (_e, messages: ChatMessage[]) =>
    chatWithRocky(Array.isArray(messages) ? messages : [], store.get()),
  );
  ipcMain.handle(CH.CHAT_REFLECT, (_e, kind: ReflectionKind) =>
    reflectOnNotes(kind, store.get()),
  );
  ipcMain.handle(CH.OPEN_CHAT, (_e, reflect?: ReflectionKind) => {
    showChatWindow();
    if (
      reflect === 'summarize' ||
      reflect === 'connections' ||
      reflect === 'questions' ||
      reflect === 'weekly'
    ) {
      sendToChat(EV.CHAT_ACTION, { reflect });
    }
  });

  ipcMain.handle(CH.QUIT, () => {
    // Imported lazily to avoid a cycle; app is always available at runtime.
    deps.farewellAndQuit();
  });

  // ── fire-and-forget (renderer → main) ─────────────────────────────────────
  ipcMain.on(CH.DISMISS_BUBBLE, () => {
    /* bubble dismissal is renderer-local; nothing to do in main */
  });
  ipcMain.on(CH.CLOSE_WINDOW, (e) => {
    BrowserWindow.fromWebContents(e.sender)?.close();
  });
  // Manual window drag: the companion canvas is a no-drag region (so clicking
  // Rocky can mean something), so the renderer streams pointer deltas and main
  // moves the window. 'start' anchors at the current position; each 'move'
  // repositions absolutely from that anchor, so dropped messages never drift.
  let dragAnchor: { x: number; y: number } | null = null;
  ipcMain.on(CH.WINDOW_DRAG, (e, payload: { phase: 'start' | 'move'; dx?: number; dy?: number }) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win || win.isDestroyed()) return;
    if (payload?.phase === 'start') {
      const [x, y] = win.getPosition();
      dragAnchor = { x, y };
      return;
    }
    if (payload?.phase === 'move' && dragAnchor) {
      const dx = Number(payload.dx);
      const dy = Number(payload.dy);
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
      win.setPosition(Math.round(dragAnchor.x + dx), Math.round(dragAnchor.y + dy));
    }
  });
}
