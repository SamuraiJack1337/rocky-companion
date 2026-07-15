// App entry point. Wires together the store, key vault, capture pipeline, the
// pluggable vision provider, the scheduler, the windows, the tray menu, and IPC.
//
// Lifecycle:
//   first run  → consent window gates ALL capture; on submit the companion
//                appears and the scheduler starts.
//   later runs → companion appears immediately (sleeping if paused).
//
// Rocky is a menu-bar / floating companion: no Dock icon, and closing windows
// does not quit the app (only the tray's Quit does).

import { app, Tray, Menu, nativeImage, powerMonitor, shell } from 'electron';
import { EV } from '../shared/ipc';
import type { UpdatePrompt } from '../shared/ipc';
import type { RockyReply, Settings } from '../shared/types';
import { DEFAULT_SETTINGS, INTERVAL_PRESETS } from '../shared/types';
import { store } from './store';
import { isScreenGranted } from './permissions';
import { captureScreen } from './capture';
import { createProvider } from './providers/VisionProvider';
import type { VisionProvider } from './providers/VisionProvider';
import { Scheduler } from './scheduler';
import {
  createCompanionWindow,
  showCompanionWindow,
  hideCompanionWindow,
  isCompanionVisible,
  setCompanionClickThrough,
  showConsentWindow,
  closeConsentWindow,
  showSettingsWindow,
  showLabWindow,
  showChatWindow,
  sendToCompanion,
  broadcast,
  hideDock,
} from './windows';
import { registerIpc } from './ipc';
import { VoiceNotesController } from './voiceNotes';
import { FocusManager } from './focus';
import { getFrontmostAppName } from './activeApp';
import { memory } from './memory';
import { detectMilestones } from './milestones';
import { SessionTracker } from './sessionTracker';
import { UpdateChecker } from './updates';
import type { ObservationOutcome } from './scheduler';
import type { ScreenObservation } from '../shared/types';
import { renderLine } from '../shared/lines';
import {
  composeMilestoneReply,
  composeSessionReply,
  farewellReply,
  fistBumpReply,
  focusCancelledReply,
  focusCompletedReply,
  focusStartedReply,
  greetingReply,
} from '../shared/persona';

// A small menu-bar template icon (black + alpha circle), embedded so there is
// no external asset to ship. macOS recolors template images for light/dark.
const TRAY_ICON_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAABYAAAAWCAYAAADEtGw7AAAAq0lEQVR4nMWVwQ3DIBAE5+0GXAcN0AcVUI87oAMqcCf0kijSWkqQMQn2xSvtB8EI7R0H3KgZcICXndaG9QJEYAEysMpZa1F7vtYEBCABBXg0XLQn6EwXGnWzFrD2qjOH8PAj9B0ejjJNA9DNqZV57GTacxHjQ7MqPQrdvNSt6NRGZ8G5jsMPFm2viP4vYLMozIpn1m6mDwSrJ43lEMJqbNaZXzroa13+NZ3SExWg/oXZoWn+AAAAAElFTkSuQmCC';

let tray: Tray | null = null;
let forceQuitting = false;
let farewellPending = false;

function emitReply(reply: RockyReply): void {
  sendToCompanion(EV.REPLY, reply);
}

const sessionTracker = new SessionTracker();

/**
 * Record an observation and decide whether something more notable than the
 * ordinary line should be said: milestone first, long-run nudge second.
 */
function recordObservation(observation: ScreenObservation): ObservationOutcome {
  const before = memory.get();
  const after = memory.recordObservation();
  const insight = sessionTracker.record(observation.activity);
  const milestone = detectMilestones(before, after)[0];
  const name = store.get().callName;
  if (milestone) {
    return {
      relationshipStage: after.relationshipStage,
      specialReply: composeMilestoneReply(milestone, name),
      specialKind: 'milestone',
    };
  }
  if (insight) {
    return {
      relationshipStage: after.relationshipStage,
      specialReply: composeSessionReply(insight.activity, insight.hours, name),
      specialKind: 'session',
    };
  }
  return { relationshipStage: after.relationshipStage, specialReply: null };
}

/** Record a fist bump; a crossed milestone upgrades the usual celebration. */
function fistBump(): void {
  const before = memory.get();
  const after = memory.recordFistBump();
  const milestone = detectMilestones(before, after)[0];
  emitReply(milestone ? composeMilestoneReply(milestone, store.get().callName) : fistBumpReply());
}

const focus = new FocusManager(
  (state) => {
    broadcast(EV.FOCUS_STATE, state);
    refreshTray();
  },
  () => {
    const before = memory.get();
    const after = memory.recordFocusCompleted();
    const milestone = detectMilestones(before, after)[0];
    const name = store.get().callName;
    emitReply(milestone ? composeMilestoneReply(milestone, name) : focusCompletedReply(name));
  },
);

