// Settings window renderer.
//
// Browser context (contextIsolation ON). The ONLY privileged surface is
// `window.rocky`, typed by RockyAPI. No Node, no ipcRenderer, no electron.
//
// Responsibilities:
//   - Load current Settings and reflect them into the form.
//   - Stay in sync via onSettingsUpdated (e.g. tray toggles changed something).
//   - Check Ollama reachability / model availability.
//   - Manage the cloud privacy gate: an explicit consent checkbox + a stored
//     OpenAI key. The key is set/removed through main and is NEVER displayed.
//   - Probe and surface macOS Screen Recording permission.
//   - On Save, build a Settings patch and persist it — but GUARD the switch to
//     cloud so it requires both consent and a stored key.

import type { Settings, ScreenPermissionStatus, SkinInfo } from '../shared/types';
import {
  clampInterval,
  INTERVAL_MIN,
  INTERVAL_MAX,
  DEFAULT_SETTINGS,
  DEFAULT_TTS_INSTRUCTIONS,
  PROCEDURAL_SKIN,
} from '../shared/types';
import { SpokenVoice } from './spokenVoice';

const VOICE_PITCH_MIN = -6;
const VOICE_PITCH_MAX = 3;
const clampPitch = (n: number): number =>
  Math.min(VOICE_PITCH_MAX, Math.max(VOICE_PITCH_MIN, Math.round(Number.isFinite(n) ? n : 0)));

/** Audition player for the "Play test line" button (settings window only). */
const auditioner = new SpokenVoice();

// ── Tiny typed DOM helpers ──────────────────────────────────────────────────

/** Get an element by id, asserting its type. Throws early if the HTML drifts. */
function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`settings.html is missing #${id}`);
  return node as T;
}

/** Toggle a status line's text + severity class. */
function setStatus(
  node: HTMLElement,
  text: string,
  kind: 'ok' | 'warn' | 'err' | 'muted' = 'muted',
): void {
  node.textContent = text;
  node.className = `status ${kind}`;
}

// ── Element references ───────────────────────────────────────────────────────

const providerLocal = el<HTMLInputElement>('provider-local');
const providerCloud = el<HTMLInputElement>('provider-cloud');
const providerLocalCard = el<HTMLLabelElement>('provider-local-card');
const providerCloudCard = el<HTMLLabelElement>('provider-cloud-card');

const ollamaHost = el<HTMLInputElement>('ollama-host');
const ollamaModel = el<HTMLInputElement>('ollama-model');
const checkOllamaBtn = el<HTMLButtonElement>('check-ollama');
const ollamaStatus = el<HTMLDivElement>('ollama-status');

const cloudConsent = el<HTMLInputElement>('cloud-consent');
const openaiKeyInput = el<HTMLInputElement>('openai-key');
const saveKeyBtn = el<HTMLButtonElement>('save-key');
const removeKeyBtn = el<HTMLButtonElement>('remove-key');
const keyStatus = el<HTMLDivElement>('key-status');
const openaiModel = el<HTMLInputElement>('openai-model');

const callNameInput = el<HTMLInputElement>('call-name');
const intervalRange = el<HTMLInputElement>('interval-range');
const intervalNumber = el<HTMLInputElement>('interval');
const mutedInput = el<HTMLInputElement>('muted');
const updateCheckInput = el<HTMLInputElement>('update-check');
const clickThroughInput = el<HTMLInputElement>('click-through');
const blockedAppsInput = el<HTMLTextAreaElement>('blocked-apps');
const blockedAppsStatus = el<HTMLDivElement>('blocked-apps-status');

