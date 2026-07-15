// The private, on-device vision backend. Talks to a locally running Ollama
// server over plain HTTP using the global fetch. This is Rocky's default brain:
// the screenshot never leaves the machine.
//
// Privacy: imageBase64 is sent only to the user's own localhost Ollama and is
// never written to disk or logged. Errors are kept generic and in-character.

import type { OllamaStatus, ProviderKind, ScreenObservation } from '../../shared/types';
import { buildSystemPrompt, buildUserPrompt, parseObservation, promptOptions } from '../../shared/persona';
import type { AnalyzeOptions, ProviderReadiness, VisionProvider } from './VisionProvider';

/** How long to wait on a single analyze() before giving up (ms). A first
 *  capture may cold-load a multi-GB vision model into memory, so this is
 *  deliberately generous — a short timeout used to abort mid-load and surface
 *  as a bogus "cannot reach" message. */
const ANALYZE_TIMEOUT_MS = 120_000;
/** Shorter timeout for the cheap reachability probe (GET /api/tags) (ms). */
const PROBE_TIMEOUT_MS = 4_000;
/** Longer timeout for the optional warmup generation, which may cold-load the
 *  model just like a real capture would. */
const WARMUP_TIMEOUT_MS = 120_000;
/** Keep the model resident between captures so it does not cold-load every
 *  time (Ollama unloads after ~5 min idle by default). */
const KEEP_ALIVE = '30m';

/** Opt-in diagnostics: set ROCKY_DEBUG=1 to log the underlying cause of a
 *  provider failure (class + message only — never image bytes or model
 *  content) so field reports of "not connected" are actually diagnosable. */
function debugLog(where: string, err: unknown): void {
  if (!process.env.ROCKY_DEBUG) return;
  const detail =
    err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  // eslint-disable-next-line no-console
  console.error(`[ollama:${where}] ${detail}`);
}

/** Friendly, in-character errors shown when analyze() fails. Each is a {name}
 *  template — the scheduler renders the call-name in — and each is kept ≤160
 *  chars so the scheduler renders it as a spoken line rather than a fallback.
 *  Distinct messages matter: the tester's "connected in Settings but not in the
 *  app" report came from every failure collapsing into UNREACHABLE. */
const UNREACHABLE_MESSAGE =
  'Rocky cannot reach the local brain (Ollama). Is it running, {name}?';
/** Our own timeout fired — most often a heavy vision model still cold-loading. */
const TIMEOUT_MESSAGE =
  'Rocky\'s local brain is taking too long — the vision model may still be loading. A lighter one helps, {name}.';
/** Ollama answered with a non-OK status (e.g. model missing / cannot run). */
const MODEL_ERROR_MESSAGE =
  'Rocky can\'t run that model in Ollama — is it installed and vision-capable, {name}?';
/** Reached the model but the reply was not the JSON we could parse. */
const PARSE_ERROR_MESSAGE =
  'Rocky\'s brain replied but I couldn\'t read it — try a different vision model, {name}.';
/** Same reachability failure for the settings/consent probe UI (no name). */
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
 * caller's signal aborts. Returns the merged signal, a cleanup function, and a
 * `timedOut()` predicate so callers can tell an internal timeout apart from an
 * external cancel (pause/quit) — the two must surface very differently.
 */
function withTimeout(
  timeoutMs: number,
  external?: AbortSignal,
): { signal: AbortSignal; cleanup: () => void; timedOut: () => boolean } {
  const controller = new AbortController();
  let didTimeOut = false;
  const timer = setTimeout(() => {
    didTimeOut = true;
    controller.abort();
  }, timeoutMs);

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
  return { signal: controller.signal, cleanup, timedOut: () => didTimeOut };
}

/** Thrown when the model responds but the payload isn't parseable JSON. Lets
 *  analyze()'s catch tell a parse failure apart from a transport failure. */
