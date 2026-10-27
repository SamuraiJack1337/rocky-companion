// Registers every IPC handler, mapping the channels in shared/ipc.ts to the
// main-process modules. Renderer surfaces only ever reach these handlers via
// the typed window.rocky bridge (preload.ts).
//
// Secrets never cross into the renderer: the OpenAI key is validated and stored
// here and never returned to any window.

import { app, ipcMain, BrowserWindow, shell } from 'electron';
import { CH, EV } from '../shared/ipc';
import type { ConsentPayload } from '../shared/ipc';
import type {
  ChatMessage,
  DecisionDraft,
  EngineeringRequest,
  NoteView,
  ReflectionKind,
  RockyReply,
  Settings,
} from '../shared/types';
import { DEFAULT_SETTINGS, INBOX_WORKSPACE_ID } from '../shared/types';
import { store } from './store';
import { hasOpenAIKey, setOpenAIKey, deleteOpenAIKey } from './keys';
import {
  getMicPermission,
  getScreenPermission,
  openScreenSettings,
  requestMicPermission,
  resetScreenPermission,
} from './permissions';
import { captureScreen } from './capture';
import { probeOllama, validateOpenAIKey } from './providers/VisionProvider';
import { createSpeechProvider } from './providers/SpeechProvider';
import { synthesizeSpeech } from './tts';
import { synthesizeOffline } from './offlineTts';
import { listSkins, loadSkin, openSkinsFolder } from './assets';
import {
  sendToChat,
  showChatWindow,
  showLabWindow,
  showSettingsWindow,
  windowRoleFor,
} from './windows';
import type { WindowRole } from './windows';
import { renderLine } from '../shared/lines';
import type { TtsOverrides } from '../shared/ipc';
import type { Scheduler } from './scheduler';
import type { FocusManager } from './focus';
import { memory } from './memory';
import { notes } from './notes';
import { workspaces } from './workspaces';
import { tasks } from './tasks';
import { researchArtifacts } from './researchArtifacts';
import { solveEngineering } from './engineering';
import { chatWithRocky, cancelChatRequests, distillDecision, reflectOnNotes } from './chat';
import { chatHistory } from './chatHistory';
import { decisions } from './decisions';
import { research } from './research';
import { startDetachedResearch } from './researchTask';
import { eraseUserContent, getPrivacySummary, getProviderHealth } from './privacy';
import type { VoiceNotesController } from './voiceNotes';
import {
  calculationReply,
  focusCancelledReply,
  focusStartedReply,
  researchAckReply,
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
  /** Cancel in-flight model, speech, web, and recorder work before relaunch. */
  shutdown: () => void;
  /** Push-to-talk orchestration (defined in main.ts, one instance). */
  voiceNotes: VoiceNotesController;
  /** A note was saved from any surface — broadcast so notebooks refresh. */
  broadcastNoteSaved: (note: NoteView) => void;
}