const voiceMode = el<HTMLSelectElement>('voice-mode');
const ttsFields = el<HTMLDivElement>('tts-fields');
const ttsVoice = el<HTMLSelectElement>('tts-voice');
const ttsModel = el<HTMLSelectElement>('tts-model');
const ttsConsentInput = el<HTMLInputElement>('tts-consent');
const ttsInstructions = el<HTMLTextAreaElement>('tts-instructions');
const voicePitchRange = el<HTMLInputElement>('voice-pitch-range');
const voicePitchNumber = el<HTMLInputElement>('voice-pitch');
const musicUnderlayInput = el<HTMLInputElement>('music-underlay');
const expressiveCadenceInput = el<HTMLInputElement>('expressive-cadence');
const testVoiceBtn = el<HTMLButtonElement>('test-voice');
const voiceStatus = el<HTMLDivElement>('voice-status');

const creatureSkinSelect = el<HTMLSelectElement>('creature-skin');
const openSkinsFolderBtn = el<HTMLButtonElement>('open-skins-folder');
const refreshSkinsBtn = el<HTMLButtonElement>('refresh-skins');
const skinStatus = el<HTMLDivElement>('skin-status');

const screenStatus = el<HTMLDivElement>('screen-status');
const openScreenBtn = el<HTMLButtonElement>('open-screen-settings');
const recheckScreenBtn = el<HTMLButtonElement>('recheck-screen');
const relaunchBtn = el<HTMLButtonElement>('relaunch-app');
const screenHint = el<HTMLDivElement>('screen-hint');

const saveBtn = el<HTMLButtonElement>('save-btn');
const closeBtn = el<HTMLButtonElement>('close-btn');
const saveStatus = el<HTMLDivElement>('save-status');

// ── Local UI state ───────────────────────────────────────────────────────────

/** Last settings we loaded from main; used as the base for the Save patch. */
let current: Settings = { ...DEFAULT_SETTINGS };
/** Whether a cloud key is currently stored (per hasOpenAIKey). Never the key. */
let keyStored = false;
/** Guards against re-entrant form fills clobbering in-flight user edits. */
let applyingSettings = false;

// ── Provider selection / section visibility ──────────────────────────────────

/** Reflect the chosen provider into the radio cards' selected styling. */
function paintProviderCards(): void {
  providerLocalCard.classList.toggle('selected', providerLocal.checked);
  providerCloudCard.classList.toggle('selected', providerCloud.checked);
}

// ── Cloud key status ─────────────────────────────────────────────────────────

/** Refresh the "key stored?" line and toggle the Remove button. NEVER shows the key. */
function paintKeyStatus(): void {
  if (keyStored) {
    setStatus(keyStatus, 'A key is stored (hidden). Save a new one to replace it.', 'ok');
    removeKeyBtn.disabled = false;
  } else {
    setStatus(keyStatus, 'No key stored.', 'muted');
    removeKeyBtn.disabled = true;
  }
  // The spoken-voice test needs the cloud key too.
  paintVoiceFields();
}

/** Ask main whether a key exists, then repaint. */
async function refreshKeyStored(): Promise<void> {
  try {
    keyStored = await window.rocky.hasOpenAIKey();
  } catch {
    keyStored = false;
  }
  paintKeyStatus();
}

// ── Filling the form from Settings ───────────────────────────────────────────

/** Apply a Settings object to all controls. Used on load and on live updates. */
function applySettings(s: Settings): void {
  applyingSettings = true;
  current = s;

  providerLocal.checked = s.provider === 'local';
  providerCloud.checked = s.provider === 'cloud';
  paintProviderCards();

  ollamaHost.value = s.ollamaHost;
  ollamaModel.value = s.ollamaModel;

  cloudConsent.checked = s.cloudConsentGiven;
  openaiModel.value = s.openaiModel;

  callNameInput.value = s.callName;

  const minutes = clampInterval(s.intervalMinutes);
  intervalRange.value = String(minutes);
  intervalNumber.value = String(minutes);

  mutedInput.checked = s.muted;
  updateCheckInput.checked = s.updateCheckEnabled;
  clickThroughInput.checked = s.clickThrough;
  blockedAppsInput.value = s.blockedApps.join('\n');
  paintBlockedAppsStatus();

  voiceMode.value = s.voiceMode;
  ttsVoice.value = s.ttsVoice;
  ttsModel.value = s.ttsModel;
  ttsConsentInput.checked = s.ttsConsentGiven;
  ttsInstructions.value = s.ttsInstructions;
  const pitch = clampPitch(s.voicePitch);
  voicePitchRange.value = String(pitch);
  voicePitchNumber.value = String(pitch);
  musicUnderlayInput.checked = s.musicUnderlay;
  expressiveCadenceInput.checked = s.expressiveCadence;
  // Selecting only sticks if the option exists; populateSkins() runs on init.
  creatureSkinSelect.value = s.creatureSkin;
  paintVoiceFields();

  applyingSettings = false;
}

