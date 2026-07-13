// The optional cloud vision backend (bring-your-own-key). Uses the OpenAI
// Responses API. Selecting this means the screenshot leaves the device, so the
// app gates it behind a separate explicit cloud-consent step elsewhere; this
// module just performs the call.
//
// Privacy: the API key and the image bytes are NEVER logged or echoed. All
// errors are kept generic so nothing sensitive leaks through messages.

import OpenAI from 'openai';
import type { KeyResult, ProviderKind, ScreenObservation } from '../../shared/types';
import { SYSTEM_PROMPT, buildUserPrompt, parseObservation } from '../../shared/persona';
import type { AnalyzeOptions, ProviderReadiness, VisionProvider } from './VisionProvider';

// Error lines are {name} templates; the scheduler renders the call-name in.
/** Shown when the cloud backend is selected but no key has been stored. */
const NO_KEY_MESSAGE = 'No OpenAI key. Add your key in Settings, {name}.';
const NO_KEY_READY_ERROR = 'No OpenAI key set.';
/** Generic failure message — never include provider/network detail or the key. */
const CALL_FAILED_MESSAGE = 'Rocky could not reach the cloud brain, {name}.';

export class OpenAIProvider implements VisionProvider {
  readonly kind: ProviderKind = 'cloud';
  readonly model: string;
  private readonly apiKey: string | null;

  constructor(apiKey: string | null, model: string) {
    this.apiKey = apiKey;
    this.model = model;
  }

  async analyze(imageBase64: string, mime: string, opts?: AnalyzeOptions): Promise<ScreenObservation> {
    if (!this.apiKey) {
      throw new Error(NO_KEY_MESSAGE);
    }

    // Construct the client per-call; cheap, and avoids holding the key longer
    // than necessary.
    const client = new OpenAI({ apiKey: this.apiKey });

    try {
      const response = await client.responses.create(
        {
          model: this.model,
          instructions: SYSTEM_PROMPT,
          input: [
            {
              role: 'user',
              content: [
                { type: 'input_text', text: buildUserPrompt({ lateNight: opts?.lateNight }) },
                {
                  type: 'input_image',
                  // Inline data URL keeps the image in-memory only; no upload to disk.
                  // 'auto' lets the API keep enough resolution to tell coarse
                  // detail categories apart; 'low' flattened everything to ~512px.
                  image_url: `data:${mime};base64,${imageBase64}`,
                  detail: 'auto',
                },
              ],
            },
          ],
        },
        // Pass the caller's cancellation through to the HTTP layer if present.
        opts?.signal ? { signal: opts.signal } : undefined,
      );

      const text = response.output_text ?? '';
      return parseObservation(text);
    } catch (err) {
      // Collapse any SDK/network/HTTP error into one generic in-character line.
      // We deliberately do NOT include `err` (could contain the key or URL).
      throw new Error(CALL_FAILED_MESSAGE);
    }
  }

  async ready(): Promise<ProviderReadiness> {
    // Cheap, no network call: a key being present is all we check here. Actual
    // key validity is verified at storage time via validateOpenAIKey().
    if (!this.apiKey) {
      return { ok: false, error: NO_KEY_READY_ERROR };
    }
    return { ok: true };
  }
}

/**
 * Validate a candidate key by making one tiny, cheap call (models.list). Used
 * by the Settings flow BEFORE the key is stored. Returns a generic result —
 * the key itself is never logged, echoed, or included in any error.
 */
export async function validateOpenAIKey(key: string, _model: string): Promise<KeyResult> {
  if (!key) {
    return { ok: false, error: 'Key looks invalid or the network failed.' };
  }
  try {
    const client = new OpenAI({ apiKey: key });
    await client.models.list();
    return { ok: true };
  } catch {
    // Keep it generic: distinguishing auth vs network would leak signal and
    // tempt logging the underlying error (which may embed the key).
    return { ok: false, error: 'Key looks invalid or the network failed.' };
  }
}
