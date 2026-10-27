import { app } from 'electron';
import type { PrivacySummary, ProviderComponentHealth, ProviderHealth, Settings } from '../shared/types';
import { chatHistory } from './chatHistory';
import { decisions } from './decisions';
import { hasOpenAIKey } from './keys';
import { notes } from './notes';
import { offlineTtsAvailable } from './offlineTts';
import { tasks } from './tasks';
import { researchArtifacts } from './researchArtifacts';
import { workspaces } from './workspaces';
import { createSpeechProvider } from './providers/SpeechProvider';
import { createProvider } from './providers/VisionProvider';

function routeSummary(settings: Settings): PrivacySummary['routes'] {
  return {
    vision: settings.provider === 'cloud' && settings.cloudConsentGiven ? 'OpenAI cloud' : 'Local Ollama',
    speechToText:
      settings.speechProvider === 'cloud' && settings.notesCloudConsentGiven
        ? 'OpenAI cloud'
        : 'Local whisper.cpp',
    notesAndChat:
      settings.provider === 'cloud' && settings.notesCloudConsentGiven ? 'OpenAI cloud' : 'Local Ollama',
    voice:
      settings.voiceMode === 'openai' && settings.ttsConsentGiven
        ? 'OpenAI cloud TTS'
        : settings.voiceMode === 'offline'
          ? 'Local Kokoro/system voice'
          : 'Local Eridian chords',
    web: settings.webSearchEnabled && settings.webSearchConsentGiven ? 'Enabled — external sites' : 'Disabled',
  };
}

export function getPrivacySummary(settings: Settings): PrivacySummary {
  return {
    dataDirectory: app.getPath('userData'),
    routes: routeSummary(settings),
    stored: {
      notes: notes.count(),
      chatMessages: chatHistory.list().length,
      decisions: decisions.list().length,
      tasks: tasks.list().length,
      researchArtifacts: researchArtifacts.list().length,
      workspaces: workspaces.list().length,
      relationshipMemory: true,
    },
  };
}

export function eraseUserContent(): void {
  notes.clear();
  chatHistory.clear();
  decisions.clear();
  tasks.clear();
  researchArtifacts.clear();
  workspaces.clearCustom();
}

function health(
  state: ProviderComponentHealth['state'],
  label: string,
  detail: string,
): ProviderComponentHealth {
  return { state, label, detail };
}

export async function getProviderHealth(settings: Settings): Promise<ProviderHealth> {
  const [visionReady, speechReady] = await Promise.all([
    createProvider(settings).ready().catch(() => ({ ok: false, error: 'Readiness check failed.' })),
    createSpeechProvider(settings).ready().catch(() => ({ ok: false, error: 'Readiness check failed.' })),
  ]);
  const cloudBrain = settings.provider === 'cloud' && settings.notesCloudConsentGiven;
  const keyReady = hasOpenAIKey();
  const chatReady = cloudBrain ? keyReady : true;
  const embedConfigured = cloudBrain
    ? keyReady && !!settings.openaiEmbedModel.trim()
    : !!settings.ollamaEmbedModel.trim();

  return {
    vision: visionReady.ok
      ? health('ready', routeSummary(settings).vision, 'Vision provider is configured.')
      : health('unavailable', routeSummary(settings).vision, visionReady.error ?? 'Provider unavailable.'),
    speech: speechReady.ok
      ? health('ready', routeSummary(settings).speechToText, 'Speech-to-text is configured.')
      : health('unavailable', routeSummary(settings).speechToText, speechReady.error ?? 'Speech setup incomplete.'),
    chat: chatReady
      ? health('ready', routeSummary(settings).notesAndChat, 'Conversation backend is configured.')
      : health('unavailable', routeSummary(settings).notesAndChat, 'A valid cloud key is required.'),
    embeddings: embedConfigured
      ? health('ready', cloudBrain ? settings.openaiEmbedModel : settings.ollamaEmbedModel, 'Semantic retrieval configured; keyword fallback remains available.')
      : health('degraded', 'Keyword fallback', 'No embedding model is configured; retrieval still works by keywords.'),
    voice:
      settings.voiceMode === 'openai'
        ? keyReady && settings.ttsConsentGiven
          ? health('ready', 'OpenAI TTS', 'Cloud spoken voice is enabled.')
          : health('unavailable', 'OpenAI TTS', 'Cloud voice needs a key and TTS consent.')
        : settings.voiceMode === 'offline'
          ? offlineTtsAvailable()
            ? health('ready', 'Local Kokoro', 'Bundled neural voice is available.')
            : health('degraded', 'System voice fallback', 'Bundled voice is unavailable; Rocky will use the OS voice or chords.')
          : health('ready', 'Eridian chords', 'Procedural voice is fully local.'),
    web:
      settings.webSearchEnabled && settings.webSearchConsentGiven
        ? health('ready', 'Web access enabled', 'Searches and public page requests may leave this device.')
        : health('disabled', 'Web access disabled', 'Chat stays notebook-only.'),
  };
}
