// Web tools for the local (Ollama) chat path and the research pipeline:
// searchWeb() queries DuckDuckGo's plain-HTML endpoint (no key, no signup) and
// fetchPage() reads one page as stripped text. Both are deliberately small and
// tolerant — DDG's markup can change, and a failed search degrades to "found
// nothing" rather than an error the model might dress up as fact.
//
// Privacy: these are the ONLY functions through which chat text may reach the
// open web, and callers gate them behind settings.webSearchEnabled +
// webSearchConsentGiven (see chat.ts / store.ts). Queries and URLs are never
// logged, matching the silent-catch style used elsewhere in main.

import type { WebSource } from '../shared/types';

/** Per-request ceiling for a search or page fetch. */
const REQUEST_TIMEOUT_MS = 15_000;
/** Longest page text handed to the model (chars). */
export const PAGE_TEXT_MAX_LENGTH = 8_000;
/** Search results returned per query by default. */
const SEARCH_RESULTS_DEFAULT = 5;
const SEARCH_RESULTS_MAX = 8;

/** A plain browser-ish UA — DDG's HTML endpoint serves empty pages to none. */
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Safari/537.36';

export interface SearchHit extends WebSource {
  snippet: string;
}

/** True for the only protocols a tool may touch. */
export function isFetchableUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Decode the handful of entities that matter in titles/snippets/text. */
function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : '';
    })
    .replace(/&#(\d+);/g, (_, dec: string) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : '';
    })
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

/** Strip tags from an HTML fragment and collapse whitespace. */
function stripTags(fragment: string): string {
  return decodeEntities(fragment.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * DDG result links are redirects (`//duckduckgo.com/l/?uddg=<encoded>`);
 * unwrap to the real destination. Direct http(s) hrefs pass through.
 */
function resolveResultUrl(href: string): string | null {
  const raw = decodeEntities(href.trim());
  const uddg = raw.match(/[?&]uddg=([^&]+)/);
  if (uddg) {
    try {
      const target = decodeURIComponent(uddg[1]);
      return isFetchableUrl(target) ? target : null;
    } catch {
      return null;
    }
  }
  if (raw.startsWith('//')) return resolveResultUrl(`https:${raw}`);
  return isFetchableUrl(raw) ? raw : null;
}

/**
 * Parse DDG's HTML results page into hits. Tolerant by construction: anything
 * that doesn't match simply isn't a hit, and an unrecognized page yields [].
 */
export function parseDuckDuckGoHtml(html: string, max = SEARCH_RESULTS_DEFAULT): SearchHit[] {
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  const linkRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippets: string[] = [];
  for (let m = snippetRe.exec(html); m; m = snippetRe.exec(html)) {
    snippets.push(stripTags(m[1]));
  }
  let index = 0;
  for (let m = linkRe.exec(html); m && hits.length < max; m = linkRe.exec(html), index++) {
    const url = resolveResultUrl(m[1]);
    const title = stripTags(m[2]);
    if (!url || !title || seen.has(url)) continue;
    seen.add(url);
    hits.push({ title: title.slice(0, 200), url, snippet: (snippets[index] ?? '').slice(0, 400) });
  }
  return hits;
}

/** GET with a hard timeout and a browser-ish UA. Returns null on any failure. */
async function fetchText(url: string, accept: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: accept },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Search the web. Returns [] when the network, DDG, or the parse fails —
 * callers (and the model) treat that as "search found nothing".
 */
export async function searchWeb(query: string, max = SEARCH_RESULTS_DEFAULT): Promise<SearchHit[]> {
  const q = (query || '').trim().slice(0, 400);
  if (!q) return [];
  const capped = Math.max(1, Math.min(SEARCH_RESULTS_MAX, max));
  const html = await fetchText(
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
    'text/html',
  );
  if (!html) return [];
  return parseDuckDuckGoHtml(html, capped);
}

/**
 * Reduce a full HTML document to readable text: drop script/style/nav chrome,
 * strip tags, collapse whitespace, clamp. Good enough for a model to read.
 */
export function extractReadableText(html: string, cap = PAGE_TEXT_MAX_LENGTH): string {
  const withoutBlocks = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(?:nav|header|footer|aside|noscript|svg|form)[\s\S]*?<\/(?:nav|header|footer|aside|noscript|svg|form)>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  const withBreaks = withoutBlocks
    .replace(/<\/(?:p|div|li|h[1-6]|tr|section|article|blockquote|pre)>/gi, '\n')
    .replace(/<(?:br|hr)[^>]*>/gi, '\n');
  const text = decodeEntities(withBreaks.replace(/<[^>]*>/g, ' '))
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text.slice(0, cap).trim();
}

export interface FetchedPage {
  url: string;
  title: string;
  text: string;
}

/** Fetch one page as readable text. Null on any failure (or a non-web URL). */
export async function fetchPage(url: string): Promise<FetchedPage | null> {
  if (!isFetchableUrl(url)) return null;
  const html = await fetchText(url, 'text/html,application/xhtml+xml');
  if (!html) return null;
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? stripTags(titleMatch[1]).slice(0, 200) : url;
  const text = extractReadableText(html);
  if (!text) return null;
  return { url, title, text };
}

// ── Tool-calling plumbing (Ollama /api/chat `tools`) ─────────────────────────

/** Tool definitions in Ollama's (OpenAI-function-compatible) shape. */
export const OLLAMA_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'search_web',
      description:
        'Search the web. Returns titles, URLs, and snippets of the best matches. Use when the conversation and notebook are not enough.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The search query, plain keywords.' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_page',
      description:
        'Read one web page as plain text. Use on a promising search result to get the details.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The full http(s) URL to read.' },
        },
        required: ['url'],
      },
    },
  },
] as const;

