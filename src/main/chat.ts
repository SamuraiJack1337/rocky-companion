// Conversation about the user's notes (Stage 1b) and the canned reflections
// (Stage 1c). Runs in main so keys never reach the renderer, mirroring the
// vision split: the selected provider knob picks local Ollama or cloud OpenAI,
// and the cloud path requires the separate notes-cloud consent — note text is
// exactly what gets sent, so it has its own gate. Without that consent a
// cloud selection silently degrades to the local backend.
//
// The model addresses the human as the literal {name}; the reply is rendered
// locally before it leaves this module (the call-name never enters a prompt).

import OpenAI from 'openai';
import type { ChatMessage, ChatResult, NoteView, ReflectionKind, Settings } from '../shared/types';
import {
  buildNotesContext,
  CHAT_CONTEXT_NOTES,
  CHAT_SYSTEM_PROMPT,
  REFLECTION_CONTEXT_NOTES,
  reflectionIsWeekly,
  reflectionPrompt,
} from '../shared/chatPrompt';
import { renderLine } from '../shared/lines';
import { getOpenAIKey } from './keys';
import { isLoopbackOllamaHost } from './providers/OllamaProvider';
import { notes } from './notes';
import { embedTexts } from './embeddings';

const CHAT_TIMEOUT_MS = 90_000;
/** Cap on history turns sent per request (newest kept). */
const MAX_HISTORY = 20;
/** Longest reply we accept from the model. */
const REPLY_MAX_LENGTH = 2_000;

const LOCAL_FAILED = 'Rocky cannot reach the local brain (Ollama). Is it running, {name}?';
const CLOUD_FAILED = 'Rocky could not reach the cloud brain, {name}.';
const NO_KEY = 'No OpenAI key. Add your key in Settings, {name}.';
const EMPTY_MESSAGE = 'Rocky heard nothing to answer, {name}.';

function sanitizeReply(raw: string): string {
  return (raw || '').trim().slice(0, REPLY_MAX_LENGTH).trim();
}

function fail(template: string, name: string): ChatResult {
  return { ok: false, error: renderLine(template, { name }) };
}

/** True when this request may use OpenAI for note text. */
function cloudChatAllowed(settings: Settings): boolean {
  return settings.provider === 'cloud' && settings.notesCloudConsentGiven;
}

/** Trim history to the most recent turns and drop empty messages. */
function normalizeHistory(messages: ChatMessage[]): ChatMessage[] {
  return messages
    .filter((m) => m && (m.role === 'user' || m.role === 'rocky') && typeof m.text === 'string')
    .map((m) => ({ role: m.role, text: m.text.trim().slice(0, 8_000) }))
    .filter((m) => m.text.length > 0)
    .slice(-MAX_HISTORY);
}

/**
 * One chat turn. Retrieval: the latest user message is embedded (when an
 * embedding backend is reachable) and the best-matching notes are placed in a
 * NOTEBOOK block ahead of the conversation; keyword search covers the rest.
 */
export async function chatWithRocky(
  rawMessages: ChatMessage[],
  settings: Settings,
): Promise<ChatResult> {
  const name = settings.callName;
  const history = normalizeHistory(rawMessages ?? []);
  const latest = [...history].reverse().find((m) => m.role === 'user');
  if (!latest) return fail(EMPTY_MESSAGE, name);

  const queryEmbedding = (await embedTexts([latest.text], settings))?.vectors[0] ?? null;
  const usedNotes = notes.search(latest.text, queryEmbedding, CHAT_CONTEXT_NOTES);
  return complete(history, usedNotes, settings);
}

/** A canned reflection (Stage 1c) over recent notes. */
export async function reflectOnNotes(
  kind: ReflectionKind,
  settings: Settings,
): Promise<ChatResult> {
  const name = settings.callName;
  const sinceISO = reflectionIsWeekly(kind)
    ? new Date(Date.now() - 7 * 86_400_000).toISOString()
    : undefined;
  const usedNotes = notes.recent(REFLECTION_CONTEXT_NOTES, sinceISO);
  if (usedNotes.length === 0) {
    return {
      ok: true,
      reply: renderLine(
        'The notebook is empty for that, {name}. Speak a thought first — press the talk key and Rocky will keep it.',
        { name },
      ),
      usedNotes: [],
    };
  }
  const history: ChatMessage[] = [{ role: 'user', text: reflectionPrompt(kind) }];
  return complete(history, usedNotes, settings);
}

/** Shared completion path: build the prompt, call the selected backend. */
async function complete(
  history: ChatMessage[],
  usedNotes: NoteView[],
  settings: Settings,
): Promise<ChatResult> {
  const name = settings.callName;
  // Oldest-first inside the prompt block reads naturally for the model.
  const contextNotes = [...usedNotes].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const system = `${CHAT_SYSTEM_PROMPT}\n\n${buildNotesContext(contextNotes)}`;

  const raw = cloudChatAllowed(settings)
    ? await completeOpenAI(system, history, settings)
    : await completeOllama(system, history, settings);
  if (raw === null) {
    const template = cloudChatAllowed(settings)
      ? getOpenAIKey()
        ? CLOUD_FAILED
        : NO_KEY
      : LOCAL_FAILED;
    return fail(template, name);
  }
  const reply = sanitizeReply(renderLine(raw, { name }));
  if (!reply) return fail(cloudChatAllowed(settings) ? CLOUD_FAILED : LOCAL_FAILED, name);
  return { ok: true, reply, usedNotes };
}

async function completeOpenAI(
  system: string,
  history: ChatMessage[],
  settings: Settings,
): Promise<string | null> {
  const key = getOpenAIKey();
  if (!key) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS);
  try {
    const client = new OpenAI({ apiKey: key });
    const response = await client.responses.create(
      {
        model: settings.openaiModel,
        instructions: system,
        input: history.map((m) => ({
          role: m.role === 'rocky' ? ('assistant' as const) : ('user' as const),
          content: m.text,
        })),
      },
      { signal: controller.signal },
    );
    return response.output_text ?? null;
  } catch {
    return null; // Generic, silent — never leak the key or network detail.
  } finally {
    clearTimeout(timer);
  }
}

interface OllamaChatResponse {
  message?: { content?: string };
}

async function completeOllama(
  system: string,
  history: ChatMessage[],
  settings: Settings,
): Promise<string | null> {
  if (!isLoopbackOllamaHost(settings.ollamaHost)) return null;
  const model = settings.ollamaChatModel.trim() || settings.ollamaModel;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS);
  try {
    const res = await fetch(`${settings.ollamaHost.replace(/\/+$/, '')}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        options: { temperature: 0.7 },
        messages: [
          { role: 'system', content: system },
          ...history.map((m) => ({
            role: m.role === 'rocky' ? 'assistant' : 'user',
            content: m.text,
          })),
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as OllamaChatResponse;
    return data.message?.content ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
