// Conversation about the user's notes (Stage 1b), the canned reflections
// (Stage 1c), and — new in Stage 2 — web-aware answers and sounding-board
// discussion. Runs in main so keys never reach the renderer, mirroring the
// vision split: the selected provider knob picks local Ollama or cloud OpenAI,
// and the cloud path requires the separate notes-cloud consent — note text is
// exactly what gets sent, so it has its own gate.
//
// Web access is a THIRD, orthogonal gate (webSearchEnabled + consent): search
// text and page addresses leave the machine only with explicit web consent, in
// either provider mode. Cloud uses OpenAI's built-in web_search; local runs a
// bounded tool-calling loop over our own searchWeb/fetchPage (see webTools.ts).
//
// The model addresses the human as the literal {name}; the reply is rendered
// locally before it leaves this module (the call-name never enters a prompt).

import OpenAI from 'openai';
import { net } from 'electron';
import type {
  ChatMessage,
  ChatResult,
  NoteView,
  ReflectionKind,
  Settings,
  WebSource,
} from '../shared/types';
import {
  buildChatSystemPrompt,
  buildDecisionsContext,
  buildNotesContext,
  CHAT_CONTEXT_NOTES,
  DECISION_DISTILL_PROMPT,
  parseDecisionDraft,
  parseTopicTags,
  REFLECTION_CONTEXT_NOTES,
  reflectionIsWeekly,
  reflectionPrompt,
  TOPIC_TAG_PROMPT,
} from '../shared/chatPrompt';
import type { WebAccess } from '../shared/chatPrompt';
import type { DecisionDraftResult } from '../shared/types';
import { renderLine } from '../shared/lines';
import { getOpenAIKey } from './keys';
import { isLoopbackOllamaHost } from './providers/OllamaProvider';
import { notes } from './notes';
import { decisions } from './decisions';
import { embedTexts } from './embeddings';
import {
  executeToolCall,
  OLLAMA_RESEARCH_TOOL,
  OLLAMA_TOOLS,
  OPENAI_RESEARCH_TOOL,
  parseToolArgs,
  startResearchTopicFromOpenAIOutput,
  startResearchTopicFromToolCalls,
} from './webTools';

const CHAT_TIMEOUT_MS = 90_000;
/** Whole-turn ceiling for a local tool loop (several model calls + fetches). */
const TOOL_LOOP_DEADLINE_MS = 180_000;
/** Cap on history turns sent per request (newest kept). */
const MAX_HISTORY = 40;
/** Longest ordinary reply we accept from the model. */
const REPLY_MAX_LENGTH = 2_000;
/** Longest reply we accept for a research report (much larger than a chat turn). */
export const RESEARCH_REPLY_MAX_LENGTH = 8_000;
/** Hard cap on tool-call rounds in the local loop (last round forces an answer). */
const MAX_TOOL_ITERATIONS = 5;
/** How many open decisions may be shown to the model as context. */
const DECISION_CONTEXT_MAX = 4;
const activeChatControllers = new Set<AbortController>();

/** Abort active local/cloud model turns during shutdown. */
export function cancelChatRequests(): void {
  for (const controller of activeChatControllers) controller.abort();
  activeChatControllers.clear();
}

const LOCAL_FAILED = 'Rocky cannot reach the local brain (Ollama). Is it running, {name}?';
const CLOUD_FAILED = 'Rocky could not reach the cloud brain, {name}.';
const NO_KEY = 'No OpenAI key. Add your key in Settings, {name}.';
const EMPTY_MESSAGE = 'Rocky heard nothing to answer, {name}.';

/** A model reply plus any web pages it drew on. */
export interface ModelReply {
  text: string;
  sources: WebSource[];
  /** Set when the model called start_research instead of answering: the topic.
   *  A pure routing signal — `text` is empty and never shown. */
  startResearch?: string;
}