class ObservationParseError extends Error {}

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
    const style = opts?.remarkStyle ?? 'classic';
    const { signal, cleanup, timedOut } = withTimeout(ANALYZE_TIMEOUT_MS, opts?.signal);
    try {
      const res = await fetch(`${this.host}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          stream: false,
          format: 'json',
          keep_alive: KEEP_ALIVE,
          options: { temperature: 0.6 },
          messages: [
            { role: 'system', content: buildSystemPrompt(style) },
            {
              role: 'user',
              content: buildUserPrompt(promptOptions(style, opts)),
              images: [imageBase64],
            },
          ],
        }),
        signal,
      });

      if (!res.ok) {
        // Don't surface server bodies (could echo content). A non-OK status is
        // typically a missing / non-vision model, not "Ollama is down".
        throw new Error(MODEL_ERROR_MESSAGE);
      }

      let data: ChatResponse;
      try {
        data = (await res.json()) as ChatResponse;
      } catch {
        // Reached the model but the body wasn't JSON we can read (e.g. a
        // truncated stream or an HTML error page). parseObservation itself
        // never throws, so this res.json() step is the only parse failure.
        throw new ObservationParseError('malformed response');
      }
      const content = data.message?.content ?? '';
      return parseObservation(content, style);
    } catch (err) {
      // Collapse each failure mode to a DISTINCT in-character message. The old
      // code funneled everything into UNREACHABLE, which is why a merely slow
      // model read as "not connected". We never surface the raw detail (could
      // leak host/path/content) — only ROCKY_DEBUG logs it.
      debugLog('analyze', err);

      // External cancel (pause/quit): not an error the user should hear about.
      if (opts?.signal?.aborted && !timedOut()) throw err;
      // Our own timeout fired — the model is likely still cold-loading.
      if (timedOut()) throw new Error(TIMEOUT_MESSAGE);
      // Parsed a reply but it wasn't the JSON we expected.
      if (err instanceof ObservationParseError) throw new Error(PARSE_ERROR_MESSAGE);
      // Non-OK HTTP status raised above.
      if (err instanceof Error && err.message === MODEL_ERROR_MESSAGE) throw err;
      // Anything left is a genuine transport failure: Ollama isn't answering.
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
 *
 * With `warmup`, after the reachability check it also runs a tiny generation to
 * confirm the model actually *responds* — the same cost the app pays on its
 * first capture. This closes the gap that produced the tester's report: a bare
 * /api/tags ping "verifies" while a slow-loading model still fails in the app.
 */
export async function probeOllama(
  host: string,
  model: string,
  opts?: { warmup?: boolean },
): Promise<OllamaStatus> {
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
  let models: string[];
  let modelAvailable: boolean;
  try {
    const res = await fetch(`${base}/api/tags`, { method: 'GET', signal });
    if (!res.ok) {
      return { reachable: false, modelAvailable: false, models: [], error: PROBE_UNREACHABLE_MESSAGE };
    }
    const data = (await res.json()) as TagsResponse;
    models = (data.models ?? [])
      .map((m) => m.name)
      .filter((n): n is string => typeof n === 'string');
    modelAvailable = models.some((m) => modelMatches(m, model));
  } catch (err) {
    debugLog('probe.tags', err);
    return { reachable: false, modelAvailable: false, models: [], error: PROBE_UNREACHABLE_MESSAGE };
  } finally {
    cleanup();
  }

  // Reachable but the model isn't installed, or no warmup requested: report
  // what we know without paying for a generation.
  if (!opts?.warmup || !modelAvailable) {
    return { reachable: true, modelAvailable, models };
  }

  // Warmup: a trivial text-only generation loads the model into memory exactly
  // like a real capture would, so a slow/failed load shows up here instead of
  // silently in the app later. Text-only still loads full vision weights.
  const warm = withTimeout(WARMUP_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        keep_alive: KEEP_ALIVE,
        options: { num_predict: 1 },
        messages: [{ role: 'user', content: 'ok' }],
      }),
      signal: warm.signal,
    });
    const warmupMs = Date.now() - startedAt;
    if (!res.ok) {
      return {
        reachable: true,
        modelAvailable,
        models,
        modelResponsive: false,
        warmupMs,
        error: 'The model is installed but Ollama could not run it (is it vision-capable?).',
      };
    }
    return { reachable: true, modelAvailable, models, modelResponsive: true, warmupMs };
  } catch (err) {
    debugLog('probe.warmup', err);
    return {
      reachable: true,
      modelAvailable,
      models,
      modelResponsive: false,
      warmupMs: Date.now() - startedAt,
      error: 'The model is installed but did not respond in time — it may be too heavy for this machine.',
    };
  } finally {
    warm.cleanup();
  }
}