// The active provider is cached and rebuilt whenever provider/model/key change.
// Created in whenReady() because store.get() needs app to be ready.
let provider!: VisionProvider;
function rebuildProvider(): void {
  provider = createProvider(store.get());
}

// Push-to-talk voice notes (Stage 1a). The controller orchestrates; the
// companion renderer does the actual microphone capture.
const voiceNotes = new VoiceNotesController({
  getSettings: () => store.get(),
  emitReply,
  sendPtt: (cmd) => sendToCompanion(EV.PTT, cmd),
  broadcastState: (state) => {
    broadcast(EV.VOICE_STATE, state);
    refreshTray();
  },
  broadcastNoteSaved: (note) => broadcast(EV.NOTE_SAVED, note),
  showCompanion: () => showCompanionWindow(),
});

/**
 * (Re-)register the push-to-talk hotkey from settings. On failure (invalid or
 * taken accelerator) fall back to the default so a hotkey always exists.
 */
function applyPushToTalkShortcut(): void {
  const wanted = store.get().pushToTalkShortcut;
  if (voiceNotes.registerShortcut(wanted)) return;
  const fallback = DEFAULT_SETTINGS.pushToTalkShortcut;
  if (wanted !== fallback && voiceNotes.registerShortcut(fallback)) {
    store.set({ pushToTalkShortcut: fallback });
  }
}

const scheduler = new Scheduler({
  getSettings: () => store.get(),
  getProvider: () => provider,
  capture: () => captureScreen(1024),
  emitReply: (reply) => sendToCompanion(EV.REPLY, reply),
  emitCaptureIndicator: () => sendToCompanion(EV.CAPTURE_INDICATOR),
  isScreenGranted: () => isScreenGranted(),
  isFocusActive: () => focus.isActive(),
  getActiveAppName: () => getFrontmostAppName(),
  recordObservation,
  getIdleSeconds: () => powerMonitor.getSystemIdleTime(),
  peekSession: () => sessionTracker.peek(),
});

function greet(): void {
  emitReply(greetingReply(memory.get().relationshipStage, store.get().callName));
}

const updateChecker = new UpdateChecker({
  currentVersion: app.getVersion(),
  getSettings: () => store.get(),
  applySettings: (patch) => applySettings(patch),
  notify: (info) => {
    const prompt: UpdatePrompt = {
      version: info.version,
      line: renderLine(`New shell version ${info.version} exists, {name}. Rocky fetch it, question?`, {
        name: store.get().callName,
      }),
    };
    sendToCompanion(EV.UPDATE_AVAILABLE, prompt);
    refreshTray();
  },
});

/** Open the pending release in the browser. The checker only ever holds GitHub URLs. */
function openUpdate(): void {
  const pending = updateChecker.getPending();
  if (pending) void shell.openExternal(pending.url);
}

function dismissUpdate(): void {
  updateChecker.dismissPending();
  refreshTray();
}

/**
 * One-time nudge for installs that predate the call-name setting: Rocky
 * mentions the new option once, shortly after the greeting, then never again.
 */
function maybeOfferNamePrompt(): void {
  const s = store.get();
  if (s.namePromptShown) return;
  store.set({ namePromptShown: true });
  const timer = setTimeout(() => {
    emitReply({
      line: 'Rocky calls you buddy. A different name lives in Settings now, question?',
      mood: 'curious',
      activity: 'idle',
      gesture: 'observe',
      motif: 'question',
    });
  }, 12_000);
  timer.unref();
}

/** Show Rocky's farewell performance before ending the process. */
function farewellAndQuit(): void {
  if (forceQuitting || farewellPending) return;
  if (!app.isReady() || !store.get().consentGiven) {
    forceQuitting = true;
    app.quit();
    return;
  }

  farewellPending = true;
  scheduler.stop();
  focus.dispose();
  showCompanionWindow();
  emitReply(farewellReply(store.get().callName));
  refreshTray();

  const timer = setTimeout(() => {
    forceQuitting = true;
    app.quit();
  }, 1_600);
  timer.unref();
}

/**
 * Single point of truth for changing settings. Persists, applies the matching
 * side effects, mirrors state to the renderer, and refreshes the tray. Both the
 * IPC layer and the tray menu route through here so behavior never diverges.
 */
function applySettings(patch: Partial<Settings>): Settings {
  const s = store.set(patch);

  if (patch.intervalMinutes !== undefined || patch.strictInterval !== undefined) {
    scheduler.setIntervalMinutes(s.intervalMinutes);
  }
  if (patch.paused !== undefined) (s.paused ? scheduler.pause() : scheduler.resume());
  if (patch.clickThrough !== undefined) setCompanionClickThrough(s.clickThrough);
  if (
    patch.provider !== undefined ||
    patch.openaiModel !== undefined ||
    patch.ollamaModel !== undefined ||
    patch.ollamaHost !== undefined
  ) {
    rebuildProvider();
  }
  if (patch.pushToTalkShortcut !== undefined) applyPushToTalkShortcut();

  broadcast(EV.SETTINGS_UPDATED, s);
  broadcast(EV.STATE, { paused: s.paused, muted: s.muted });
  refreshTray();
  return s;
}