/** Optional per-call controls threaded from the caller. */
export interface CompleteOptions {
  /** Web capability for this turn; defaults to 'disabled'. */
  web?: WebAccess;
  /** Progress line sink (tool loop / research); defaults to no-op. */
  onProgress?: (line: string) => void;
  /** Longest reply accepted (research reports need more room). */
  maxLength?: number;
  /** Offer the start_research routing tool. Chat turns only — never set inside
   *  a research run, or a report could recursively launch another task. */
  researchTool?: boolean;
  /** Incremental text from providers that support streaming. */
  onToken?: (delta: string) => void;
}

const noop = (): void => {};

function sanitizeReply(raw: string, maxLength = REPLY_MAX_LENGTH): string {
  return (raw || '').trim().slice(0, maxLength).trim();
}

function fail(template: string, name: string): ChatResult {
  return { ok: false, error: renderLine(template, { name }) };
}

/** True when this request may use OpenAI for note text. */
export function cloudChatAllowed(settings: Settings): boolean {
  return settings.provider === 'cloud' && settings.notesCloudConsentGiven;
}

/** True when this request may reach the open web at all. */
export function webAllowed(settings: Settings): boolean {
  return settings.webSearchEnabled && settings.webSearchConsentGiven;
}

/** Resolve the web capability for a turn: disabled, offline, or available. */
export function resolveWebAccess(settings: Settings): WebAccess {
  if (!webAllowed(settings)) return 'disabled';
  // net.isOnline() is a free, request-less check. Guard it so a test/headless
  // context without a real net module can't throw.
  try {
    if (net && typeof net.isOnline === 'function' && !net.isOnline()) return 'offline';
  } catch {
    /* assume online if we can't tell */
  }
  return 'available';
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
 * Web access, when enabled and online, lets Rocky search and read pages.
 */
export async function chatWithRocky(
  rawMessages: ChatMessage[],
  settings: Settings,
  onProgress: (line: string) => void = noop,
  workspaceId?: string,
  onToken?: (delta: string) => void,
): Promise<ChatResult> {
  const name = settings.callName;
  const history = normalizeHistory(rawMessages ?? []);
  const latest = [...history].reverse().find((m) => m.role === 'user');
  if (!latest) return fail(EMPTY_MESSAGE, name);

  const queryEmbedding = (await embedTexts([latest.text], settings))?.vectors[0] ?? null;
  const usedNotes = notes.search(latest.text, queryEmbedding, CHAT_CONTEXT_NOTES, workspaceId);
  const usedDecisions = relevantDecisions(latest.text);
  return complete(history, usedNotes, usedDecisions, settings, {
    web: resolveWebAccess(settings),
    onProgress,
    onToken,
    researchTool: true,
  });
}

/** Open decisions whose text overlaps the query, newest first, capped. */
function relevantDecisions(query: string) {
  const open = decisions.open();
  if (open.length === 0) return [];
  const terms = query.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
  if (terms.length === 0) return open.slice(0, DECISION_CONTEXT_MAX);
  const scored = open
    .map((d) => {
      const hay = `${d.decision} ${d.reasons} ${d.expectedOutcome}`.toLowerCase();
      const score = terms.reduce((n, t) => (hay.includes(t) ? n + 1 : n), 0);
      return { d, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((s) => s.d);
  return scored.slice(0, DECISION_CONTEXT_MAX);
}

/** A canned reflection (Stage 1c) over recent notes. Notes-only, never web. */
export async function reflectOnNotes(
  kind: ReflectionKind,
  settings: Settings,
  workspaceId?: string,
): Promise<ChatResult> {
  const name = settings.callName;
  const sinceISO = reflectionIsWeekly(kind)
    ? new Date(Date.now() - 7 * 86_400_000).toISOString()
    : undefined;
  const usedNotes = notes.recent(REFLECTION_CONTEXT_NOTES, sinceISO, workspaceId);
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
  return complete(history, usedNotes, [], settings, { web: 'disabled' });
}

/** Shared completion path: build the prompt, call the selected backend. */
async function complete(
  history: ChatMessage[],
  usedNotes: NoteView[],
  usedDecisions: ReturnType<typeof relevantDecisions>,
  settings: Settings,
  options: CompleteOptions,
): Promise<ChatResult> {
  const name = settings.callName;
  const web = options.web ?? 'disabled';
  // Oldest-first inside the prompt block reads naturally for the model.
  const contextNotes = [...usedNotes].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const decisionsBlock = buildDecisionsContext(
    [...usedDecisions]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((d) => ({ createdAt: d.createdAt, decision: d.decision, status: d.status })),
  );
  const system = [
    buildChatSystemPrompt({ web }),
    buildNotesContext(contextNotes),
    decisionsBlock,
  ]
    .filter((s) => s.length > 0)
    .join('\n\n');

  const reply = await callModel(system, history, settings, options);
  if (reply === null) {
    const template = cloudChatAllowed(settings)
      ? getOpenAIKey()
        ? CLOUD_FAILED
        : NO_KEY
      : LOCAL_FAILED;
    return fail(template, name);
  }
  // start_research sentinel: no reply text — the caller launches the detached
  // task and speaks the ack in Rocky's place.
  if (reply.startResearch) {
    return { ok: true, startResearch: reply.startResearch, usedNotes };
  }
  const rendered = sanitizeReply(renderLine(reply.text, { name }), options.maxLength);
  if (!rendered) return fail(cloudChatAllowed(settings) ? CLOUD_FAILED : LOCAL_FAILED, name);
  return {
    ok: true,
    reply: rendered,
    usedNotes,
    ...(reply.sources.length > 0 ? { sources: reply.sources } : {}),
  };
}

/**
 * Provider-agnostic model dispatch shared by chat, research, and distillation.
 * Returns the reply text + any web sources, or null when no backend is usable.
 */
export async function callModel(
  system: string,
  history: ChatMessage[],
  settings: Settings,
  options: CompleteOptions = {},
): Promise<ModelReply | null> {
  return cloudChatAllowed(settings)
    ? completeOpenAI(system, history, settings, options)
    : completeOllama(system, history, settings, options);
}

/**
 * Best-effort 1-3 topic tags for a note, via the same provider selection (and
 * the same notes-cloud gate) as chat. Returns [] when no backend is usable.
 */
export async function suggestTopics(text: string, settings: Settings): Promise<string[]> {
  const history: ChatMessage[] = [{ role: 'user', text: text.slice(0, 2_000) }];
  const reply = await callModel(TOPIC_TAG_PROMPT, history, settings, { web: 'disabled' });
  return reply ? parseTopicTags(reply.text) : [];
}

/**
 * Distill a decision from the recent conversation. Uses the same provider
 * dispatch, never the web. Returns a draft for the human to confirm.
 */
export async function distillDecision(
  history: ChatMessage[],
  settings: Settings,
): Promise<DecisionDraftResult> {
  const trimmed = normalizeHistory(history);
  if (trimmed.length === 0) return { ok: false, error: 'Nothing to log yet.' };
  const reply = await callModel(DECISION_DISTILL_PROMPT, trimmed, settings, { web: 'disabled' });
  if (reply === null) return { ok: false, error: 'Rocky could not reach a brain to distill that.' };
  const draft = parseDecisionDraft(reply.text);
  if (!draft) return { ok: false, error: 'No clear decision found in the conversation yet.' };
  return { ok: true, draft };
}

function toInput(history: ChatMessage[]) {
  return history.map((m) => ({
    role: m.role === 'rocky' ? ('assistant' as const) : ('user' as const),
    content: m.text,
  }));
}

// ── OpenAI (cloud) ────────────────────────────────────────────────────────────

/** Extract url_citation annotations from a Responses API result. */
function harvestOpenAISources(response: unknown): WebSource[] {
  const sources: WebSource[] = [];
  const seen = new Set<string>();
  const output = (response as { output?: unknown[] })?.output;
  if (!Array.isArray(output)) return sources;
  for (const item of output) {
    const content = (item as { content?: unknown[] })?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const annotations = (part as { annotations?: unknown[] })?.annotations;
      if (!Array.isArray(annotations)) continue;
      for (const ann of annotations) {
        const a = ann as { type?: string; url?: string; title?: string };
        if (a.type !== 'url_citation' || typeof a.url !== 'string' || seen.has(a.url)) continue;
        seen.add(a.url);
        sources.push({ title: a.title || a.url, url: a.url });
      }
    }
  }
  return sources;
}

async function completeOpenAI(
  system: string,
  history: ChatMessage[],
  settings: Settings,
  options: CompleteOptions,
): Promise<ModelReply | null> {
  const key = getOpenAIKey();
  if (!key) return null;
  const controller = new AbortController();
  activeChatControllers.add(controller);
  const timer = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS);
  try {
    const client = new OpenAI({ apiKey: key });
    if (options.web === 'available') options.onProgress?.('Rocky searches the web…');
    const offerResearch = options.web === 'available' && options.researchTool === true;
    const body = {
      model: settings.openaiModel,
      instructions: system,
      input: toInput(history),
      ...(options.web === 'available'
        ? {
            tools: [
              { type: 'web_search_preview' as const },
              ...(offerResearch ? [OPENAI_RESEARCH_TOOL] : []),
            ],
          }
        : {}),
    };

    let response: unknown;
    let text: string | null = null;
    if (options.onToken) {
      const stream = await client.responses.create(
        { ...body, stream: true as const },
        { signal: controller.signal },
      );
      let streamed = '';
      for await (const rawEvent of stream) {
        const event = rawEvent as unknown as { type?: string; delta?: string; response?: unknown };
        if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
          streamed += event.delta;
          options.onToken(event.delta);
        }
        if (event.type === 'response.completed') response = event.response;
      }
      text = streamed || ((response as { output_text?: string } | undefined)?.output_text ?? null);
    } else {
      response = await client.responses.create(body, { signal: controller.signal });
      text = (response as { output_text?: string }).output_text ?? null;
    }

    if (offerResearch) {
      const topic = startResearchTopicFromOpenAIOutput(
        (response as { output?: unknown[] } | undefined)?.output,
      );
      if (topic) return { text: '', sources: [], startResearch: topic };
    }
    if (text === null) return null;
    return { text, sources: options.web === 'available' ? harvestOpenAISources(response) : [] };
  } catch {
    return null; // Generic, silent — never leak the key or network detail.
  } finally {
    clearTimeout(timer);
    activeChatControllers.delete(controller);
  }
}

// ── Ollama (local) ──────────────────────────────────────────────────────────

interface OllamaToolCall {
  function?: { name?: string; arguments?: unknown };
}
interface OllamaMessage {
  role?: string;
  content?: string;
  tool_calls?: OllamaToolCall[];
}
interface OllamaChatResponse {
  message?: OllamaMessage;
}

/** One POST to Ollama /api/chat. Returns the parsed response, or a status. */
async function ollamaChat(
  settings: Settings,
  messages: unknown[],
  tools: unknown[] | undefined,
  signal: AbortSignal,
  onToken?: (delta: string) => void,
): Promise<{ ok: true; message: OllamaMessage } | { ok: false; toolsUnsupported: boolean }> {
  const model = settings.ollamaChatModel.trim() || settings.ollamaModel;
  const streaming = !!onToken && (!tools || tools.length === 0);
  try {
    const res = await fetch(`${settings.ollamaHost.replace(/\/+$/, '')}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: streaming,
        options: { temperature: 0.7 },
        messages,
        ...(tools && tools.length > 0 ? { tools } : {}),
      }),
      signal,
    });
    if (!res.ok) {
      let toolsUnsupported = false;
      if (tools && (res.status === 400 || res.status === 500)) {
        try { toolsUnsupported = /tool|function/i.test(await res.text()); } catch { /* ignore */ }
      }
      return { ok: false, toolsUnsupported };
    }
    if (!streaming) {
      const data = (await res.json()) as OllamaChatResponse;
      return { ok: true, message: data.message ?? {} };
    }
    if (!res.body) return { ok: false, toolsUnsupported: false };
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    let content = '';
    while (true) {
      const { done, value } = await reader.read();
      pending += decoder.decode(value ?? new Uint8Array(), { stream: !done });
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as OllamaChatResponse;
          const delta = event.message?.content ?? '';
          if (delta) { content += delta; onToken?.(delta); }
        } catch { /* ignore malformed stream line */ }
      }
      if (done) break;
    }
    if (pending.trim()) {
      try {
        const event = JSON.parse(pending) as OllamaChatResponse;
        const delta = event.message?.content ?? '';
        if (delta) { content += delta; onToken?.(delta); }
      } catch { /* ignore malformed final line */ }
    }
    return { ok: true, message: { role: 'assistant', content } };
  } catch {
    return { ok: false, toolsUnsupported: false };
  }
}

async function completeOllama(
  system: string,
  history: ChatMessage[],
  settings: Settings,
  options: CompleteOptions,
): Promise<ModelReply | null> {
  if (!isLoopbackOllamaHost(settings.ollamaHost)) return null;

  const controller = new AbortController();
  activeChatControllers.add(controller);
  const deadline = options.web === 'available' ? TOOL_LOOP_DEADLINE_MS : CHAT_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), deadline);
  const onProgress = options.onProgress ?? noop;
  const sources: WebSource[] = [];

  try {
    const messages: unknown[] = [
      { role: 'system', content: system },
      ...history.map((m) => ({
        role: m.role === 'rocky' ? 'assistant' : 'user',
        content: m.text,
      })),
    ];

    // No web: a single plain call, same as before.
    if (options.web !== 'available') {
      const res = await ollamaChat(settings, messages, undefined, controller.signal, options.onToken);
      return res.ok ? { text: res.message.content ?? '', sources } : null;
    }

    // Web available: bounded tool-calling loop. The last round drops the tools
    // so the model is forced to answer from what it gathered.
    const tools: unknown[] = [...OLLAMA_TOOLS];
    if (options.researchTool === true) tools.push(OLLAMA_RESEARCH_TOOL);
    let toolsDisabled = false;
    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      const isLast = i === MAX_TOOL_ITERATIONS - 1;
      const useTools = !toolsDisabled && !isLast;
      const res = await ollamaChat(
        settings,
        messages,
        useTools ? tools : undefined,
        controller.signal,
        useTools ? undefined : options.onToken,
      );
      if (!res.ok) {
        // Model can't take tools: retry once without them and tell the model.
        if (res.toolsUnsupported && !toolsDisabled) {
          toolsDisabled = true;
          messages.push({
            role: 'system',
            content:
              'Your local model cannot search the web this session. Say so plainly if asked; answer from the conversation and NOTEBOOK.',
          });
          i--; // retry this round without tools
          continue;
        }
        return null;
      }
      const msg = res.message;
      const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
      if (calls.length > 0 && useTools) {
        // start_research is a one-shot routing signal: stop the loop here and
        // hand the topic up — its "result" never goes back to the model.
        if (options.researchTool === true) {
          const topic = startResearchTopicFromToolCalls(calls);
          if (topic) return { text: '', sources, startResearch: topic };
        }
        // Record the assistant turn that requested the tools, then answer each.
        messages.push({ role: 'assistant', content: msg.content ?? '', tool_calls: calls });
        for (const call of calls) {
          const name = call.function?.name ?? '';
          const args = parseToolArgs(call.function?.arguments);
          const result = await executeToolCall(name, args, sources, onProgress);
          messages.push({ role: 'tool', content: result });
        }
        continue;
      }
      return { text: msg.content ?? '', sources };
    }
    return null;
  } finally {
    clearTimeout(timer);
    activeChatControllers.delete(controller);
  }
}
