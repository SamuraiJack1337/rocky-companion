// First-run consent + provider setup window (renderer / browser context).
//
// This script runs with contextIsolation ON: it has NO Node, NO ipcRenderer,
// NO electron. It talks to the main process ONLY through `window.rocky`
// (typed by RockyAPI in shared/ipc.ts). It drives a single scrollable card:
//
//   1. The user must check "I understand, enable Rocky".
//   2. The user picks a provider: Local (Ollama, the private default) or
//      Cloud (OpenAI). Cloud requires an explicit opt-in checkbox AND a key
//      that has been saved + validated via window.rocky.setOpenAIKey().
//   3. "Enable Rocky" stays disabled until those conditions hold. On click it
//      (re)validates a cloud key if needed, then submits the consent payload.
//
// Privacy note: the API key is read straight from the input and handed to the
// main process for validation/encryption. It is never logged, stored in a
// variable longer than needed, or echoed back to the DOM.

import type { ProviderKind } from '../shared/types';

// ── Tiny typed DOM helpers ──────────────────────────────────────────────────

/** Query a required element by id, asserting its type. Throws if absent. */
function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`consent: missing #${id} in consent.html`);
  return node as T;
}

// Grab every element once. (consent.js is loaded at the end of <body>, so the
// DOM is already parsed by the time this runs.)
const understandBox = el<HTMLInputElement>('understand');

const radioLocal = el<HTMLInputElement>('provider-local');
const radioCloud = el<HTMLInputElement>('provider-cloud');
const optionLocal = el<HTMLLabelElement>('option-local');
const optionCloud = el<HTMLLabelElement>('option-cloud');

const panelLocal = el<HTMLDivElement>('panel-local');
const panelCloud = el<HTMLDivElement>('panel-cloud');

const ollamaHostInput = el<HTMLInputElement>('ollama-host');
const ollamaModelInput = el<HTMLInputElement>('ollama-model');
const checkOllamaBtn = el<HTMLButtonElement>('check-ollama');
const ollamaStatus = el<HTMLDivElement>('ollama-status');

const cloudOptIn = el<HTMLInputElement>('cloud-optin');
const openaiKeyInput = el<HTMLInputElement>('openai-key');
const validateKeyBtn = el<HTMLButtonElement>('validate-key');
const keyStatus = el<HTMLDivElement>('key-status');

const callNameInput = el<HTMLInputElement>('call-name');

const enableBtn = el<HTMLButtonElement>('enable');
const enableStatus = el<HTMLDivElement>('enable-status');

// ── Local UI state ───────────────────────────────────────────────────────────

/**
 * Tracks whether the CURRENT key in the input has been successfully saved +
 * validated by the main process. Editing the key field clears this so the user
 * cannot enable with a stale validation.
 */
let cloudKeyValidated = false;

/** Reflect a status line's tone via CSS classes (ok / warn / muted). */
function setStatus(node: HTMLElement, html: string, tone: 'ok' | 'warn' | 'muted'): void {
  node.className = `status ${tone}`;
  node.innerHTML = html;
}

/** The provider the user currently has selected. */
function selectedProvider(): ProviderKind {
  return radioCloud.checked ? 'cloud' : 'local';
}

// ── Enable-button gating ───────────────────────────────────────────────────────

/**
 * The single source of truth for whether "Enable Rocky" may be pressed:
 *   - understand box checked, AND
 *   - for cloud: opt-in checked AND a validated key in the field.
 * Local has no extra gate (continuing without Ollama is allowed; Rocky warns
 * about connectivity later, per spec).
 */
function refreshEnableState(): void {
  const understood = understandBox.checked;
  let ready = understood;
  let hint = '';

  if (!understood) {
    hint = '';
  } else if (selectedProvider() === 'cloud') {
    if (!cloudOptIn.checked) {
      ready = false;
      hint = 'Please agree to send screenshots to OpenAI.';
    } else if (!cloudKeyValidated) {
      ready = false;
      hint = 'Save and validate your OpenAI key first.';
    }
  }

  enableBtn.disabled = !ready;
  enableStatus.textContent = ready ? '' : hint;
}

// ── Provider selection ─────────────────────────────────────────────────────────

/** Show the panel for the chosen provider and update the option highlight. */
function applyProviderSelection(): void {
  const provider = selectedProvider();
  const isLocal = provider === 'local';

  optionLocal.classList.toggle('selected', isLocal);
  optionCloud.classList.toggle('selected', !isLocal);
  panelLocal.hidden = !isLocal;
  panelCloud.hidden = isLocal;

  refreshEnableState();
}

// ── Ollama connectivity check ──────────────────────────────────────────────────