const ALL_ROLES: readonly WindowRole[] = ['companion', 'consent', 'settings', 'lab', 'chat'];
const ROLE_RULES: Partial<Record<string, readonly WindowRole[]>> = {
  [CH.CONSENT_SUBMIT]: ['consent'],
  [CH.SETTINGS_SET]: ['settings', 'companion'],
  [CH.PRIVACY_SUMMARY]: ['settings'],
  [CH.PRIVACY_ERASE_CONTENT]: ['settings'],
  [CH.PROVIDER_HEALTH]: ['settings'],
  [CH.KEY_HAS]: ['settings', 'consent'],
  [CH.KEY_SET]: ['settings', 'consent'],
  [CH.KEY_DELETE]: ['settings'],
  [CH.TTS_SPEAK]: ['companion', 'chat', 'settings'],
  [CH.TTS_SPEAK_OFFLINE]: ['companion', 'chat', 'settings'],
  [CH.SKINS_LIST]: ['settings'],
  [CH.SKIN_LOAD]: ['settings', 'companion'],
  [CH.SKINS_OPEN_FOLDER]: ['settings'],
  [CH.OLLAMA_CHECK]: ['settings', 'consent'],
  [CH.SCREEN_PERMISSION_CHECK]: ['settings', 'consent'],
  [CH.SCREEN_PERMISSION_OPEN]: ['settings', 'consent'],
  [CH.SCREEN_PERMISSION_RESET]: ['settings'],
  [CH.CAPTURE_DIAGNOSE]: ['settings'],
  [CH.RELAUNCH]: ['settings'],
  [CH.LOOK_NOW]: ['companion'],
  [CH.SET_CLICK_THROUGH]: ['companion', 'settings'],
  [CH.FOCUS_GET]: ['companion', 'lab'],
  [CH.FOCUS_START]: ['companion', 'lab'],
  [CH.FOCUS_CANCEL]: ['companion', 'lab'],
  [CH.FIST_BUMP]: ['companion', 'lab'],
  [CH.MEMORY_GET]: ['lab'],
  [CH.MEMORY_RESET]: ['lab'],
  [CH.ENGINEERING_SOLVE]: ['lab'],
  [CH.UPDATE_OPEN]: ['companion'],
  [CH.UPDATE_DISMISS]: ['companion'],
  [CH.MIC_PERMISSION_CHECK]: ['settings', 'chat', 'companion'],
  [CH.MIC_PERMISSION_REQUEST]: ['settings', 'chat', 'companion'],
  [CH.SPEECH_SETUP_CHECK]: ['settings'],
  [CH.PTT_TOGGLE]: ['companion'],
  [CH.VOICE_NOTE_SUBMIT]: ['companion'],
  [CH.VOICE_NOTE_CANCEL]: ['companion'],
  [CH.VOICE_TRANSCRIBE]: ['chat'],
  [CH.NOTES_LIST]: ['chat'],
  [CH.NOTES_ADD]: ['chat'],
  [CH.NOTES_DELETE]: ['chat'],
  [CH.NOTES_CLEAR]: ['chat'],
  [CH.NOTES_MOVE]: ['chat'],
  [CH.WORKSPACES_LIST]: ['chat'],
  [CH.WORKSPACES_ADD]: ['chat'],
  [CH.WORKSPACES_DELETE]: ['chat'],
  [CH.TASKS_LIST]: ['chat'],
  [CH.TASKS_ADD]: ['chat'],
  [CH.TASKS_COMPLETE]: ['chat'],
  [CH.TASKS_DELETE]: ['chat'],
  [CH.RESEARCH_ARTIFACTS_LIST]: ['chat'],
  [CH.RESEARCH_ARTIFACTS_DELETE]: ['chat'],
  [CH.CHAT_SEND]: ['chat'],
  [CH.CHAT_CANCEL]: ['chat'],
  [CH.CHAT_REFLECT]: ['chat'],
  [CH.CHAT_HISTORY_GET]: ['chat'],
  [CH.CHAT_HISTORY_CLEAR]: ['chat'],
  [CH.RESEARCH_START]: ['chat'],
  [CH.RESEARCH_CANCEL]: ['chat'],
  [CH.DECISION_DISTILL]: ['chat'],
  [CH.DECISION_LOG]: ['chat'],
  [CH.DECISION_LIST]: ['chat'],
  [CH.DECISION_RESOLVE]: ['chat'],
  [CH.DECISION_DELETE]: ['chat'],
  [CH.OPEN_EXTERNAL]: ['chat'],
};

function authorizeSender(sender: Electron.WebContents, channel: string): WindowRole {
  const role = windowRoleFor(sender);
  const allowed = ROLE_RULES[channel] ?? ALL_ROLES;
  if (!role || !allowed.includes(role)) {
    throw new Error(`Unauthorized IPC request: ${channel}`);
  }
  return role;
}

