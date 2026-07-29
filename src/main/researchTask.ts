// The detached research runner, shared by every surface that can launch a
// research task: the chat window's Research button (CH.RESEARCH_START) and the
// global push-to-talk voice route. It accepts or refuses immediately; the run
// itself is fire-and-forget — the finished report is persisted to the chat
// transcript, broadcast to every window (the asking one may be closed), and
// announced by Rocky himself through a companion bubble + spoken digest.

import { EV } from '../shared/ipc';
import type { ResearchStart, RockyReply } from '../shared/types';
import { renderLine } from '../shared/lines';
import { store } from './store';
import { research } from './research';
import { chatHistory } from './chatHistory';
import { broadcast, showCompanionWindow } from './windows';

const noop = (): void => {};

/**
 * Start one background research task. Returns synchronously with whether the
 * task was accepted (in-persona error when not: empty topic, already running).
 * `emitReply` delivers the completion bubble; `onProgress` receives working
 * lines and may target just the asking window.
 */
export function startDetachedResearch(
  rawTopic: string,
  emitReply: (reply: RockyReply) => void,
  onProgress: (line: string) => void = noop,
): ResearchStart {
  const topic = typeof rawTopic === 'string' ? rawTopic.trim() : '';
  const s = store.get();
  if (!topic) return { started: false, error: 'Give Rocky a topic to research, question?' };
  if (research.isRunning()) {
    return {
      started: false,
      error: renderLine('Rocky is already deep in research, {name}.', { name: s.callName }),
    };
  }
  void (async () => {
    const result = await research.run(topic, store.get(), onProgress);
    // A finished report is a Rocky turn — persist it so it lives in the
    // transcript whether or not the chat window is open right now.
    if (result.ok && result.report) {
      chatHistory.append({ role: 'user', text: `Research: ${topic}` });
      chatHistory.append({ role: 'rocky', text: result.report });
    }
    broadcast(EV.RESEARCH_DONE, { ...result, topic });
    // Rocky comes to the user: bubble + spoken line via the companion,
    // except when they cancelled it themselves.
    if (!result.cancelled) {
      const name = store.get().callName;
      const line = result.ok
        ? `${renderLine('Research is done, {name}.', { name })} ${result.summary ?? ''}`.trim()
        : result.error ?? renderLine('The research went nowhere, {name}.', { name });
      showCompanionWindow();
      emitReply({
        line,
        mood: result.ok ? 'excited' : 'concerned',
        activity: 'idle',
        gesture: result.ok ? 'delight' : 'alarm',
        motif: result.ok ? 'complete' : 'concern',
      });
    }
  })();
  return { started: true };
}