async function handleCheckOllama(): Promise<void> {
  const host = ollamaHostInput.value.trim();
  const model = ollamaModelInput.value.trim();
  if (!host || !model) {
    setStatus(ollamaStatus, 'Please enter a host and a model name.', 'warn');
    return;
  }

  checkOllamaBtn.disabled = true;
  setStatus(ollamaStatus, '<span class="spin">Checking Ollama…</span>', 'muted');

  try {
    const result = await window.rocky.checkOllama(host, model);
    if (result.reachable && result.modelAvailable && result.modelResponsive !== false) {
      const secs = result.warmupMs != null ? Math.round(result.warmupMs / 100) / 10 : null;
      const timing = secs != null ? ` (first response took ${secs}s)` : '';
      setStatus(
        ollamaStatus,
        `Good. Ollama is reachable and <code>${escapeHtml(model)}</code> responds.${timing}`,
        'ok',
      );
    } else if (result.reachable && result.modelAvailable && result.modelResponsive === false) {
      const detail = result.error ? ` ${escapeHtml(result.error)}` : '';
      setStatus(
        ollamaStatus,
        `<code>${escapeHtml(model)}</code> is installed but did not respond in time.${detail}<br />` +
          `Try a lighter vision model like <code>moondream</code> or <code>gemma3:4b</code>. You can also continue anyway.`,
        'warn',
      );
    } else if (result.reachable && !result.modelAvailable) {
      const have = result.models.length
        ? ` Found: ${result.models.map(escapeHtml).join(', ')}.`
        : '';
      setStatus(
        ollamaStatus,
        `Ollama is running, but <code>${escapeHtml(model)}</code> is not installed.${have}<br />` +
          `Pull it with <code>ollama pull ${escapeHtml(model)}</code>. You can also continue anyway.`,
        'warn',
      );
    } else {
      const detail = result.error ? ` (${escapeHtml(result.error)})` : '';
      setStatus(
        ollamaStatus,
        `Could not reach Ollama at <code>${escapeHtml(host)}</code>${detail}.<br />` +
          `Start Ollama, then run <code>ollama pull ${escapeHtml(model)}</code>. ` +
          `You can continue anyway — Rocky will let you know if it still cannot see.`,
        'warn',
      );
    }
  } catch (err) {
    setStatus(
      ollamaStatus,
      `Could not check Ollama: ${escapeHtml(errMessage(err))}. You can continue anyway.`,
      'warn',
    );
  } finally {
    checkOllamaBtn.disabled = false;
  }
}

// ── Cloud key validation ───────────────────────────────────────────────────────

/**
 * Validate (and store) the key currently in the field. Returns true on success.
 * The main process performs a tiny test call and only persists on success.
 */
async function validateAndSaveKey(): Promise<boolean> {
  const key = openaiKeyInput.value.trim();
  if (!key) {
    setStatus(keyStatus, 'Please paste your OpenAI API key.', 'warn');
    cloudKeyValidated = false;
    refreshEnableState();
    return false;
  }

  validateKeyBtn.disabled = true;
  setStatus(keyStatus, '<span class="spin">Validating with OpenAI…</span>', 'muted');

  try {
    const result = await window.rocky.setOpenAIKey(key);
    if (result.ok) {
      cloudKeyValidated = true;
      setStatus(keyStatus, 'Good. Key validated and saved securely.', 'ok');
    } else {
      cloudKeyValidated = false;
      setStatus(keyStatus, `Key was not accepted: ${escapeHtml(result.error ?? 'unknown error')}.`, 'warn');
    }
    return result.ok;
  } catch (err) {
    cloudKeyValidated = false;
    setStatus(keyStatus, `Could not validate key: ${escapeHtml(errMessage(err))}.`, 'warn');
    return false;
  } finally {
    validateKeyBtn.disabled = false;
    refreshEnableState();
  }
}

// ── Enable (finish) ────────────────────────────────────────────────────────────

async function handleEnable(): Promise<void> {
  const provider = selectedProvider();

  // Guard again at submit time (button gating should already cover this).
  if (!understandBox.checked) return;

  enableBtn.disabled = true;
  let cloudConsent = false;

  if (provider === 'cloud') {
    if (!cloudOptIn.checked) {
      refreshEnableState();
      return;
    }
    cloudConsent = true;

    // If the key in the field has not been validated (or was edited since the
    // last validation), validate it now and bail out if it fails.
    if (!cloudKeyValidated) {
      const ok = await validateAndSaveKey();
      if (!ok) {
        refreshEnableState();
        return;
      }
    }
  }

  setStatus(enableStatus, '<span class="spin">Waking Rocky…</span>', 'muted');
  try {
    const callName = callNameInput.value.trim();
    await window.rocky.submitConsent({ provider, cloudConsent, callName: callName || undefined });
    // Main is expected to swap this window for the companion; nothing else to do.
  } catch (err) {
    setStatus(enableStatus, `Something went wrong: ${escapeHtml(errMessage(err))}.`, 'warn');
    refreshEnableState();
  }
}

// ── Small utilities ────────────────────────────────────────────────────────────

/** Escape user/host/model strings before placing them in innerHTML. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Best-effort message extraction without leaking unexpected shapes. */
function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'unexpected error';
}

// ── Wire up events ─────────────────────────────────────────────────────────────

understandBox.addEventListener('change', refreshEnableState);

radioLocal.addEventListener('change', applyProviderSelection);
radioCloud.addEventListener('change', applyProviderSelection);

checkOllamaBtn.addEventListener('click', () => void handleCheckOllama());

cloudOptIn.addEventListener('change', refreshEnableState);

// Editing the key invalidates any prior validation — the user must re-validate.
openaiKeyInput.addEventListener('input', () => {
  cloudKeyValidated = false;
  if (keyStatus.textContent) setStatus(keyStatus, '', 'muted');
  refreshEnableState();
});

validateKeyBtn.addEventListener('click', () => void validateAndSaveKey());

enableBtn.addEventListener('click', () => void handleEnable());

// ── Init: prefill host/model from saved settings, set initial gating ───────────

async function init(): Promise<void> {
  try {
    const settings = await window.rocky.getSettings();
    ollamaHostInput.value = settings.ollamaHost;
    ollamaModelInput.value = settings.ollamaModel;
    // Honor any previously-chosen provider (defaults to local in DEFAULT_SETTINGS).
    if (settings.provider === 'cloud') {
      radioCloud.checked = true;
    } else {
      radioLocal.checked = true;
    }
  } catch {
    // If settings cannot be read, the HTML defaults (empty fields, local) stand.
  } finally {
    applyProviderSelection();
    refreshEnableState();
  }
}

void init();
