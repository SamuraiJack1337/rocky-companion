// The private, on-device vision backend. Talks to a locally running Ollama
// server over plain HTTP using the global fetch. This is Rocky's default brain:
// the screenshot never leaves the machine.
//
// Privacy: imageBase64 is sent only to the user's own localhost Ollama and is
// never written to disk or logged. Errors are kept generic and in-character.

import type { OllamaStatus, ProviderKind, ScreenObservation } from '../../shared/types';
import { SYSTEM_PROMPT, buildUserPrompt, parseObservation } from '../../shared/persona';
import type { AnalyzeOptions, ProviderReadiness, VisionProvider } from './VisionProvider';

/** How long to wait on a single analyze() before giving up (ms). */
const ANALYZE_TIMEOUT_MS = 60_000;
/** Shorter timeout for the cheap readiness probe (ms). */
const PROBE_TIMEOUT_MS = 4_000;

/** Friendly, in-character error shown when Ollama is unreachable or errors.
 *  A {name} template — the scheduler renders the call-name in. */
const UNREACHABLE_MESSAGE =
  'Rocky cannot reach the local brain (Ollama). Is it running, {name}?';
/** Same failure for the settings/consent probe UI, where no name is rendered. */
const PROBE_UNREACHABLE_MESSAGE =
  'Rocky cannot reach the local brain (Ollama). Is it running?';

/** Trim a trailing slash so `${host}/api/...` never doubles up. */
function normalizeHost(host: string): string {
  return host.replace(/\/+$/, '');
}

/** The "local" provider must remain on this machine. Remote hosts require a separate provider/consent model. */
export function isLoopbackOllamaHost(host: string): boolean {
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

/**
 * Build an AbortSignal that fires when EITHER our own timeout elapses OR the
 * caller's signal aborts. Returns the merged signal plus a cleanup function to
 * clear the timer and detach listeners.
 */
function withTimeout(
  timeoutMs: number,
  external?: AbortSignal,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let onExternalAbort: (() => void) | undefined;
  if (external) {
    if (external.aborted) {
      controller.abort();
    } else {
      onExternalAbort = () => controller.abort();
      external.addEventListener('abort', onExternalAbort, { once: true });
    }
  }

  const cleanup = () => {
    clearTimeout(timer);
    if (external && onExternalAbort) external.removeEventListener('abort', onExternalAbort);
  };
  return { signal: controller.signal, cleanup };
}

/** Case-insensitive model match that tolerates a missing ':latest' suffix. */
function modelMatches(available: string, wanted: string): boolean {
  const norm = (m: string) => m.trim().toLowerCase().replace(/:latest$/, '');
  return norm(available) === norm(wanted);
}

/** Shape of the /api/tags response we care about. */
interface TagsResponse {
  models?: Array<{ name?: string }>;
}

/** Shape of the /api/chat response we care about. */
interface ChatResponse {
  message?: { content?: string };
}

export class OllamaProvider implements VisionProvider {
  readonly kind: ProviderKind = 'local';
  readonly model: string;
  private readonly host: string;

  constructor(host: string, model: string) {
    this.host = isLoopbackOllamaHost(host) ? normalizeHost(host) : 'http://localhost:11434';
    this.model = model;
  }

  async analyze(imageBase64: string, _mime: string, opts?: AnalyzeOptions): Promise<ScreenObservation> {
    // Ollama takes raw base64 images in the `images` array; the mime type is
    // inferred by the server, so _mime is unused here.
    const { signal, cleanup } = withTimeout(ANALYZE_TIMEOUT_MS, opts?.signal);
    try {
      const res = await fetch(`${this.host}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          stream: false,
          format: 'json',
          options: { temperature: 0.6 },
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            {
              role: 'user',
              content: buildUserPrompt({ lateNight: opts?.lateNight }),
              images: [imageBase64],
            },
          ],
        }),
        signal,
      });

      if (!res.ok) {
        // Don't surface server bodies (could echo content). Generic message.
        throw new Error(UNREACHABLE_MESSAGE);
      }

      const data = (await res.json()) as ChatResponse;
      const content = data.message?.content ?? '';
      return parseObservation(content);
    } catch (err) {
      // Network failure, abort/timeout, or non-OK above all collapse to one
      // friendly, in-character error. Never include the underlying detail
      // (it could leak host/path/content).
      throw new Error(UNREACHABLE_MESSAGE);
    } finally {
      cleanup();
    }
  }

  async ready(): Promise<ProviderReadiness> {
    const status = await probeOllama(this.host, this.model);
    if (!status.reachable) {
      return { ok: false, error: status.error ?? PROBE_UNREACHABLE_MESSAGE };
    }
    if (!status.modelAvailable) {
      return {
        ok: false,
        error: `Rocky does not see the model "${this.model}" in Ollama.`,
      };
    }
    return { ok: true };
  }
}

/**
 * Probe a local Ollama server: is it reachable, and is the requested model
 * installed? Used by the Settings UI (via IPC) to show live connection state.
 * Model matching is case-insensitive and tolerant of a ':latest' suffix.
 */
export async function probeOllama(host: string, model: string): Promise<OllamaStatus> {
  if (!isLoopbackOllamaHost(host)) {
    return {
      reachable: false,
      modelAvailable: false,
      models: [],
      error: 'Local Ollama must use localhost, 127.0.0.1, or ::1.',
    };
  }
  const base = normalizeHost(host);
  const { signal, cleanup } = withTimeout(PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/api/tags`, { method: 'GET', signal });
    if (!res.ok) {
      return { reachable: false, modelAvailable: false, models: [], error: PROBE_UNREACHABLE_MESSAGE };
    }
    const data = (await res.json()) as TagsResponse;
    const models = (data.models ?? [])
      .map((m) => m.name)
      .filter((n): n is string => typeof n === 'string');
    const modelAvailable = models.some((m) => modelMatches(m, model));
    return { reachable: true, modelAvailable, models };
  } catch {
    return { reachable: false, modelAvailable: false, models: [], error: PROBE_UNREACHABLE_MESSAGE };
  } finally {
    cleanup();
  }
}
