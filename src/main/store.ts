// Non-secret settings persistence. Lives at userData/settings.json as plain
// JSON — it must NEVER hold secrets (the OpenAI key is encrypted separately by
// main/keys.ts). Reads are merged over DEFAULT_SETTINGS so older/partial files
// always produce a complete, valid Settings object. Writes are atomic (temp
// file + rename) so a crash mid-write can't corrupt the saved settings.

import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import type { Settings } from '../shared/types';
import { DEFAULT_SETTINGS, clampInterval } from '../shared/types';
import { hasOpenAIKey } from './keys';
import { migrateLegacyTtsConsent } from './settingsMigrations';

function isLoopbackHost(host: string): boolean {
  try {
    const url = new URL(host);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]')
    );
  } catch {
    return false;
  }
}

type Listener = (s: Settings) => void;

/** Trim/limit the call-name; empty or non-string falls back to the default. */
function normalizeCallName(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_SETTINGS.callName;
  const cleaned = value.replace(/[\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 24).trim();
  return cleaned || DEFAULT_SETTINGS.callName;
}

/** Trim a free-text settings field to a cap; non-strings fall back. */
function normalizeShortField(value: unknown, fallback: string, max: number): string {
  if (typeof value !== 'string') return fallback;
  const cleaned = value.replace(/[\r\n\t]/g, ' ').trim().slice(0, max).trim();
  return cleaned || fallback;
}

function normalizeBlockedApps(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const name = item.trim().slice(0, 100);
    const key = name.toLocaleLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    result.push(name);
    if (result.length >= 100) break;
  }
  return result;
}

function snapshot(settings: Settings): Settings {
  return {
    ...settings,
    blockedApps: [...settings.blockedApps],
    windowPosition: settings.windowPosition ? { ...settings.windowPosition } : null,
  };
}

function normalizeWindowPosition(value: unknown): Settings['windowPosition'] {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as { x?: unknown; y?: unknown };
  if (
    typeof candidate.x !== 'number' ||
    !Number.isFinite(candidate.x) ||
    typeof candidate.y !== 'number' ||
    !Number.isFinite(candidate.y)
  ) {
    return null;
  }
  return { x: Math.round(candidate.x), y: Math.round(candidate.y) };
}

/**
 * Single source of truth for persisted, non-secret settings. The in-memory
 * `current` value is the merged, validated Settings; disk is just a cache of it.
 */
class SettingsStore {
  private current: Settings;
  private readonly listeners = new Set<Listener>();
  private loaded = false;

  constructor() {
    // Lazy initial value; the real load happens on first get() because
    // app.getPath('userData') is only reliable after the app is ready.
    this.current = { ...DEFAULT_SETTINGS };
  }

  /** Absolute path to the settings file inside the OS userData directory. */
  private filePath(): string {
    return path.join(app.getPath('userData'), 'settings.json');
  }

  /**
   * Read + validate the persisted file once. On a missing file we seed a few
   * non-secret fields from environment variables (handy for dev/CI). On corrupt
   * JSON we silently fall back to defaults rather than crashing.
   */
  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;

    let raw: string | null = null;
    try {
      raw = fs.readFileSync(this.filePath(), 'utf8');
    } catch {
      // No file yet (first run) or unreadable — seed from env and persist.
      this.current = this.merge(this.seedFromEnv({ ...DEFAULT_SETTINGS }));
      this.writeAtomic(this.current);
      return;
    }

