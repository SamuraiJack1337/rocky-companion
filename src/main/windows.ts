// Window management: the always-on-top transparent companion window, plus the
// consent and settings windows. Keeps a single reference to each so they are
// reused rather than duplicated, and persists the companion's last position.

import { BrowserWindow, screen, app } from 'electron';
import path from 'node:path';
import { store } from './store';

// The companion window is intentionally small. It is bigger than the creature
// itself so the translator has room above without clipping.
const COMPANION_W = 225;
const COMPANION_H = 240;
const EDGE_MARGIN = 24;

const PRELOAD = path.join(__dirname, 'preload.js');
const RENDERER_DIR = path.join(__dirname, '..', 'renderer');

let companion: BrowserWindow | null = null;
let consent: BrowserWindow | null = null;
let settings: BrowserWindow | null = null;
let lab: BrowserWindow | null = null;
let chat: BrowserWindow | null = null;
let savePositionTimer: ReturnType<typeof setTimeout> | null = null;

/** Default bottom-right position on the primary display's work area. */
function defaultPosition(): { x: number; y: number } {
  const { workArea } = screen.getPrimaryDisplay();
  return {
    x: workArea.x + workArea.width - COMPANION_W - EDGE_MARGIN,
    y: workArea.y + workArea.height - COMPANION_H - EDGE_MARGIN,
  };
}

/** Clamp a saved position back onto a visible display (handles unplugged monitors). */
function visiblePosition(pos: { x: number; y: number } | null): { x: number; y: number } {
  if (!pos) return defaultPosition();
  const nearest = screen.getDisplayNearestPoint({ x: pos.x, y: pos.y });
  const { x, y, width, height } = nearest.workArea;
  const cx = Math.min(Math.max(pos.x, x), x + width - COMPANION_W);
  const cy = Math.min(Math.max(pos.y, y), y + height - COMPANION_H);
  return { x: cx, y: cy };
}

export function createCompanionWindow(): BrowserWindow {
  if (companion && !companion.isDestroyed()) {
    companion.showInactive();
    return companion;
  }

  const pos = visiblePosition(store.get().windowPosition);

  companion = new BrowserWindow({
    width: COMPANION_W,
    height: COMPANION_H,
    x: pos.x,
    y: pos.y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: true,
    show: false,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  companion.setAlwaysOnTop(true, 'floating');
  // Rocky should never appear in screenshots or screen shares, including his
  // own observation capture. This also prevents a visual feedback loop.
  companion.setContentProtection(true);
  companion.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  companion.loadFile(path.join(RENDERER_DIR, 'index.html'));

  // Persist position (debounced) when the user drags Rocky around.
  companion.on('moved', () => {
    if (!companion || companion.isDestroyed()) return;
    const [x, y] = companion.getPosition();
    if (savePositionTimer) clearTimeout(savePositionTimer);
    savePositionTimer = setTimeout(() => store.set({ windowPosition: { x, y } }), 400);
  });

  companion.on('closed', () => {
    companion = null;
  });

  // Apply persisted click-through preference once the window is ready.
  companion.once('ready-to-show', () => {
    setCompanionClickThrough(store.get().clickThrough);
    companion?.showInactive(); // appear without stealing focus
  });

  return companion;
}

export function getCompanionWindow(): BrowserWindow | null {
  return companion && !companion.isDestroyed() ? companion : null;
}

export function showCompanionWindow(): void {
  const win = createCompanionWindow();
  win.showInactive();
}

export function hideCompanionWindow(): void {
  if (companion && !companion.isDestroyed()) companion.hide();
}

export function isCompanionVisible(): boolean {
  return !!companion && !companion.isDestroyed() && companion.isVisible();
}

export function toggleCompanion(): void {
  if (isCompanionVisible()) hideCompanionWindow();
  else showCompanionWindow();
}

/** When enabled the window ignores mouse events so it floats over work. */
export function setCompanionClickThrough(enabled: boolean): void {
  if (companion && !companion.isDestroyed()) {
    companion.setIgnoreMouseEvents(enabled, { forward: true });
  }
}

export function showConsentWindow(): BrowserWindow {
  if (consent && !consent.isDestroyed()) {
    consent.focus();
    return consent;
  }
  consent = new BrowserWindow({
    width: 560,
    height: 680,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'Welcome to Rocky',
    backgroundColor: '#1b1f27',
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  consent.loadFile(path.join(RENDERER_DIR, 'consent.html'));
  consent.on('closed', () => {
    consent = null;
  });
  return consent;
}

export function closeConsentWindow(): void {
  if (consent && !consent.isDestroyed()) consent.close();
  consent = null;
}

export function showSettingsWindow(): BrowserWindow {
  if (settings && !settings.isDestroyed()) {
    settings.focus();
    return settings;
  }
  settings = new BrowserWindow({
    width: 580,
    height: 720,
    resizable: true,
    minimizable: true,
    maximizable: false,
    fullscreenable: false,
    title: 'Rocky Settings',
    backgroundColor: '#1b1f27',
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  settings.loadFile(path.join(RENDERER_DIR, 'settings.html'));
  settings.on('closed', () => {
    settings = null;
  });
  return settings;
}

export function showLabWindow(): BrowserWindow {
  if (lab && !lab.isDestroyed()) {
    lab.focus();
    return lab;
  }
  lab = new BrowserWindow({
    width: 560,
    height: 720,
    minWidth: 500,
    minHeight: 620,
    resizable: true,
    minimizable: true,
    maximizable: false,
    fullscreenable: false,
    title: 'Rocky Lab',
    backgroundColor: '#151817',
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  lab.loadFile(path.join(RENDERER_DIR, 'lab.html'));
  lab.on('closed', () => { lab = null; });
  return lab;
}

export function showChatWindow(): BrowserWindow {
  if (chat && !chat.isDestroyed()) {
    chat.focus();
    return chat;
  }
  chat = new BrowserWindow({
    width: 620,
    height: 760,
    minWidth: 480,
    minHeight: 560,
    resizable: true,
    minimizable: true,
    maximizable: true,
    fullscreenable: false,
    title: 'Rocky Notes',
    backgroundColor: '#12151c',
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  chat.loadFile(path.join(RENDERER_DIR, 'chat.html'));
  chat.on('closed', () => { chat = null; });
  return chat;
}

/** Send a push event to one window, queued until its frame finishes loading. */
function sendToWindow(target: BrowserWindow | null, channel: string, payload?: unknown): void {
  if (!target || target.isDestroyed()) return;
  if (target.webContents.isLoadingMainFrame()) {
    target.webContents.once('did-finish-load', () => {
      if (!target.isDestroyed()) target.webContents.send(channel, payload);
    });
  } else {
    target.webContents.send(channel, payload);
  }
}

/** Send a push event to the companion window only. */
export function sendToCompanion(channel: string, payload?: unknown): void {
  sendToWindow(companion, channel, payload);
}

/** Send a push event to the chat window (queued while it is still loading). */
export function sendToChat(channel: string, payload?: unknown): void {
  sendToWindow(chat, channel, payload);
}

/** Broadcast a push event to every live window (companion + any open aux windows). */
export function broadcast(channel: string, payload?: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

/** Hide Rocky from the macOS Dock — he lives in the menu bar and on screen. */
export function hideDock(): void {
  if (process.platform === 'darwin' && app.dock) app.dock.hide();
}