/** Fill the creature-skin dropdown from the available skins, keeping selection. */
async function populateSkins(): Promise<void> {
  let skins: SkinInfo[];
  try {
    skins = await window.rocky.listSkins();
  } catch {
    skins = [{ name: PROCEDURAL_SKIN, displayName: 'Rocky — faceless procedural', builtIn: true }];
  }
  const want = creatureSkinSelect.value || current.creatureSkin || PROCEDURAL_SKIN;
  creatureSkinSelect.innerHTML = '';
  for (const skin of skins) {
    const opt = document.createElement('option');
    opt.value = skin.name;
    opt.textContent = skin.displayName;
    creatureSkinSelect.appendChild(opt);
  }
  creatureSkinSelect.value = skins.some((s) => s.name === want) ? want : PROCEDURAL_SKIN;
  const extra = skins.length - 1;
  setStatus(skinStatus, extra > 0 ? `${extra} custom skin${extra === 1 ? '' : 's'} found.` : 'No custom skins yet.', 'muted');
}

/** Show the TTS sub-fields only in spoken mode; gate the test button on a key. */
function paintVoiceFields(): void {
  ttsFields.classList.toggle('hidden', voiceMode.value !== 'openai');
  testVoiceBtn.disabled = !keyStored || !current.ttsConsentGiven;
  // The delivery-style box only affects gpt-4o-* TTS; tts-1 / tts-1-hd ignore it.
  const styled = /gpt/i.test(ttsModel.value);
  ttsInstructions.disabled = !styled;
  ttsInstructions.style.opacity = styled ? '1' : '0.5';

  // Surface the two silent-voice traps up front instead of at synthesis time.
  if (voiceMode.value === 'openai' && !ttsConsentInput.checked) {
    setStatus(voiceStatus, 'Spoken voice stays silent until you tick the consent box above and save.', 'warn');
  } else if (voiceMode.value === 'openai' && !keyStored) {
    setStatus(voiceStatus, 'Spoken voice needs an OpenAI key — save one in the Cloud section.', 'warn');
  } else if (voiceMode.value === 'openai') {
    setStatus(voiceStatus, 'Spoken voice ready. Save, then test the line.', 'muted');
  }
}

/** Parse one app-name pattern per line, preserving spelling while deduplicating case-insensitively. */
function readBlockedApps(): string[] {
  const seen = new Set<string>();
  const patterns: string[] = [];
  for (const raw of blockedAppsInput.value.split(/\r?\n/)) {
    const pattern = raw.trim().slice(0, 100);
    const key = pattern.toLocaleLowerCase();
    if (!pattern || seen.has(key)) continue;
    seen.add(key);
    patterns.push(pattern);
    if (patterns.length === 100) break;
  }
  return patterns;
}

function paintBlockedAppsStatus(): void {
  const count = readBlockedApps().length;
  setStatus(
    blockedAppsStatus,
    count === 0
      ? 'No apps excluded.'
      : `${count} app pattern${count === 1 ? '' : 's'} excluded from automatic capture.`,
    count === 0 ? 'muted' : 'ok',
  );
}

