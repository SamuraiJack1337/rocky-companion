// Cloud speech-to-text (bring-your-own-key). Sends the captured note audio to
// OpenAI's transcription API. Selecting this backend means the AUDIO leaves
// the device, so it is gated behind the separate notes-cloud consent by the
// SpeechProvider factory; this module just performs the call.
//
// Privacy: the key and the audio bytes are never logged or echoed; errors are
// collapsed to generic in-character lines.

import OpenAI, { toFile } from 'openai';
import type { ProviderKind, TranscriptionResult } from '../../shared/types';
import type { ProviderReadiness } from './VisionProvider';
import type { SpeechProvider } from './SpeechProvider';

const NO_KEY_ERROR = 'No OpenAI key. Add your key in Settings, {name}.';
const CALL_FAILED_ERROR = 'Rocky could not reach the cloud ears, {name}.';

export class OpenAISpeechProvider implements SpeechProvider {
  readonly kind: ProviderKind = 'cloud';
  private readonly apiKey: string | null;
  private readonly model: string;

  constructor(apiKey: string | null, model: string) {
    this.apiKey = apiKey;
    this.model = model.trim() || 'gpt-4o-mini-transcribe';
  }

  async transcribe(wavBase64: string): Promise<TranscriptionResult> {
    if (!this.apiKey) return { ok: false, error: NO_KEY_ERROR };
    try {
      const client = new OpenAI({ apiKey: this.apiKey });
      const audio = Buffer.from(wavBase64, 'base64');
      const response = await client.audio.transcriptions.create({
        file: await toFile(audio, 'note.wav', { type: 'audio/wav' }),
        model: this.model,
      });
      const text = (response.text ?? '').trim();
      return { ok: true, text };
    } catch {
      // Never surface SDK/network detail (could embed the key or a URL).
      return { ok: false, error: CALL_FAILED_ERROR };
    }
  }

  async ready(): Promise<ProviderReadiness> {
    if (!this.apiKey) return { ok: false, error: 'No OpenAI key set.' };
    return { ok: true };
  }
}