    try {
      const parsed = JSON.parse(raw) as Partial<Settings>;
      const repaired = migrateLegacyTtsConsent(parsed, hasOpenAIKey());
      this.current = this.merge(repaired);
      // Persist the repair so the file carries the field from now on.
      if (repaired !== parsed) this.writeAtomic(this.current);
    } catch {
      // Corrupt JSON — repair in place (mirror the missing-file branch) so the
      // bad file self-heals and env seeding still applies, instead of silently
      // re-hitting the corrupt path on every launch.
      this.current = this.merge(this.seedFromEnv({ ...DEFAULT_SETTINGS }));
      this.writeAtomic(this.current);
    }
  }

  /** Merge a partial (possibly untrusted) object over the defaults. */
  private merge(patch: Partial<Settings>): Settings {
    const merged: Settings = { ...DEFAULT_SETTINGS, ...patch };
    // The interval is the one field with a hard range invariant.
    merged.intervalMinutes = clampInterval(merged.intervalMinutes);
    merged.blockedApps = normalizeBlockedApps(merged.blockedApps);
    merged.windowPosition = normalizeWindowPosition(merged.windowPosition);
    merged.callName = normalizeCallName(merged.callName);
    if (merged.remarkStyle !== 'classic' && merged.remarkStyle !== 'realistic') {
      merged.remarkStyle = DEFAULT_SETTINGS.remarkStyle;
    }
    if (!isLoopbackHost(merged.ollamaHost)) {
      merged.ollamaHost = DEFAULT_SETTINGS.ollamaHost;
    }
    // Privacy invariant, enforced at the mutation point: the cloud provider can
    // never be active without explicit cloud consent. If a patch (from any IPC
    // sender) tries to select cloud without consent, coerce back to local. This
    // is defense-in-depth alongside the renderer guard and the provider factory.
    if (merged.provider === 'cloud' && !merged.cloudConsentGiven) {
      merged.provider = 'local';
    }
    // Same invariant for the speech backend: note audio may only go to the
    // cloud with the separate notes-cloud consent. (The SpeechProvider factory
    // re-checks this; store-level coercion is defense-in-depth, as above.)
    if (merged.speechProvider !== 'local' && merged.speechProvider !== 'cloud') {
      merged.speechProvider = DEFAULT_SETTINGS.speechProvider;
    }
    if (merged.speechProvider === 'cloud' && !merged.notesCloudConsentGiven) {
      merged.speechProvider = 'local';
    }
    merged.pushToTalkShortcut = normalizeShortField(
      merged.pushToTalkShortcut,
      DEFAULT_SETTINGS.pushToTalkShortcut,
      64,
    );
    merged.whisperCliPath = normalizeShortField(
      merged.whisperCliPath,
      DEFAULT_SETTINGS.whisperCliPath,
      512,
    );
    merged.whisperModelPath = normalizeShortField(merged.whisperModelPath, '', 512);
    merged.sttModel = normalizeShortField(merged.sttModel, DEFAULT_SETTINGS.sttModel, 64);
    merged.ollamaChatModel = normalizeShortField(merged.ollamaChatModel, '', 64);
    merged.ollamaEmbedModel = normalizeShortField(
      merged.ollamaEmbedModel,
      DEFAULT_SETTINGS.ollamaEmbedModel,
      64,
    );
    merged.openaiEmbedModel = normalizeShortField(
      merged.openaiEmbedModel,
      DEFAULT_SETTINGS.openaiEmbedModel,
      64,
    );
    return merged;
  }

  /**
   * On first run, fill non-secret provider fields from env if present. We only
   * touch model/host names here — never any secret (the API key never lives in
   * this file). Empty/undefined env vars leave the defaults intact.
   */
  private seedFromEnv(base: Settings): Settings {
    const seeded = { ...base };
    const openaiModel = process.env.OPENAI_MODEL?.trim();
    const ollamaHost = process.env.OLLAMA_HOST?.trim();
    const ollamaModel = process.env.OLLAMA_MODEL?.trim();
    if (openaiModel) seeded.openaiModel = openaiModel;
    if (ollamaHost) seeded.ollamaHost = ollamaHost;
    if (ollamaModel) seeded.ollamaModel = ollamaModel;
    return seeded;
  }

  /**
   * Atomic write: serialize to a temp file in the same directory, then rename
   * over the target. rename() is atomic on the same filesystem, so readers
   * never observe a half-written file.
   */
  private writeAtomic(value: Settings): void {
    const target = this.filePath();
    const dir = path.dirname(target);
    try {
      fs.mkdirSync(dir, { recursive: true });
      const tmp = path.join(dir, `settings.json.${process.pid}.tmp`);
      fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
      fs.renameSync(tmp, target);
    } catch (err) {
      // Persisting is best-effort; the in-memory value still governs runtime.
      console.error('[store] failed to persist settings:', (err as Error).message);
    }
  }

  /** Get the current, fully-merged settings. Loads from disk on first call. */
  get(): Settings {
    this.ensureLoaded();
    return snapshot(this.current);
  }

  /**
   * Shallow-merge a patch, persist atomically, notify listeners, and return the
   * new merged Settings. Listener errors are isolated so one bad subscriber
   * can't break the others or the write.
   */
  set(patch: Partial<Settings>): Settings {
    this.ensureLoaded();
    this.current = this.merge({ ...this.current, ...patch });
    this.writeAtomic(this.current);

    const currentSnapshot = snapshot(this.current);
    for (const cb of this.listeners) {
      try {
        cb(snapshot(currentSnapshot));
      } catch (err) {
        console.error('[store] settings listener threw:', (err as Error).message);
      }
    }
    return currentSnapshot;
  }

  /** Subscribe to settings changes. Returns an unsubscribe function. */
  on(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }
}

/** Process-wide singleton settings store. */
export const store = new SettingsStore();