// ── Screen Recording permission ──────────────────────────────────────────────

function paintScreenPermission(status: ScreenPermissionStatus): void {
  const granted = status === 'granted';
  if (granted) {
    setStatus(screenStatus, 'Granted — Rocky can see your screen.', 'ok');
    openScreenBtn.classList.add('hidden');
    relaunchBtn.classList.add('hidden');
    screenHint.classList.add('hidden');
    return;
  }

  const label: Record<Exclude<ScreenPermissionStatus, 'granted'>, string> = {
    denied: 'Denied — Rocky cannot see your screen.',
    restricted: 'Restricted by system policy.',
    'not-determined': 'Not yet granted.',
    unknown: 'Permission state unknown.',
  };
  setStatus(screenStatus, label[status], status === 'denied' ? 'err' : 'warn');
  openScreenBtn.classList.remove('hidden');
  relaunchBtn.classList.remove('hidden');
  screenHint.classList.remove('hidden');
}

async function refreshScreenPermission(): Promise<void> {
  setStatus(screenStatus, 'Checking…', 'muted');
  try {
    const status = await window.rocky.checkScreenPermission();
    paintScreenPermission(status);
  } catch {
    paintScreenPermission('unknown');
  }
}

// ── Event wiring ──────────────────────────────────────────────────────────────

// Provider radios — repaint selection styling immediately on change.
providerLocal.addEventListener('change', paintProviderCards);
providerCloud.addEventListener('change', paintProviderCards);

// Keep the range slider and the number box in lockstep, both clamped to [1,120].
function syncIntervalFrom(source: HTMLInputElement): void {
  const minutes = clampInterval(Number(source.value));
  intervalRange.value = String(minutes);
  intervalNumber.value = String(minutes);
}
intervalRange.addEventListener('input', () => syncIntervalFrom(intervalRange));
// Number box: clamp on commit (change/blur) so typing intermediate values is fine.
intervalNumber.addEventListener('change', () => syncIntervalFrom(intervalNumber));

// Click-through is special: apply live to the window AND persist on Save.
clickThroughInput.addEventListener('change', () => {
  // Fire-and-forget the live toggle; Save will persist the value too.
  void window.rocky.setClickThrough(clickThroughInput.checked);
});
blockedAppsInput.addEventListener('input', paintBlockedAppsStatus);

// Voice mode toggles the spoken-voice sub-fields; model toggles style-box use.
voiceMode.addEventListener('change', paintVoiceFields);
ttsModel.addEventListener('change', paintVoiceFields);
ttsConsentInput.addEventListener('change', paintVoiceFields);

// Keep the pitch slider and number box in lockstep, clamped to range.
function syncPitchFrom(source: HTMLInputElement): void {
  const v = clampPitch(Number(source.value));
  voicePitchRange.value = String(v);
  voicePitchNumber.value = String(v);
}
voicePitchRange.addEventListener('input', () => syncPitchFrom(voicePitchRange));
voicePitchNumber.addEventListener('change', () => syncPitchFrom(voicePitchNumber));

// Audition the chosen voice with the current (possibly unsaved) form values.
testVoiceBtn.addEventListener('click', async () => {
  const overrides = {
    ttsVoice: ttsVoice.value,
    ttsModel: ttsModel.value,
    ttsInstructions: ttsInstructions.value.trim(),
    expressiveCadence: expressiveCadenceInput.checked,
  };
  testVoiceBtn.disabled = true;
  setStatus(voiceStatus, 'Synthesizing…', 'muted');
  try {
    const segments = await window.rocky.speakLine('Buddy. You are here. I see you. We work, question?', overrides);
    if (!segments || segments.length === 0) {
      setStatus(
        voiceStatus,
        keyStored ? 'Could not synthesize — check the model/voice.' : 'Save a valid OpenAI key first.',
        keyStored ? 'err' : 'warn',
      );
      return;
    }
    await auditioner.playSequence(segments, clampPitch(Number(voicePitchNumber.value)));
    setStatus(voiceStatus, 'Playing test line.', 'ok');
  } catch {
    setStatus(voiceStatus, 'Test failed.', 'err');
  } finally {
    testVoiceBtn.disabled = !keyStored || !current.ttsConsentGiven;
  }
});