/** Runtime-filter settings patches; TypeScript types do not protect IPC. */
function sanitizeSettingsPatch(raw: unknown, role: WindowRole): Partial<Settings> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const input = raw as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  const defaults = DEFAULT_SETTINGS as unknown as Record<string, unknown>;
  const allowedKeys = role === 'companion' ? new Set(['muted']) : new Set(Object.keys(defaults));
  for (const [key, value] of Object.entries(input)) {
    if (!allowedKeys.has(key) || !(key in defaults)) continue;
    const expected = defaults[key];
    if (key === 'blockedApps') {
      if (Array.isArray(value) && value.every((item) => typeof item === 'string')) output[key] = value;
    } else if (key === 'windowPosition') {
      const candidate = value as { x?: unknown; y?: unknown } | null;
      if (
        value === null ||
        (typeof value === 'object' && value !== null &&
          typeof candidate?.x === 'number' && Number.isFinite(candidate.x) &&
          typeof candidate?.y === 'number' && Number.isFinite(candidate.y))
      ) output[key] = value;
    } else if (typeof value === typeof expected) {
      output[key] = value;
    }
  }
  return output as Partial<Settings>;
}

export function registerIpc(deps: IpcDeps): void {
  type InvokeHandler = (event: Electron.IpcMainInvokeEvent, ...args: any[]) => any;
  const secureHandle = (channel: string, listener: InvokeHandler): void => {
    ipcMain.handle(channel, (event, ...args) => {
      authorizeSender(event.sender, channel);
      return listener(event, ...args);
    });
  };
  // ── settings ───────────────────────────────────────────────────────────
  secureHandle(CH.SETTINGS_GET, () => store.get());
  secureHandle(CH.SETTINGS_SET, (event, patch: unknown) =>
    deps.applySettings(sanitizeSettingsPatch(patch, windowRoleFor(event.sender) ?? 'companion')),
  );
  secureHandle(CH.PRIVACY_SUMMARY, () => getPrivacySummary(store.get()));
  secureHandle(CH.PRIVACY_ERASE_CONTENT, () => {
    eraseUserContent();
    return getPrivacySummary(store.get());
  });
  secureHandle(CH.PROVIDER_HEALTH, () => getProviderHealth(store.get()));

  // ── cloud key (BYOK) — validated + stored here, never echoed back ────────
  secureHandle(CH.KEY_HAS, () => hasOpenAIKey());
  secureHandle(CH.KEY_SET, async (_e, key: string) => {
    const model = store.get().openaiModel;
    const valid = await validateOpenAIKey(key, model);
    if (!valid.ok) return valid;
    const stored = setOpenAIKey(key);
    if (stored.ok) deps.rebuildProvider();
    return stored;
  });
  secureHandle(CH.KEY_DELETE, () => {
    deleteOpenAIKey();
    deps.rebuildProvider();
  });

  // ── spoken voice (TTS) — key stays in main; only audio crosses to renderer ─
  secureHandle(
    CH.TTS_SPEAK,
    (_e, args: { text: string; overrides?: TtsOverrides }) =>
      synthesizeSpeech(args?.text ?? '', args?.overrides),
  );

  // Offline neural voice (Kokoro via sherpa-onnx) — no key, fully on-device.
  // Null when the engine isn't bundled for this platform, so callers fall back
  // to the OS voice. Speaker + cadence come from settings, resolved here so the
  // synth module stays electron-light and testable.
  secureHandle(CH.TTS_SPEAK_OFFLINE, (_e, args: { text: string }) => {
    const s = store.get();
    return synthesizeOffline(args?.text ?? '', {
      sid: s.offlineTtsSpeaker,
      cadence: s.expressiveCadence,
    });
  });

  // ── creature skins (drop-in art) ──────────────────────────────────────────
  secureHandle(CH.SKINS_LIST, () => listSkins());
  secureHandle(CH.SKIN_LOAD, (_e, name: string) => loadSkin(name));
  secureHandle(CH.SKINS_OPEN_FOLDER, () => openSkinsFolder());

  // ── connectivity / permissions ───────────────────────────────────────────
  secureHandle(CH.OLLAMA_CHECK, (_e, args: { host: string; model: string }) =>
    // Warm up the model here so Settings reproduces the app's real behavior
    // instead of only pinging /api/tags.
    probeOllama(args.host, args.model, { warmup: true }),
  );
  secureHandle(CH.SCREEN_PERMISSION_CHECK, () => getScreenPermission());
  secureHandle(CH.SCREEN_PERMISSION_OPEN, () => openScreenSettings());
  secureHandle(CH.SCREEN_PERMISSION_RESET, () => resetScreenPermission());
  // One cheap in-memory test capture + the status. `granted` + `blank` is the
  // stale-TCC-grant signature the settings window keys its "Fix" button on.
  secureHandle(CH.CAPTURE_DIAGNOSE, async () => {
    const status = getScreenPermission();
    let blank = true;
    try {
      const shot = await captureScreen(256);
      blank = shot.blank || !shot.base64;
    } catch {
      // Capture threw outright — treat as blank; status tells the rest.
    }
    return { status, blank };
  });
  // macOS applies a Screen Recording grant only to a fresh launch, so the
  // settings window offers a one-click relaunch after the user flips the toggle.
  secureHandle(CH.RELAUNCH, () => {
    deps.shutdown();
    app.relaunch();
    app.exit(0);
  });

  // ── consent + lifecycle ──────────────────────────────────────────────────
  secureHandle(CH.CONSENT_SUBMIT, (_e, raw: unknown) => {
    const payload = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const provider = payload.provider === 'cloud' && payload.cloudConsent === true ? 'cloud' : 'local';
    const callName = typeof payload.callName === 'string' ? payload.callName : undefined;
    deps.applySettings({
      provider,
      consentGiven: true,
      cloudConsentGiven: payload.cloudConsent === true || store.get().cloudConsentGiven,
      // The consent flow already asked for a name, so the upgrade nudge about
      // the setting never needs to fire for this install.
      ...(callName?.trim() ? { callName } : {}),
      namePromptShown: true,
    });
    deps.rebuildProvider();
    deps.onConsentComplete();
    return store.get();
  });

  secureHandle(CH.LOOK_NOW, () => deps.scheduler.lookNow());
  secureHandle(CH.SET_CLICK_THROUGH, (_e, enabled: boolean) =>
    void deps.applySettings({ clickThrough: !!enabled }),
  );
  secureHandle(CH.OPEN_SETTINGS, () => {
    showSettingsWindow();
  });
  secureHandle(CH.OPEN_LAB, () => {
    showLabWindow();
  });
  secureHandle(CH.FOCUS_GET, () => deps.focus.get());
  secureHandle(CH.FOCUS_START, (_e, minutes: number) => {
    const state = deps.focus.start(minutes);
    deps.emitReply(focusStartedReply(state.durationMinutes));
    return state;
  });
  secureHandle(CH.FOCUS_CANCEL, () => {
    const wasActive = deps.focus.isActive();
    const state = deps.focus.cancel();
    if (wasActive) deps.emitReply(focusCancelledReply());
    return state;
  });
  secureHandle(CH.FIST_BUMP, () => deps.fistBump());
  secureHandle(CH.MEMORY_GET, () => memory.get());
  secureHandle(CH.MEMORY_RESET, () => memory.reset());
  secureHandle(CH.ENGINEERING_SOLVE, (_e, request: EngineeringRequest) => {
    const result = solveEngineering(request);
    if (result.ok) {
      memory.recordCalculation();
      deps.emitReply(calculationReply());
    }
    return result;
  });
  secureHandle(CH.UPDATE_OPEN, () => deps.openUpdate());
  secureHandle(CH.UPDATE_DISMISS, () => deps.dismissUpdate());

  // ── notes + voice input (Stage 1) ─────────────────────────────────────────
  secureHandle(CH.MIC_PERMISSION_CHECK, () => getMicPermission());
  secureHandle(CH.MIC_PERMISSION_REQUEST, () => requestMicPermission());
  secureHandle(CH.SPEECH_SETUP_CHECK, async () => {
    const s = store.get();
    const provider = createSpeechProvider(s);
    const readiness = await provider.ready();
    return { ok: readiness.ok, provider: provider.kind, error: readiness.error };
  });
  secureHandle(CH.PTT_TOGGLE, () => deps.voiceNotes.toggle());
  secureHandle(CH.VOICE_NOTE_SUBMIT, (_e, wavBase64: string, sessionId?: number) =>
    deps.voiceNotes.submit(
      typeof wavBase64 === 'string' ? wavBase64 : '',
      typeof sessionId === 'number' && Number.isInteger(sessionId) && sessionId > 0 ? sessionId : undefined,
    ),
  );
  ipcMain.on(CH.VOICE_NOTE_CANCEL, (event, reason?: string, sessionId?: number) => {
    authorizeSender(event.sender, CH.VOICE_NOTE_CANCEL);
    deps.voiceNotes.cancel(
      typeof reason === 'string' ? reason : undefined,
      typeof sessionId === 'number' && Number.isInteger(sessionId) && sessionId > 0 ? sessionId : undefined,
    );
  });
  secureHandle(CH.VOICE_TRANSCRIBE, (_e, wavBase64: string) =>
    deps.voiceNotes.transcribe(typeof wavBase64 === 'string' ? wavBase64 : ''),
  );
  secureHandle(CH.NOTES_LIST, (_e, workspaceId?: string) =>
    notes.list(typeof workspaceId === 'string' && workspaces.exists(workspaceId) ? workspaceId : undefined),
  );
  secureHandle(CH.NOTES_ADD, (_e, text: string, workspaceId?: string) => {
    const target = typeof workspaceId === 'string' && workspaces.exists(workspaceId) ? workspaceId : undefined;
    const note = notes.add(typeof text === 'string' ? text : '', 'chat', target);
    if (!note) return { ok: false, error: 'Nothing to keep.' };
    deps.broadcastNoteSaved(note);
    // Embedding + topic tags in the background; retrieval falls back to
    // keywords and the notebook shows no chips until they land.
    deps.voiceNotes.enrichInBackground(note);
    return { ok: true, note };
  });
  secureHandle(CH.NOTES_DELETE, (_e, id: string) => {
    if (typeof id === 'string') notes.delete(id);
  });
  secureHandle(CH.NOTES_CLEAR, () => notes.clear());
  secureHandle(CH.NOTES_MOVE, (_e, args: { id?: unknown; workspaceId?: unknown }) => {
    if (
      args && typeof args.id === 'string' && typeof args.workspaceId === 'string' &&
      workspaces.exists(args.workspaceId)
    ) notes.moveToWorkspace(args.id, args.workspaceId);
  });
  secureHandle(CH.WORKSPACES_LIST, () => workspaces.list());
  secureHandle(CH.WORKSPACES_ADD, (_e, name: unknown) =>
    workspaces.add(typeof name === 'string' ? name : ''),
  );
  secureHandle(CH.WORKSPACES_DELETE, (_e, id: unknown) => {
    if (typeof id !== 'string' || !workspaces.delete(id)) return false;
    notes.reassignWorkspace(id);
    tasks.reassignWorkspace(id);
    researchArtifacts.reassignWorkspace(id);
    return true;
  });
  secureHandle(CH.TASKS_LIST, (_e, workspaceId?: string) =>
    tasks.list(typeof workspaceId === 'string' && workspaces.exists(workspaceId) ? workspaceId : undefined),
  );
  secureHandle(CH.TASKS_ADD, (_e, input: unknown) => {
    if (!input || typeof input !== 'object') return null;
    const raw = input as Record<string, unknown>;
    const workspaceId = typeof raw.workspaceId === 'string' && workspaces.exists(raw.workspaceId)
      ? raw.workspaceId : undefined;
    return tasks.add({
      title: typeof raw.title === 'string' ? raw.title : '',
      workspaceId,
      dueAt: typeof raw.dueAt === 'string' ? raw.dueAt : undefined,
      remindAt: typeof raw.remindAt === 'string' ? raw.remindAt : undefined,
    });
  });
  secureHandle(CH.TASKS_COMPLETE, (_e, args: unknown) => {
    if (!args || typeof args !== 'object') return;
    const raw = args as Record<string, unknown>;
    if (typeof raw.id === 'string') tasks.complete(raw.id, raw.completed === true);
  });
  secureHandle(CH.TASKS_DELETE, (_e, id: unknown) => {
    if (typeof id === 'string') tasks.delete(id);
  });
  secureHandle(CH.RESEARCH_ARTIFACTS_LIST, (_e, workspaceId?: string) =>
    researchArtifacts.list(
      typeof workspaceId === 'string' && workspaces.exists(workspaceId) ? workspaceId : undefined,
    ),
  );
  secureHandle(CH.RESEARCH_ARTIFACTS_DELETE, (_e, id: unknown) => {
    if (typeof id === 'string') researchArtifacts.delete(id);
  });
  secureHandle(CH.CHAT_SEND, async (
    e,
    messages: ChatMessage[],
    workspaceId?: string,
    rawRequestId?: string,
  ) => {
    const requestId = typeof rawRequestId === 'string' ? rawRequestId.slice(0, 80) : '';
    const history = Array.isArray(messages) ? messages : [];
    const targetWorkspace =
      typeof workspaceId === 'string' && workspaces.exists(workspaceId)
        ? workspaceId
        : INBOX_WORKSPACE_ID;
    // Progress lines target only the asking window (not a broadcast).
    const onProgress = (line: string) => {
      if (!e.sender.isDestroyed()) e.sender.send(EV.CHAT_PROGRESS, { line });
    };
    const onToken = requestId
      ? (delta: string) => {
          if (!e.sender.isDestroyed() && delta) e.sender.send(EV.CHAT_TOKEN, { requestId, delta });
        }
      : undefined;
    let result = await chatWithRocky(
      history,
      store.get(),
      onProgress,
      targetWorkspace,
      onToken,
    );
    // The model routed this turn into a research task (start_research tool):
    // kick off the detached run and answer with the in-persona ack instead.
    if (result.ok && result.startResearch) {
      const start = startDetachedResearch(
        result.startResearch,
        deps.emitReply,
        onProgress,
        targetWorkspace,
      );
      const name = store.get().callName;
      result = start.started
        ? { ...result, reply: researchAckReply(name).line }
        : {
            ...result,
            startResearch: undefined,
            reply: start.error ?? renderLine('Rocky could not start that research, {name}.', { name }),
          };
    }
    // Persist the turn on success so the transcript survives window close.
    if (result.ok && result.reply) {
      const latestUser = [...history].reverse().find((m) => m && m.role === 'user');
      if (latestUser) chatHistory.append({
        role: 'user', text: latestUser.text, kind: 'chat', workspaceId: targetWorkspace,
      });
      chatHistory.append({
        role: 'rocky', text: result.reply, sources: result.sources, kind: 'chat', workspaceId: targetWorkspace,
      });
    }
    return result;
  });
  secureHandle(CH.CHAT_CANCEL, () => cancelChatRequests());
  secureHandle(CH.CHAT_REFLECT, async (_e, kind: ReflectionKind, workspaceId?: string) => {
    const targetWorkspace =
      typeof workspaceId === 'string' && workspaces.exists(workspaceId)
        ? workspaceId
        : INBOX_WORKSPACE_ID;
    const safeKind: ReflectionKind =
      kind === 'connections' || kind === 'questions' || kind === 'weekly' ? kind : 'summarize';
    const labels: Record<ReflectionKind, string> = {
      summarize: 'Summarize my notes',
      connections: 'Find connections',
      questions: 'Questions for me',
      weekly: 'Weekly reflection',
    };
    const result = await reflectOnNotes(safeKind, store.get(), targetWorkspace);
    if (result.ok && result.reply) {
      chatHistory.appendTurn(
        { role: 'user', text: labels[safeKind], kind: 'reflection', workspaceId: targetWorkspace },
        {
          role: 'rocky', text: result.reply, sources: result.sources,
          kind: 'reflection', workspaceId: targetWorkspace,
        },
      );
    }
    return result;
  });
  secureHandle(CH.OPEN_CHAT, (_e, reflect?: ReflectionKind) => {
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

  // ── chat history, research, decisions, external links (Stage 2) ────────────
  secureHandle(CH.CHAT_HISTORY_GET, (_e, workspaceId?: string) =>
    chatHistory.list(typeof workspaceId === 'string' ? workspaceId : undefined),
  );
  secureHandle(CH.CHAT_HISTORY_CLEAR, (_e, workspaceId?: string) =>
    chatHistory.clear(typeof workspaceId === 'string' ? workspaceId : undefined),
  );

  // Research is fire-and-forget: the handler resolves as soon as the task is
  // accepted, chat stays usable, and the finished report comes back later as a
  // broadcast (the asking window may be closed by then) plus a companion
  // bubble whose line Rocky speaks — the JARVIS loop. The runner itself lives
  // in researchTask.ts, shared with the push-to-talk voice route.
  secureHandle(CH.RESEARCH_START, (e, rawTopic: string, workspaceId?: string) => {
    const onProgress = (line: string) => {
      if (!e.sender.isDestroyed()) e.sender.send(EV.CHAT_PROGRESS, { line });
    };
    return startDetachedResearch(
      typeof rawTopic === 'string' ? rawTopic : '',
      deps.emitReply,
      onProgress,
      typeof workspaceId === 'string' && workspaces.exists(workspaceId) ? workspaceId : undefined,
    );
  });
  secureHandle(CH.RESEARCH_CANCEL, () => research.cancel());

  secureHandle(CH.DECISION_DISTILL, (_e, messages: ChatMessage[]) =>
    distillDecision(Array.isArray(messages) ? messages : [], store.get()),
  );
  secureHandle(CH.DECISION_LOG, (_e, draft: DecisionDraft) => {
    if (!draft || typeof draft.decision !== 'string') return null;
    return decisions.add({
      decision: draft.decision,
      reasons: typeof draft.reasons === 'string' ? draft.reasons : '',
      expectedOutcome: typeof draft.expectedOutcome === 'string' ? draft.expectedOutcome : '',
    });
  });
  secureHandle(CH.DECISION_LIST, () => decisions.list());
  secureHandle(CH.DECISION_RESOLVE, (_e, args: { id: string; resolution: string }) => {
    if (args && typeof args.id === 'string') {
      decisions.resolve(args.id, typeof args.resolution === 'string' ? args.resolution : '');
    }
  });
  secureHandle(CH.DECISION_DELETE, (_e, id: string) => {
    if (typeof id === 'string') decisions.delete(id);
  });

  secureHandle(CH.OPEN_EXTERNAL, (_e, url: string) => {
    // http/https only — never file:, javascript:, etc.
    try {
      const parsed = new URL(typeof url === 'string' ? url : '');
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        void shell.openExternal(parsed.toString());
      }
    } catch {
      /* not a valid URL — ignore */
    }
  });

  secureHandle(CH.QUIT, () => {
    // Imported lazily to avoid a cycle; app is always available at runtime.
    deps.farewellAndQuit();
  });

  // ── fire-and-forget (renderer → main) ─────────────────────────────────────
  ipcMain.on(CH.DISMISS_BUBBLE, (event) => {
    authorizeSender(event.sender, CH.DISMISS_BUBBLE);
    /* bubble dismissal is renderer-local; nothing to do in main */
  });
  ipcMain.on(CH.CLOSE_WINDOW, (e) => {
    authorizeSender(e.sender, CH.CLOSE_WINDOW);
    BrowserWindow.fromWebContents(e.sender)?.close();
  });
  // Manual window drag: the companion canvas is a no-drag region (so clicking
  // Rocky can mean something), so the renderer streams pointer deltas and main
  // moves the window. 'start' anchors at the current position; each 'move'
  // repositions absolutely from that anchor, so dropped messages never drift.
  let dragAnchor: { x: number; y: number } | null = null;
  ipcMain.on(CH.WINDOW_DRAG, (e, payload: { phase: 'start' | 'move'; dx?: number; dy?: number }) => {
    const role = authorizeSender(e.sender, CH.WINDOW_DRAG);
    if (role !== 'companion') return;
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
