// Note embeddings for retrieval. Follows the app's one provider knob: the
// selected vision/chat provider ('local' Ollama vs 'cloud' OpenAI) also
// decides where embeddings come from, and the cloud path additionally
// requires the separate notes-cloud consent — without it we quietly fall back
// to Ollama, and if that is unreachable retrieval degrades to keyword search
// (embedTexts returns null; callers must treat that as "no embeddings").
//
// Privacy: only note/query TEXT is embedded (that is the feature, and for the
// cloud path it is consent-gated). Vectors are stored next to the note and
// never leave the device again.

import OpenAI from 'openai';
import type { Settings } from '../shared/types';
import { getOpenAIKey } from './keys';
import { isLoopbackOllamaHost } from './providers/OllamaProvider';

const EMBED_TIMEOUT_MS = 20_000;

export interface EmbeddingBatch {
  vectors: number[][];
  /** Which model produced them (stored per note so a model switch re-embeds). */
  model: string;
}

/**
 * Embed a batch of texts, or null when no embedding backend is usable right
 * now. Never throws — retrieval must always gracefully fall back to keywords.
 */
export async function embedTexts(
  texts: readonly string[],
  settings: Settings,
): Promise<EmbeddingBatch | null> {
  if (texts.length === 0) return null;
  if (settings.provider === 'cloud' && settings.notesCloudConsentGiven) {
    const cloud = await embedWithOpenAI(texts, settings.openaiEmbedModel);
    if (cloud) return cloud;
    // Cloud unavailable (no key / network) — try the local path before giving up.
  }
  return embedWithOllama(texts, settings.ollamaHost, settings.ollamaEmbedModel);
}

async function embedWithOpenAI(
  texts: readonly string[],
  model: string,
): Promise<EmbeddingBatch | null> {
  const key = getOpenAIKey();
  if (!key) return null;
  const embedModel = model.trim() || 'text-embedding-3-small';
  try {
    const client = new OpenAI({ apiKey: key });
    const response = await client.embeddings.create({
      model: embedModel,
      input: [...texts],
    });
    const vectors = response.data
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding);
    if (vectors.length !== texts.length) return null;
    return { vectors, model: embedModel };
  } catch {
    return null; // Generic, silent — never leak key/network detail.
  }
}

interface OllamaEmbedResponse {
  embeddings?: number[][];
}

async function embedWithOllama(
  texts: readonly string[],
  host: string,
  model: string,
): Promise<EmbeddingBatch | null> {
  if (!isLoopbackOllamaHost(host)) return null;
  const embedModel = model.trim();
  if (!embedModel) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS);
  try {
    const res = await fetch(`${host.replace(/\/+$/, '')}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: embedModel, input: [...texts] }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as OllamaEmbedResponse;
    const vectors = data.embeddings;
    if (!Array.isArray(vectors) || vectors.length !== texts.length) return null;
    return { vectors, model: embedModel };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