// Check Ollama: probe reachability + model availability.
checkOllamaBtn.addEventListener('click', async () => {
  const host = ollamaHost.value.trim() || DEFAULT_SETTINGS.ollamaHost;
  const model = ollamaModel.value.trim() || DEFAULT_SETTINGS.ollamaModel;
  checkOllamaBtn.disabled = true;
  setStatus(ollamaStatus, 'Checking Ollama…', 'muted');
  try {
    const result = await window.rocky.checkOllama(host, model);
    if (!result.reachable) {
      const why = result.error ? ` (${result.error})` : '';
      setStatus(ollamaStatus, `Cannot reach Ollama at ${host}.${why} Is it running?`, 'err');
    } else if (!result.modelAvailable) {
      // Model is missing — advise the exact pull command.
      setStatus(
        ollamaStatus,
        `Reachable, but model "${model}" is not installed. Run: ollama pull ${model}`,
        'warn',
      );
    } else {
      setStatus(ollamaStatus, `Reachable and "${model}" is ready. Good.`, 'ok');
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setStatus(ollamaStatus, `Check failed: ${msg}`, 'err');
  } finally {
    checkOllamaBtn.disabled = false;
  }
});

// Save key: validate via main (which makes a tiny test call), then store encrypted.
saveKeyBtn.addEventListener('click', async () => {
  const key = openaiKeyInput.value.trim();
  if (!key) {
    setStatus(keyStatus, 'Enter a key first.', 'warn');
    return;
  }
  saveKeyBtn.disabled = true;
  setStatus(keyStatus, 'Validating…', 'muted');
  try {
    const result = await window.rocky.setOpenAIKey(key);
    if (result.ok) {
      // Clear the input so the secret never lingers in the DOM.
      openaiKeyInput.value = '';
      keyStored = true;
      paintKeyStatus();
    } else {
      setStatus(keyStatus, result.error ? `Invalid key: ${result.error}` : 'Invalid key.', 'err');
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setStatus(keyStatus, `Could not save key: ${msg}`, 'err');
  } finally {
    saveKeyBtn.disabled = false;
  }
});

// Remove key: delete from the keychain via main.
removeKeyBtn.addEventListener('click', async () => {
  removeKeyBtn.disabled = true;
  try {
    await window.rocky.deleteOpenAIKey();
  } catch {
    // Ignore — refreshKeyStored below reflects the real state.
  }
  openaiKeyInput.value = '';
  await refreshKeyStored();
});

// Screen permission buttons.
openScreenBtn.addEventListener('click', () => {
  void window.rocky.openScreenSettings();
  setStatus(
    screenStatus,
    'Opened System Settings. Grant Screen Recording, then relaunch Rocky.',
    'warn',
  );
});
recheckScreenBtn.addEventListener('click', () => void refreshScreenPermission());
relaunchBtn.addEventListener('click', () => void window.rocky.relaunchApp());

// Creature skin: open the folder to drop art in, and re-scan for new skins.
openSkinsFolderBtn.addEventListener('click', () => {
  void window.rocky.openSkinsFolder();
  setStatus(skinStatus, 'Opened skins folder. Add a skin folder, then Refresh.', 'muted');
});
refreshSkinsBtn.addEventListener('click', () => void populateSkins());

// Close just closes this window (settings persist only via Save).
closeBtn.addEventListener('click', () => window.rocky.closeSelf());

// ── Save ──────────────────────────────────────────────────────────────────────

saveBtn.addEventListener('click', async () => {
  const wantsCloud = providerCloud.checked;

  // GUARD: switching to cloud requires explicit consent AND a stored key.
  // If either is missing, keep the provider unchanged and explain inline.
  if (wantsCloud) {
    if (!cloudConsent.checked) {
      setStatus(
        saveStatus,
        'To use cloud, tick "I understand and want to use cloud" first.',
        'err',
      );
      return;
    }
    if (!keyStored) {
      setStatus(saveStatus, 'To use cloud, save a valid OpenAI key first.', 'err');
      return;
    }
  }

  if (voiceMode.value === 'openai') {
    if (!ttsConsentInput.checked) {
      setStatus(saveStatus, 'To use spoken translation, agree to send its text to OpenAI first.', 'err');
      return;
    }
    if (!keyStored) {
      setStatus(saveStatus, 'To use spoken translation, save a valid OpenAI key first.', 'err');
      return;
    }
  }

  // Build the patch from the current form. Interval is clamped defensively.
  const patch: Partial<Settings> = {
    provider: wantsCloud ? 'cloud' : 'local',
    ollamaHost: ollamaHost.value.trim() || DEFAULT_SETTINGS.ollamaHost,
    ollamaModel: ollamaModel.value.trim() || DEFAULT_SETTINGS.ollamaModel,
    openaiModel: openaiModel.value.trim() || DEFAULT_SETTINGS.openaiModel,
    cloudConsentGiven: cloudConsent.checked,
    callName: callNameInput.value.trim() || DEFAULT_SETTINGS.callName,
    intervalMinutes: clampInterval(Number(intervalNumber.value)),
    muted: mutedInput.checked,
    updateCheckEnabled: updateCheckInput.checked,
    clickThrough: clickThroughInput.checked,
    blockedApps: readBlockedApps(),
    voiceMode: voiceMode.value === 'openai' ? 'openai' : 'procedural',
    ttsVoice: ttsVoice.value,
    ttsModel: ttsModel.value,
    ttsConsentGiven: ttsConsentInput.checked,
    ttsInstructions: ttsInstructions.value.trim() || DEFAULT_TTS_INSTRUCTIONS,
    voicePitch: clampPitch(Number(voicePitchNumber.value)),
    musicUnderlay: musicUnderlayInput.checked,
    expressiveCadence: expressiveCadenceInput.checked,
    creatureSkin: creatureSkinSelect.value || PROCEDURAL_SKIN,
  };

  saveBtn.disabled = true;
  setStatus(saveStatus, 'Saving…', 'muted');
  try {
    const updated = await window.rocky.setSettings(patch);
    // Reflect the canonical result back into the form (main may normalize).
    applySettings(updated);
    setStatus(saveStatus, 'Saved. Good.', 'ok');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setStatus(saveStatus, `Could not save: ${msg}`, 'err');
  } finally {
    saveBtn.disabled = false;
  }
});

// ── Boot ────────────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  // Fill the skin dropdown first so applySettings can select the saved skin.
  await populateSkins();

  // Load persisted settings and fill the form.
  try {
    const s = await window.rocky.getSettings();
    applySettings(s);
  } catch {
    applySettings({ ...DEFAULT_SETTINGS });
  }

  // Stay in sync if settings change elsewhere (e.g. tray menu). Don't stomp on
  // the form while the user is mid-edit of an unrelated control — applySettings
  // is cheap and the guard flag prevents feedback loops with our own handlers.
  window.rocky.onSettingsUpdated((s) => {
    if (!applyingSettings) applySettings(s);
  });

  // Independent async probes.
  await Promise.all([refreshKeyStored(), refreshScreenPermission()]);

  // Reflect the clamp range into the inputs (belt-and-suspenders vs. HTML attrs).
  intervalRange.min = String(INTERVAL_MIN);
  intervalRange.max = String(INTERVAL_MAX);
  intervalNumber.min = String(INTERVAL_MIN);
  intervalNumber.max = String(INTERVAL_MAX);
}

void init();
