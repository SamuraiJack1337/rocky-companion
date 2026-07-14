// The pluggable vision layer. Rocky's "eyes" come in two flavors — a private,
// on-device Ollama backend (the default) and an optional cloud OpenAI backend
// (bring-your-own-key). BOTH must behave identically: same buildSystemPrompt,
// same buildUserPrompt, same observation parser. This file defines the shared
// contract and a tiny factory that picks the right implementation from the
// user's settings.
//
// Privacy note: the image bytes (base64) only ever flow through analyze() in
// memory. Nothing here writes them to disk or logs them.

import type { Activity, ProviderKind, RemarkStyle, ScreenObservation, Settings } from '../../shared/types';
import { OpenAIProvider } from './OpenAIProvider';
import { OllamaProvider } from './OllamaProvider';
import { getOpenAIKey } from '../keys';

/** Result of a cheap readiness check for a provider (no full analysis). */
export interface ProviderReadiness {
  ok: boolean;
  error?: string;
}

/** Per-capture options shared by both backends. */
export interface AnalyzeOptions {
  /** True after ~1am local time while still active — nudge toward rest. */
  lateNight?: boolean;
  /** Model-written 'realistic' remarks or enum-only 'classic' (the strict default). */
  remarkStyle?: RemarkStyle;
  /** Realistic only: recent raw remarks for continuity/no-repeats (see persona). */
  recentRemarks?: readonly string[];
  /** Realistic only: hours the current same-activity run has lasted. */
  sessionHours?: number;
  /** The activity of that run, for phrasing the nudge. */
  sessionActivity?: Activity;
  /** Caller-supplied cancellation (e.g. on pause/quit). Merged with the
   *  provider's own timeout signal. */
  signal?: AbortSignal;
}

/**
 * A vision backend. analyze() takes an already-captured screenshot (base64 +
 * mime) and returns only a privacy-safe observation. ready() is a cheap probe
 * used by Settings to show connection state before any capture happens.
 */
export interface VisionProvider {
  readonly kind: ProviderKind;
  readonly model: string;
  analyze(imageBase64: string, mime: string, opts?: AnalyzeOptions): Promise<ScreenObservation>;
  ready(): Promise<ProviderReadiness>;
}

/**
 * Build the provider the user has selected. The cloud key is read here (from
 * the OS keychain via main/keys) so callers never have to handle the secret.
 */
export function createProvider(settings: Settings): VisionProvider {
  // Privacy invariant, enforced at the point of upload: a screenshot may only
  // leave the device when the user has BOTH selected cloud AND given the
  // separate, explicit cloud consent. Without that consent we fall back to the
  // private on-device provider, no matter what `provider` says. This backstops
  // the renderer UI guard and the store-level coercion as defense-in-depth.
  if (settings.provider === 'cloud' && settings.cloudConsentGiven) {
    return new OpenAIProvider(getOpenAIKey(), settings.openaiModel);
  }
  return new OllamaProvider(settings.ollamaHost, settings.ollamaModel);
}

// Re-export the standalone helpers used by the Settings IPC handlers so the
// rest of main only ever imports from this one module.
export { validateOpenAIKey } from './OpenAIProvider';
export { probeOllama } from './OllamaProvider';