// ── start_research: a routing signal, not a real tool ─────────────────────────
// Layer 2 of voice/chat intent routing: once a turn is already a conversation,
// the MODEL may decide a background research task is warranted, whatever the
// phrasing. The call is intercepted one-shot — its "result" never goes back to
// the model; the caller kicks off the detached research task and Rocky's reply
// becomes the in-persona ack. Offered only when web access is allowed, exactly
// like the search tools.

export const START_RESEARCH_TOOL_NAME = 'start_research';

const START_RESEARCH_DESCRIPTION =
  'Launch a background research task that searches multiple angles and reports back later. Call this ONLY when the human explicitly asks you to research, investigate, or dig into a topic in depth. For quick questions, just search and answer inline.';

const START_RESEARCH_PARAMETERS = {
  type: 'object',
  properties: {
    topic: { type: 'string', description: 'A crisp statement of the topic to research.' },
  },
  required: ['topic'],
} as const;

/** Ollama (OpenAI-function-compatible) shape, appended next to OLLAMA_TOOLS. */
export const OLLAMA_RESEARCH_TOOL = {
  type: 'function',
  function: {
    name: START_RESEARCH_TOOL_NAME,
    description: START_RESEARCH_DESCRIPTION,
    parameters: START_RESEARCH_PARAMETERS,
  },
} as const;

/** OpenAI Responses API function-tool shape (alongside web_search_preview). */
export const OPENAI_RESEARCH_TOOL = {
  type: 'function' as const,
  name: START_RESEARCH_TOOL_NAME,
  description: START_RESEARCH_DESCRIPTION,
  parameters: START_RESEARCH_PARAMETERS as unknown as Record<string, unknown>,
  strict: false,
};

/** The topic when an Ollama `tool_calls` array holds a start_research call. */
export function startResearchTopicFromToolCalls(calls: unknown): string | null {
  if (!Array.isArray(calls)) return null;
  for (const call of calls) {
    const fn = (call as { function?: { name?: string; arguments?: unknown } })?.function;
    if (fn?.name !== START_RESEARCH_TOOL_NAME) continue;
    const topic = parseToolArgs(fn.arguments).topic;
    if (typeof topic === 'string' && topic.trim()) return topic.trim();
  }
  return null;
}

/** The topic when an OpenAI Responses `output` holds a start_research call. */
export function startResearchTopicFromOpenAIOutput(output: unknown): string | null {
  if (!Array.isArray(output)) return null;
  for (const item of output) {
    const it = item as { type?: string; name?: string; arguments?: unknown };
    if (it?.type !== 'function_call' || it.name !== START_RESEARCH_TOOL_NAME) continue;
    const topic = parseToolArgs(it.arguments).topic;
    if (typeof topic === 'string' && topic.trim()) return topic.trim();
  }
  return null;
}

/**
 * Parse tool-call arguments defensively: Ollama sends an object, some models
 * send a JSON string, clumsy ones send garbage. Always returns an object.
 */
export function parseToolArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* fall through */
    }
  }
  return {};
}

/** What the loop reports back to the UI while a tool runs. */
export interface ToolProgress {
  line: string;
}

const NETWORK_ERROR_RESULT = JSON.stringify({
  error: 'network unreachable — say so honestly and answer from what you already have',
});

/** Short display form of a URL for progress lines (host only, never the path). */
export function displayHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'a page';
  }
}

/**
 * Execute one named tool call. Returns the string handed back to the model as
 * the tool result; discovered pages/results are appended to `sources` so the
 * UI can show them. Unknown tools get an explanatory error string.
 */
export async function executeToolCall(
  name: string,
  args: Record<string, unknown>,
  sources: WebSource[],
  onProgress: (line: string) => void,
): Promise<string> {
  if (name === 'search_web') {
    const query = typeof args.query === 'string' ? args.query : '';
    if (!query.trim()) return JSON.stringify({ error: 'search_web needs a query' });
    onProgress('Rocky searches the web…');
    const hits = await searchWeb(query);
    if (hits.length === 0) return NETWORK_ERROR_RESULT;
    for (const hit of hits) {
      if (!sources.some((s) => s.url === hit.url)) {
        sources.push({ title: hit.title, url: hit.url });
      }
    }
    return JSON.stringify({
      results: hits.map((h) => ({ title: h.title, url: h.url, snippet: h.snippet })),
    });
  }
  if (name === 'fetch_page') {
    const url = typeof args.url === 'string' ? args.url : '';
    if (!isFetchableUrl(url)) return JSON.stringify({ error: 'fetch_page needs a full http(s) url' });
    onProgress(`Rocky reads ${displayHost(url)}…`);
    const page = await fetchPage(url);
    if (!page) return NETWORK_ERROR_RESULT;
    if (!sources.some((s) => s.url === page.url)) {
      sources.push({ title: page.title, url: page.url });
    }
    return JSON.stringify({ title: page.title, url: page.url, text: page.text });
  }
  return JSON.stringify({ error: `unknown tool: ${name}` });
}