/** Called after first-run consent: show Rocky and begin the cadence. */
function onConsentComplete(): void {
  closeConsentWindow();
  createCompanionWindow();
  const s = store.get();
  if (!s.paused) scheduler.start();
  applyPushToTalkShortcut();
  greet();
  refreshTray();
}

function buildTrayMenu(): Menu {
  const s = store.get();
  const focusState = focus.get();
  const pendingUpdate = updateChecker.getPending();
  return Menu.buildFromTemplate([
    ...(pendingUpdate
      ? [
          {
            label: `Update available — v${pendingUpdate.version}…`,
            click: () => openUpdate(),
          },
          { type: 'separator' as const },
        ]
      : []),
    {
      label: isCompanionVisible() ? 'Hide Rocky' : 'Show Rocky',
      click: () => {
        if (isCompanionVisible()) hideCompanionWindow();
        else showCompanionWindow();
        refreshTray();
      },
    },
    { label: 'Look now', click: () => void scheduler.lookNow() },
    {
      label: focusState.active
        ? `Focus: ${focusState.durationMinutes} min (active)`
        : 'Start 25 min focus',
      click: () => {
        if (focusState.active) {
          focus.cancel();
          emitReply(focusCancelledReply());
        } else {
          const state = focus.start(25);
          emitReply(focusStartedReply(state.durationMinutes));
        }
      },
    },
    {
      label: 'Fist bump',
      click: () => fistBump(),
    },
    { type: 'separator' },
    {
      label:
        voiceNotes.getState() === 'recording'
          ? 'Stop listening (saves the note)'
          : voiceNotes.getState() === 'processing'
            ? 'Translating your thought…'
            : 'Talk to Rocky (voice note)',
      enabled: voiceNotes.getState() !== 'processing',
      click: () => void voiceNotes.toggle(),
    },
    { label: 'Notes & chat…', click: () => showChatWindow() },
    { type: 'separator' },
    {
      label: 'Pause',
      type: 'checkbox',
      checked: s.paused,
      click: () => applySettings({ paused: !s.paused }),
    },
    {
      label: 'Mute',
      type: 'checkbox',
      checked: s.muted,
      click: () => applySettings({ muted: !s.muted }),
    },
    {
      label: 'Interval',
      submenu: INTERVAL_PRESETS.map((m) => ({
        label: m === 60 ? '1 hour' : m === 120 ? '2 hours' : `${m} min`,
        type: 'radio' as const,
        checked: s.intervalMinutes === m,
        click: () => applySettings({ intervalMinutes: m }),
      })),
    },
    { type: 'separator' },
    { label: 'Rocky Lab…', click: () => showLabWindow() },
    { label: 'Settings…', click: () => showSettingsWindow() },
    { label: 'Quit Rocky', click: () => farewellAndQuit() },
  ]);
}

function refreshTray(): void {
  if (!tray) return;
  tray.setContextMenu(buildTrayMenu());
}

function createTray(): void {
  const icon = nativeImage.createFromDataURL(`data:image/png;base64,${TRAY_ICON_BASE64}`);
  if (process.platform === 'darwin') icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip('Rocky Companion');
  refreshTray();
}

// ── app lifecycle ───────────────────────────────────────────────────────────

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (store.get().consentGiven) showCompanionWindow();
    else showConsentWindow();
  });

  app.whenReady().then(() => {
    hideDock();
    rebuildProvider(); // safe now that app is ready (store reads userData path)
    memory.recordLaunch();
    createTray();
    registerIpc({
      applySettings,
      scheduler,
      rebuildProvider,
      onConsentComplete,
      focus,
      emitReply,
      fistBump,
      openUpdate,
      dismissUpdate,
      farewellAndQuit,
      voiceNotes,
      broadcastNoteSaved: (note) => broadcast(EV.NOTE_SAVED, note),
    });
    updateChecker.start();

    const s = store.get();
    if (!s.consentGiven) {
      // Gate ALL capture behind explicit first-run consent.
      showConsentWindow();
    } else {
      createCompanionWindow();
      if (!s.paused) scheduler.start();
      applyPushToTalkShortcut();
      greet();
      maybeOfferNamePrompt();
    }

    app.on('activate', () => {
      if (store.get().consentGiven) showCompanionWindow();
      else showConsentWindow();
    });
  });

  // Keep running when windows close — Rocky lives in the tray.
  app.on('window-all-closed', () => {
    /* intentionally do not quit */
  });

  app.on('before-quit', (event) => {
    if (!forceQuitting && app.isReady() && store.get().consentGiven) {
      event.preventDefault();
      farewellAndQuit();
      return;
    }
    scheduler.dispose();
    focus.dispose();
    voiceNotes.dispose();
  });
}
