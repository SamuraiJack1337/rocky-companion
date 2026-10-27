// Persisted chat transcript. Historically the conversation was in-memory only
// (closing the window forgot it); now it survives across sessions so a long
// sounding-board or research thread isn't lost. Same owner-only, atomic-write
// pattern as notes.ts. It never leaves the machine except as model context, and
// the user can wipe it any time (Clear chat button → clear()).

import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ChatMessage } from '../shared/types';
import { INBOX_WORKSPACE_ID } from '../shared/types';

/** Cap on stored turns; oldest are trimmed. Generous for multi-day threads. */
export const MAX_STORED_MESSAGES = 200;
/** Per-message clamp, matching the chat request cap. */
const MESSAGE_MAX_LENGTH = 8_000;

interface HistoryFile {
  messages: ChatMessage[];
}

/** Keep only well-formed turns and clamp their text. */
export function sanitizeMessages(input: unknown): ChatMessage[] {
  if (!Array.isArray(input)) return [];
  const out: ChatMessage[] = [];
  for (const m of input) {
    if (!m || typeof m !== 'object') continue;
    const role = (m as ChatMessage).role;
    const text = (m as ChatMessage).text;
    if ((role !== 'user' && role !== 'rocky') || typeof text !== 'string') continue;
    const clean = text.slice(0, MESSAGE_MAX_LENGTH);
    if (!clean.trim()) continue;
    const rawSources = (m as ChatMessage).sources;
    const sources = Array.isArray(rawSources)
      ? rawSources
          .filter((source) => source && typeof source.title === 'string' && typeof source.url === 'string')
          .slice(0, 20)
          .map((source) => ({ title: source.title.slice(0, 200), url: source.url.slice(0, 2_000) }))
      : [];
    const rawKind = (m as ChatMessage).kind;
    const kind = rawKind === 'chat' || rawKind === 'reflection' || rawKind === 'research'
      ? rawKind
      : undefined;
    const workspaceId = typeof (m as ChatMessage).workspaceId === 'string'
      ? (m as ChatMessage).workspaceId!.slice(0, 100)
      : undefined;
    out.push({
      role,
      text: clean,
      ...(sources.length ? { sources } : {}),
      ...(kind ? { kind } : {}),
      ...(workspaceId ? { workspaceId } : {}),
    });
  }
  return out.slice(-MAX_STORED_MESSAGES);
}

export class ChatHistoryStore {
  private current: ChatMessage[] | null = null;

  /** Overridable for tests; defaults to the userData location. */
  constructor(private readonly resolvePath: () => string = () =>
    path.join(app.getPath('userData'), 'chat-history.json')) {}

  private load(): ChatMessage[] {
    if (this.current) return this.current;
    try {
      const raw = JSON.parse(fs.readFileSync(this.resolvePath(), 'utf8')) as Partial<HistoryFile>;
      this.current = sanitizeMessages(raw.messages);
    } catch {
      this.current = [];
    }
    return this.current;
  }

  private save(): void {
    if (!this.current) return;
    const target = this.resolvePath();
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const tmp = `${target}.${process.pid}.tmp`;
      const payload: HistoryFile = { messages: this.current };
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, target);
    } catch (err) {
      console.error('[chatHistory] failed to persist:', (err as Error).message);
    }
  }

  /** The stored transcript, oldest first, optionally scoped to a workspace. */
  list(workspaceId?: string): ChatMessage[] {
    return this.load()
      .filter((message) => !workspaceId || (message.workspaceId || INBOX_WORKSPACE_ID) === workspaceId)
      .map((message) => message.sources ? { ...message, sources: [...message.sources] } : { ...message });
  }

  /** Append one turn (trims to the cap). Empty text is ignored. */
  append(message: ChatMessage): void {
    const clean = sanitizeMessages([message]);
    if (clean.length === 0) return;
    const messages = this.load();
    messages.push(clean[0]);
    if (messages.length > MAX_STORED_MESSAGES) {
      messages.splice(0, messages.length - MAX_STORED_MESSAGES);
    }
    this.save();
  }

  /** Append a whole turn (user + rocky) at once. */
  appendTurn(user: ChatMessage, rocky: ChatMessage): void {
    this.append(user);
    this.append(rocky);
  }

  clear(workspaceId?: string): void {
    this.current = workspaceId
      ? this.load().filter((message) => (message.workspaceId || INBOX_WORKSPACE_ID) !== workspaceId)
      : [];
    this.save();
  }
}

/** Process-wide singleton transcript. */
export const chatHistory = new ChatHistoryStore();
