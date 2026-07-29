// The pluggable speech-to-text layer — Rocky's "ears", mirroring the vision
// layer's local/cloud split. Local is whisper.cpp's CLI (user-installed, like
// Ollama); cloud is OpenAI transcription under the user's own key.
//
// Privacy invariant, enforced here exactly like createProvider() does for
// vision: captured audio may only leave the device when the user has BOTH
// selected the cloud speech backend AND given the separate notes-cloud
// consent. Anything else resolves to the local backend.

import type { ProviderKind, Settings, TranscriptionResult } from '../../shared/types';
import { OpenAISpeechProvider } from './OpenAISpeechProvider';
import { WhisperCliProvider } from './WhisperCliProvider';
import { getOpenAIKey } from '../keys';
import type { ProviderReadiness } from './VisionProvider';

/** A speech-to-text backend. transcribe() takes an in-memory WAV (base64). */
export interface SpeechProvider {
  readonly kind: ProviderKind;
  transcribe(wavBase64: string): Promise<TranscriptionResult>;
  /** Cheap readiness probe for the Settings UI; no audio involved. */
  ready(): Promise<ProviderReadiness>;
}

/** Build the speech backend the settings allow. */
export function createSpeechProvider(settings: Settings): SpeechProvider {
  if (settings.speechProvider === 'cloud' && settings.notesCloudConsentGiven) {
    return new OpenAISpeechProvider(getOpenAIKey(), settings.sttModel);
  }
  return new WhisperCliProvider(settings.whisperCliPath, settings.whisperModelPath);
}
