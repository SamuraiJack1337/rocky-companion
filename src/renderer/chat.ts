// Rocky Notes window: a conversation with Rocky about the user's own notes and
// the wider world (Talk tab) and the notebook + decisions (Notebook tab). The
// transcript now persists locally (userData/chat-history.json) so a long
// sounding-board or research thread survives closing the window; the user can
// wipe it with Clear chat. All model and web access happens in main via
// window.rocky — nothing here reaches a key or the network directly.
//
// Rocky's replies are spoken through the same TTS path as his bubbles when a
// spoken voice is configured (main enforces key + consent; we only ask).

import type {
  ChatMessage,
  DecisionRecord,
  NoteView,
  ReflectionKind,
  Settings,
  WebSource,
  WorkspaceRecord,
  TaskRecord,
  ResearchArtifact,
} from '../shared/types';
import { INBOX_WORKSPACE_ID } from '../shared/types';
import { noteSnippet } from '../shared/persona';
import { parseResearchIntent } from '../shared/voiceIntent';
import { VoiceRecorder } from './recorder';
import { SpokenVoice } from './spokenVoice';

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`chat.html is missing #${id}`);
  return node as T;
}

function setStatus(node: HTMLElement, text: string, kind: 'ok' | 'err' | 'live' | 'muted' = 'muted'): void {
  node.textContent = text;
  node.className = `status ${kind}`;
}

const talkTab = el<HTMLButtonElement>('talk-tab');
const notebookTab = el<HTMLButtonElement>('notebook-tab');
const talkPanel = el<HTMLElement>('talk-panel');
const notebookPanel = el<HTMLElement>('notebook-panel');
const chatLog = el<HTMLDivElement>('chat-log');
const chatInput = el<HTMLTextAreaElement>('chat-input');
const sendBtn = el<HTMLButtonElement>('send');
const cancelChatTurnBtn = el<HTMLButtonElement>('cancel-chat-turn');
const saveNoteBtn = el<HTMLButtonElement>('save-note');
const researchBtn = el<HTMLButtonElement>('research');
const micBtn = el<HTMLButtonElement>('mic');
const voiceChatBtn = el<HTMLButtonElement>('voice-chat');
const clearChatBtn = el<HTMLButtonElement>('clear-chat');
const logDecisionBtn = el<HTMLButtonElement>('log-decision');
const talkStatus = el<HTMLDivElement>('talk-status');
const notesList = el<HTMLDivElement>('notes-list');
const topicChips = el<HTMLDivElement>('topic-chips');
const decisionsSection = el<HTMLDivElement>('decisions-section');
const decisionsList = el<HTMLDivElement>('decisions-list');
const noteInput = el<HTMLInputElement>('note-input');
const addNoteBtn = el<HTMLButtonElement>('add-note');
const clearNotesBtn = el<HTMLButtonElement>('clear-notes');
const notebookStatus = el<HTMLDivElement>('notebook-status');
const workspaceSelect = el<HTMLSelectElement>('workspace-select');
const addWorkspaceBtn = el<HTMLButtonElement>('add-workspace');
const deleteWorkspaceBtn = el<HTMLButtonElement>('delete-workspace');
const tasksList = el<HTMLDivElement>('tasks-list');
const taskInput = el<HTMLInputElement>('task-input');
const taskReminder = el<HTMLInputElement>('task-reminder');
const addTaskBtn = el<HTMLButtonElement>('add-task');
const researchArtifactsSection = el<HTMLDivElement>('research-artifacts-section');
const researchArtifactsList = el<HTMLDivElement>('research-artifacts-list');
const voiceState = el<HTMLSpanElement>('voice-state');
const pttHint = el<HTMLParagraphElement>('ptt-hint');
const reflectButtons = Array.from(
  document.querySelectorAll<HTMLButtonElement>('[data-reflect]'),
);

const messages: ChatMessage[] = [];
const recorder = new VoiceRecorder();
const spoken = new SpokenVoice();
let settings: Settings | null = null;
let busy = false;
/** True while a click-to-talk voice turn is running (drives the re-arm label). */
let voiceChatActive = false;
let researching = false;
let activeChatRequestId: string | null = null;
let chatCancelled = false;
let streamingBubble: HTMLDivElement | null = null;
let streamingText = '';
let allWorkspaces: WorkspaceRecord[] = [];
let activeWorkspaceId = INBOX_WORKSPACE_ID;

// ── Tabs ─────────────────────────────────────────────────────────────────────

function selectTab(tab: 'talk' | 'notebook'): void {
  const talk = tab === 'talk';
  talkTab.setAttribute('aria-selected', String(talk));
  notebookTab.setAttribute('aria-selected', String(!talk));
  talkPanel.hidden = !talk;
  notebookPanel.hidden = talk;
  (talk ? chatInput : noteInput).focus();
}
talkTab.addEventListener('click', () => selectTab('talk'));
notebookTab.addEventListener('click', () => selectTab('notebook'));

// ── Talk ─────────────────────────────────────────────────────────────────────

function paintEmptyLog(): void {
  chatLog.innerHTML = '';
  const empty = document.createElement('div');
  empty.className = 'empty-log';
  const strong = document.createElement('strong');
  strong.textContent = 'We think together here.';
  empty.appendChild(strong);
  empty.append(
    'Ask what you said about something, or use a reflection below. Rocky answers only from your own notes.',
  );
  chatLog.appendChild(empty);
}

interface AppendOptions {
  error?: boolean;
  meta?: string;
  /** Web pages Rocky drew on — rendered as a clickable link row. */
  sources?: WebSource[];
  /** Show a "Keep" button that saves this reply (with sources) as a note. */
  keepable?: boolean;
}

function appendMessage(role: 'user' | 'rocky', text: string, options?: AppendOptions): void {
  if (chatLog.querySelector('.empty-log')) chatLog.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = `msg ${role}${options?.error ? ' error' : ''}`;
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;
  if (options?.meta) {
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = options.meta;
    bubble.appendChild(meta);
  }
  if (options?.sources && options.sources.length > 0) {
    const row = document.createElement('div');
    row.className = 'sources';
    for (const source of options.sources) {
      const link = document.createElement('a');
      link.textContent = source.title || source.url;
      link.title = source.url;
      link.addEventListener('click', (ev) => {
        ev.preventDefault();
        void window.rocky.openExternal(source.url);
      });
      row.appendChild(link);
    }
    bubble.appendChild(row);
  }
  if (options?.keepable && !options.error) {
    const actions = document.createElement('div');
    actions.className = 'msg-actions';
    const keep = document.createElement('button');
    keep.type = 'button';
    keep.textContent = 'Keep';
    keep.title = 'Save this to the notebook';
    keep.addEventListener('click', () => void keepReply(text, options.sources, keep));
    actions.appendChild(keep);
    bubble.appendChild(actions);
  }
  wrap.appendChild(bubble);
  chatLog.appendChild(wrap);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function appendStreamingDelta(delta: string): void {
  if (!delta) return;
  streamingText += delta;
  if (!streamingBubble) {
    if (chatLog.querySelector('.empty-log')) chatLog.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'msg rocky';
    streamingBubble = document.createElement('div');
    streamingBubble.className = 'bubble';
    wrap.appendChild(streamingBubble);
    chatLog.appendChild(wrap);
  }
  streamingBubble.textContent = streamingText;
  chatLog.scrollTop = chatLog.scrollHeight;
}

function clearStreamingPreview(): void {
  streamingBubble?.parentElement?.remove();
  streamingBubble = null;
  streamingText = '';
}

/** Save a Rocky reply (with its sources appended as plain text) to the notebook. */
async function keepReply(text: string, sources: WebSource[] | undefined, btn: HTMLButtonElement): Promise<void> {
  const body =
    sources && sources.length > 0
      ? `${text}\n\nSources:\n${sources.map((s) => `- ${s.title}: ${s.url}`).join('\n')}`
      : text;
  try {
    const result = await window.rocky.addNote(body, activeWorkspaceId);
    if (result.ok) {
      btn.textContent = 'Kept ✓';
      btn.disabled = true;
      setStatus(talkStatus, 'Kept in the notebook.', 'ok');
    } else {
      setStatus(talkStatus, result.error ?? 'Could not keep that.', 'err');
    }
  } catch {
    setStatus(talkStatus, 'Could not keep that.', 'err');
  }
}

function setBusy(value: boolean): void {
  busy = value;
  sendBtn.disabled = value;
  workspaceSelect.disabled = value;
  cancelChatTurnBtn.hidden = !value;
  saveNoteBtn.disabled = value;
  micBtn.disabled = value;
  // Research toggles its own label/disabled state; leave it alone while running.
  if (!researching) researchBtn.disabled = value;
  for (const b of reflectButtons) b.disabled = value;
}

function usedNotesMeta(notes: NoteView[] | undefined): string | undefined {
  if (!notes || notes.length === 0) return undefined;
  return `drew on ${notes.length} note${notes.length === 1 ? '' : 's'}`;
}

/**
 * Speak Rocky's reply through the configured spoken voice (best-effort).
 * Resolves only once playback finishes, so a voice turn knows when to re-arm.
 * Supports both spoken tiers: cloud OpenAI TTS and the offline Kokoro voice.
 */
async function speak(text: string): Promise<void> {
  if (!settings || settings.muted) return;
  const mode = settings.voiceMode;
  if (mode !== 'openai' && mode !== 'offline') return;
  const segments = await (mode === 'openai'
    ? window.rocky.speakLine(text)
    : window.rocky.speakLineOffline(text)
  ).catch(() => null);
  if (segments && segments.length) {
    await spoken.playSequence(segments, settings.voicePitch).catch(() => 0);
  }
}

/**
 * One chat turn. When `andSpeak` is set (voice-chat turns), Rocky's reply is
 * spoken and the promise resolves only after playback, so the caller can re-arm
 * the mic for the next turn.
 */
async function send(andSpeak = false): Promise<void> {
  const text = chatInput.value.trim();
  if (!text || busy) return;
  chatInput.value = '';
  autoGrow();
  appendMessage('user', text);
  messages.push({ role: 'user', text });
  setBusy(true);
  chatCancelled = false;
  activeChatRequestId = crypto.randomUUID();
  clearStreamingPreview();
  setStatus(talkStatus, 'Rocky thinks…', 'live');
  try {
    const result = await window.rocky.sendChat(messages, activeWorkspaceId, activeChatRequestId);
    clearStreamingPreview();
    if (chatCancelled) {
      setStatus(talkStatus, 'Answer cancelled.', 'muted');
      return;
    }
    if (result.ok && result.reply) {
      messages.push({ role: 'rocky', text: result.reply });
      appendMessage('rocky', result.reply, {
        meta: usedNotesMeta(result.usedNotes),
        sources: result.sources,
        keepable: true,
      });
      setStatus(talkStatus, '');
      updateDecisionAffordance();
      // The model routed this turn into research (main already started the
      // task); the reply is the ack — paint the running state so Cancel works.
      if (result.startResearch) paintResearchRunning();
      if (andSpeak) await speak(result.reply);
      else void speak(result.reply);
    } else {
      appendMessage('rocky', result.error ?? 'Rocky lost the thread.', { error: true });
      setStatus(talkStatus, '');
    }
  } catch {
    clearStreamingPreview();
    if (!chatCancelled) {
      appendMessage('rocky', 'Rocky lost the thread. Try again, question?', { error: true });
      setStatus(talkStatus, '');
    }
  } finally {
    activeChatRequestId = null;
    setBusy(false);
  }
}

cancelChatTurnBtn.addEventListener('click', () => {
  if (!activeChatRequestId) return;
  chatCancelled = true;
  clearStreamingPreview();
  setStatus(talkStatus, 'Cancelling…', 'muted');
  void window.rocky.cancelChat();
});

/** Show the "Log decision" button once a conversation has some substance. */
function updateDecisionAffordance(): void {
  logDecisionBtn.hidden = messages.filter((m) => m.role === 'user').length < 1;
}

async function reflect(kind: ReflectionKind, label: string): Promise<void> {
  if (busy) return;
  appendMessage('user', label);
  messages.push({ role: 'user', text: label });
  setBusy(true);
  setStatus(talkStatus, 'Rocky reads the notebook…', 'live');
  try {
    const result = await window.rocky.reflect(kind, activeWorkspaceId);
    if (result.ok && result.reply) {
      messages.push({ role: 'rocky', text: result.reply });
      appendMessage('rocky', result.reply, { meta: usedNotesMeta(result.usedNotes), keepable: true });
      updateDecisionAffordance();
      void speak(result.reply);
    } else {
      appendMessage('rocky', result.error ?? 'Rocky lost the thread.', { error: true });
    }
  } catch {
    appendMessage('rocky', 'Rocky lost the thread. Try again, question?', { error: true });
  } finally {
    setStatus(talkStatus, '');
    setBusy(false);
  }
}

sendBtn.addEventListener('click', () => void send());
chatInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    void send();
  }
});

// ── Research (detached background task) ────────────────────────────────────────
// startResearch resolves as soon as main accepts the task; the chat stays fully
// usable while Rocky works. The finished report arrives via onResearchDone —
// and Rocky announces it himself through the companion bubble + spoken digest,
// so this window doesn't need to be open when it lands.

/** True when THIS window witnessed the start (its "Research: …" line is shown). */
let sawResearchStart = false;

function resetResearchUi(): void {
  researching = false;
  sawResearchStart = false;
  researchBtn.textContent = 'Research';
  researchBtn.classList.remove('running');
}

/** A research task is running (started here or routed by the model in main). */
function paintResearchRunning(): void {
  researching = true;
  sawResearchStart = true;
  researchBtn.textContent = 'Cancel';
  researchBtn.classList.add('running');
}

/** Kick off a research task and paint the started state. */
async function startResearchTask(topic: string): Promise<boolean> {
  if (researching || !topic) return false;
  appendMessage('user', `Research: ${topic}`);
  paintResearchRunning();
  setStatus(talkStatus, 'Rocky begins researching…', 'live');
  try {
    const start = await window.rocky.startResearch(topic, activeWorkspaceId);
    if (!start.started) {
      appendMessage('rocky', start.error ?? 'Rocky could not start that research.', { error: true });
      resetResearchUi();
      setStatus(talkStatus, '');
      return false;
    }
    return true;
  } catch {
    appendMessage('rocky', 'Rocky could not start that research.', { error: true });
    resetResearchUi();
    setStatus(talkStatus, '');
    return false;
  }
}

researchBtn.addEventListener('click', () => {
  if (researching) {
    void window.rocky.cancelResearch();
    setStatus(talkStatus, 'Rocky is wrapping up…', 'muted');
    return;
  }
  const topic = chatInput.value.trim();
  if (!topic || busy) return;
  chatInput.value = '';
  autoGrow();
  void startResearchTask(topic);
});

// The finished report — from a task started in this window or any other.
window.rocky.onResearchDone((done) => {
  void refreshResearchArtifacts();
  const witnessed = sawResearchStart;
  resetResearchUi();
  setStatus(talkStatus, '');
  if (done.workspaceId && done.workspaceId !== activeWorkspaceId) return;
  if (done.cancelled) {
    setStatus(talkStatus, 'Research set down.', 'muted');
    return;
  }
  if (done.ok && done.report) {
    // Mirror the turn into the in-memory array (main already persisted it).
    if (!witnessed) appendMessage('user', `Research: ${done.topic}`);
    messages.push({ role: 'user', text: `Research: ${done.topic}` });
    messages.push({ role: 'rocky', text: done.report });
    appendMessage('rocky', done.report, { sources: done.sources, keepable: true });
    updateDecisionAffordance();
  } else {
    appendMessage('rocky', done.error ?? 'Rocky came back empty-handed.', { error: true });
  }
});

// ── Voice conversation (click to talk, Rocky replies aloud) ────────────────────

async function toggleVoiceChat(): Promise<void> {
  if (voiceChatActive) return; // already mid-turn; ignore until it finishes
  if (recorder.isActive()) {
    // Stop recording → transcribe → send → speak → re-arm.
    voiceChatBtn.classList.remove('recording');
    voiceChatActive = true;
    setStatus(talkStatus, 'Rocky listens back…', 'live');
    try {
      const wav = await recorder.stop();
      if (!wav) {
        setStatus(talkStatus, 'Rocky heard only air.', 'err');
        return;
      }
      const result = await window.rocky.transcribeVoice(wav);
      if (!result.ok || !result.text) {
        setStatus(talkStatus, result.error ?? 'Transcription failed.', 'err');
        return;
      }
      // Spoken research command? Kick off the detached task and acknowledge
      // aloud — Rocky announces the finished report himself via the companion.
      const topic = parseResearchIntent(result.text);
      if (topic && settings?.webSearchEnabled && settings.webSearchConsentGiven) {
        voiceChatBtn.classList.add('speaking');
        const started = await startResearchTask(topic);
        if (started) {
          await speak('On it. This needs some digging — Rocky will call out when it is done.');
        }
        return;
      }
      chatInput.value = result.text;
      voiceChatBtn.classList.add('speaking');
      await send(true); // speak the reply, resolve after playback
    } finally {
      voiceChatBtn.classList.remove('speaking');
      voiceChatActive = false;
      voiceChatBtn.textContent = '🗣';
    }
    return;
  }
  if (busy) return;
  try {
    await recorder.start();
    voiceChatBtn.classList.add('recording');
    voiceChatBtn.textContent = '⏹';
    setStatus(talkStatus, 'Speak to Rocky… click again to send.', 'live');
  } catch {
    setStatus(talkStatus, 'Microphone unavailable. Check System Settings → Privacy → Microphone.', 'err');
  }
}
voiceChatBtn.addEventListener('click', () => void toggleVoiceChat());

// ── Clear chat (delete the persisted transcript) ───────────────────────────────

clearChatBtn.addEventListener('click', async () => {
  if (messages.length === 0) return;
  if (!window.confirm('Delete this conversation? Rocky cannot get it back.')) return;
  try {
    await window.rocky.clearChatHistory(activeWorkspaceId);
    messages.length = 0;
    paintEmptyLog();
    updateDecisionAffordance();
    setStatus(talkStatus, 'Conversation cleared.', 'ok');
  } catch {
    setStatus(talkStatus, 'Could not clear the conversation.', 'err');
  }
});

// ── Log decision (distill the conversation, confirm, save) ─────────────────────

logDecisionBtn.addEventListener('click', async () => {
  if (busy || messages.length === 0) return;
  setBusy(true);
  setStatus(talkStatus, 'Rocky distills the decision…', 'live');
  try {
    const result = await window.rocky.distillDecision(messages);
    if (!result.ok || !result.draft) {
      setStatus(talkStatus, result.error ?? 'No clear decision to log yet.', 'err');
      return;
    }
    const d = result.draft;
    const summary = `Log this decision?\n\n${d.decision}${
      d.reasons ? `\n\nWhy: ${d.reasons}` : ''
    }${d.expectedOutcome ? `\n\nExpecting: ${d.expectedOutcome}` : ''}`;
    if (!window.confirm(summary)) {
      setStatus(talkStatus, '');
      return;
    }
    const saved = await window.rocky.logDecision(d);
    if (saved) {
      setStatus(talkStatus, 'Decision logged. Rocky will follow up.', 'ok');
      await refreshDecisions();
    } else {
      setStatus(talkStatus, 'Could not log that decision.', 'err');
    }
  } catch {
    setStatus(talkStatus, 'Could not log that decision.', 'err');
  } finally {
    setBusy(false);
  }
});

function autoGrow(): void {
  chatInput.style.height = 'auto';
  chatInput.style.height = `${Math.min(110, chatInput.scrollHeight)}px`;
}
chatInput.addEventListener('input', autoGrow);

for (const button of reflectButtons) {
  button.addEventListener('click', () =>
    void reflect(button.dataset.reflect as ReflectionKind, button.textContent ?? ''),
  );
}

// Save the composer text as a note without sending it to a model.
saveNoteBtn.addEventListener('click', async () => {
  const text = chatInput.value.trim();
  if (!text || busy) return;
  try {
    const result = await window.rocky.addNote(text, activeWorkspaceId);
    if (result.ok) {
      chatInput.value = '';
      autoGrow();
      setStatus(talkStatus, 'Kept in the notebook.', 'ok');
    } else {
      setStatus(talkStatus, result.error ?? 'Could not keep that.', 'err');
    }
  } catch {
    setStatus(talkStatus, 'Could not keep that.', 'err');
  }
});

// ── Dictation (mic button): transcribe into the composer, save nothing ───────

async function toggleDictation(): Promise<void> {
  if (recorder.isActive()) {
    micBtn.classList.remove('recording');
    micBtn.disabled = true;
    setStatus(talkStatus, 'Translating…', 'live');
    try {
      const wav = await recorder.stop();
      if (!wav) {
        setStatus(talkStatus, 'Rocky heard only air.', 'err');
        return;
      }
      const result = await window.rocky.transcribeVoice(wav);
      if (result.ok && result.text) {
        chatInput.value = chatInput.value ? `${chatInput.value.trimEnd()} ${result.text}` : result.text;
        autoGrow();
        chatInput.focus();
        setStatus(talkStatus, '');
      } else {
        setStatus(talkStatus, result.error ?? 'Transcription failed.', 'err');
      }
    } finally {
      micBtn.disabled = false;
    }
    return;
  }
  try {
    await recorder.start();
    micBtn.classList.add('recording');
    setStatus(talkStatus, 'Listening… click the mic again to stop.', 'live');
  } catch {
    setStatus(talkStatus, 'Microphone unavailable. Check System Settings → Privacy → Microphone.', 'err');
  }
}
micBtn.addEventListener('click', () => void toggleDictation());

// ── Notebook ─────────────────────────────────────────────────────────────────

async function refreshWorkspaces(preferredId = activeWorkspaceId): Promise<void> {
  allWorkspaces = await window.rocky.listWorkspaces();
  if (!allWorkspaces.some((workspace) => workspace.id === preferredId)) preferredId = INBOX_WORKSPACE_ID;
  activeWorkspaceId = preferredId;
  workspaceSelect.innerHTML = '';
  for (const workspace of allWorkspaces) {
    const option = document.createElement('option');
    option.value = workspace.id;
    option.textContent = workspace.name;
    workspaceSelect.appendChild(option);
  }
  workspaceSelect.value = activeWorkspaceId;
  deleteWorkspaceBtn.disabled = activeWorkspaceId === INBOX_WORKSPACE_ID;
}

workspaceSelect.addEventListener('change', () => {
  activeWorkspaceId = workspaceSelect.value || INBOX_WORKSPACE_ID;
  deleteWorkspaceBtn.disabled = activeWorkspaceId === INBOX_WORKSPACE_ID;
  topicFilter = null;
  void Promise.all([restoreHistory(), refreshNotes(), refreshTasks(), refreshResearchArtifacts()]);
});

addWorkspaceBtn.addEventListener('click', () => {
  const name = window.prompt('Project name')?.trim() ?? '';
  if (!name) return;
  void (async () => {
    const workspace = await window.rocky.addWorkspace(name);
    if (!workspace) return setStatus(notebookStatus, 'Could not create that project.', 'err');
    await refreshWorkspaces(workspace.id);
    await Promise.all([refreshNotes(), refreshTasks(), refreshResearchArtifacts()]);
    setStatus(notebookStatus, `Project “${workspace.name}” ready.`, 'ok');
  })();
});

deleteWorkspaceBtn.addEventListener('click', () => {
  const workspace = allWorkspaces.find((item) => item.id === activeWorkspaceId);
  if (!workspace || workspace.builtIn) return;
  if (!window.confirm(`Delete project “${workspace.name}”? Its notes will move to Inbox.`)) return;
  void (async () => {
    await window.rocky.deleteWorkspace(workspace.id);
    await refreshWorkspaces(INBOX_WORKSPACE_ID);
    await Promise.all([refreshNotes(), refreshTasks(), refreshResearchArtifacts()]);
  })();
});

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** The full notebook as last loaded, plus the active topic filter. */
let allNotes: NoteView[] = [];
let topicFilter: string | null = null;

/** Seed the composer with a note so "discuss this" is one click. */
function discussNote(note: NoteView): void {
  activeWorkspaceId = note.workspaceId || INBOX_WORKSPACE_ID;
  workspaceSelect.value = activeWorkspaceId;
  deleteWorkspaceBtn.disabled = activeWorkspaceId === INBOX_WORKSPACE_ID;
  selectTab('talk');
  const day = formatDate(note.createdAt) || note.createdAt.slice(0, 10);
  chatInput.value = `About my note from ${day} — "${noteSnippet(note.text, 120)}": `;
  chatInput.dispatchEvent(new Event('input'));
  chatInput.focus();
  chatInput.setSelectionRange(chatInput.value.length, chatInput.value.length);
}

/** Rebuild the topic filter chips from whatever tags the notes carry. */
function paintTopicChips(): void {
  const topics = Array.from(new Set(allNotes.flatMap((n) => n.topics ?? []))).sort();
  topicChips.innerHTML = '';
  if (topicFilter && !topics.includes(topicFilter)) topicFilter = null;
  topicChips.hidden = topics.length === 0;
  if (topics.length === 0) return;
  for (const topic of [null, ...topics]) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.textContent = topic ?? 'all';
    chip.classList.toggle('active', topicFilter === topic);
    chip.addEventListener('click', () => {
      topicFilter = topic;
      paintTopicChips();
      paintNotes();
    });
    topicChips.appendChild(chip);
  }
}

function paintNotes(): void {
  const notes = topicFilter
    ? allNotes.filter((n) => n.topics?.includes(topicFilter as string))
    : allNotes;
  notesList.innerHTML = '';
  if (notes.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-log';
    empty.textContent = topicFilter
      ? `No notes tagged “${topicFilter}”.`
      : 'No notes yet. Press the talk key and speak a thought, or type one below.';
    notesList.appendChild(empty);
    return;
  }
  for (const note of notes) {
    const card = document.createElement('div');
    card.className = 'note';
    const head = document.createElement('div');
    head.className = 'note-head';
    const when = document.createElement('span');
    when.className = 'note-when';
    when.textContent = `${formatDate(note.createdAt)} · ${note.source === 'voice' ? 'spoken' : 'typed'}`;
    const discuss = document.createElement('button');
    discuss.type = 'button';
    discuss.className = 'note-discuss';
    discuss.textContent = 'Discuss';
    discuss.addEventListener('click', () => discussNote(note));
    const move = document.createElement('button');
    move.type = 'button';
    move.className = 'note-discuss';
    move.textContent = 'Move';
    move.addEventListener('click', async () => {
      const choices = allWorkspaces.map((workspace) => workspace.name).join(', ');
      const currentName = allWorkspaces.find((workspace) => workspace.id === note.workspaceId)?.name ?? 'Inbox';
      const wanted = window.prompt(`Move to project (${choices})`, currentName);
      if (!wanted) return;
      const target = allWorkspaces.find((workspace) => workspace.name.toLowerCase() === wanted.trim().toLowerCase());
      if (!target) return setStatus(notebookStatus, 'Project not found.', 'err');
      await window.rocky.moveNote(note.id, target.id);
      await refreshNotes();
    });
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'note-delete';
    del.textContent = 'Delete';
    del.addEventListener('click', async () => {
      await window.rocky.deleteNote(note.id);
      await refreshNotes();
    });
    head.append(when, discuss, move, del);
    const text = document.createElement('div');
    text.className = 'note-text';
    text.textContent = note.text;
    card.append(head, text);
    if (note.topics && note.topics.length > 0) {
      const row = document.createElement('div');
      row.className = 'note-topics';
      for (const topic of note.topics) {
        const tag = document.createElement('span');
        tag.textContent = topic;
        row.appendChild(tag);
      }
      card.appendChild(row);
    }
    notesList.appendChild(card);
  }
}

async function refreshNotes(): Promise<void> {
  try {
    allNotes = await window.rocky.listNotes(activeWorkspaceId);
    paintTopicChips();
    paintNotes();
  } catch {
    setStatus(notebookStatus, 'Could not load the notebook.', 'err');
  }
}

function paintTasks(records: TaskRecord[]): void {
  tasksList.innerHTML = '';
  if (records.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'hint';
    empty.textContent = 'No tasks in this project.';
    tasksList.appendChild(empty);
    return;
  }
  for (const task of records) {
    const card = document.createElement('div');
    card.className = `decision${task.status === 'completed' ? ' resolved' : ''}`;
    const head = document.createElement('div');
    head.className = 'decision-head';
    const when = document.createElement('span');
    when.className = 'decision-when';
    when.textContent = task.remindAt
      ? `${task.status} · reminds ${formatDate(task.remindAt)}`
      : task.status;
    const toggle = document.createElement('button');
    toggle.className = 'decision-resolve';
    toggle.textContent = task.status === 'completed' ? 'Reopen' : 'Complete';
    toggle.addEventListener('click', async () => {
      await window.rocky.completeTask(task.id, task.status !== 'completed');
      await refreshTasks();
    });
    const del = document.createElement('button');
    del.className = 'decision-delete';
    del.textContent = 'Delete';
    del.addEventListener('click', async () => {
      await window.rocky.deleteTask(task.id);
      await refreshTasks();
    });
    head.append(when, toggle, del);
    const title = document.createElement('div');
    title.className = 'decision-text';
    title.textContent = task.title;
    card.append(head, title);
    tasksList.appendChild(card);
  }
}

async function refreshTasks(): Promise<void> {
  try { paintTasks(await window.rocky.listTasks(activeWorkspaceId)); } catch { /* notes remain usable */ }
}

addTaskBtn.addEventListener('click', () => {
  const title = taskInput.value.trim();
  if (!title) return;
  void (async () => {
    const remindAt = taskReminder.value ? new Date(taskReminder.value).toISOString() : undefined;
    const task = await window.rocky.addTask({ title, workspaceId: activeWorkspaceId, remindAt });
    if (!task) return setStatus(notebookStatus, 'Could not add that task.', 'err');
    taskInput.value = '';
    taskReminder.value = '';
    await refreshTasks();
    setStatus(notebookStatus, 'Task added.', 'ok');
  })();
});
taskInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') addTaskBtn.click(); });

function discussResearch(artifact: ResearchArtifact): void {
  selectTab('talk');
  chatInput.value = `About the research “${noteSnippet(artifact.topic, 100)}”: `;
  chatInput.dispatchEvent(new Event('input'));
  chatInput.focus();
}

function paintResearchArtifacts(records: ResearchArtifact[]): void {
  researchArtifactsSection.hidden = records.length === 0;
  researchArtifactsList.innerHTML = '';
  for (const artifact of records) {
    const card = document.createElement('div');
    card.className = `decision${artifact.status === 'completed' ? ' resolved' : ''}`;
    const head = document.createElement('div');
    head.className = 'decision-head';
    const when = document.createElement('span');
    when.className = 'decision-when';
    when.textContent = `${formatDate(artifact.updatedAt)} · ${artifact.status}`;
    const discuss = document.createElement('button');
    discuss.className = 'decision-discuss';
    discuss.textContent = 'Discuss';
    discuss.addEventListener('click', () => discussResearch(artifact));
    const del = document.createElement('button');
    del.className = 'decision-delete';
    del.textContent = 'Delete';
    del.addEventListener('click', async () => {
      await window.rocky.deleteResearchArtifact(artifact.id);
      await refreshResearchArtifacts();
    });
    head.append(when, discuss, del);
    const title = document.createElement('div');
    title.className = 'decision-text';
    title.textContent = artifact.topic;
    card.append(head, title);
    if (artifact.summary || artifact.error) {
      const detail = document.createElement('div');
      detail.className = 'decision-meta';
      detail.textContent = artifact.summary ?? artifact.error ?? '';
      card.appendChild(detail);
    }
    researchArtifactsList.appendChild(card);
  }
}

async function refreshResearchArtifacts(): Promise<void> {
  try { paintResearchArtifacts(await window.rocky.listResearchArtifacts(activeWorkspaceId)); } catch { /* optional */ }
}

// ── Decisions (in the notebook) ────────────────────────────────────────────────

/** Seed the composer with a decision so "discuss this" is one click. */
function discussDecision(decision: DecisionRecord): void {
  selectTab('talk');
  chatInput.value = `About my decision "${noteSnippet(decision.decision, 100)}": `;
  chatInput.dispatchEvent(new Event('input'));
  chatInput.focus();
  chatInput.setSelectionRange(chatInput.value.length, chatInput.value.length);
}

function paintDecisions(records: DecisionRecord[]): void {
  decisionsSection.hidden = records.length === 0;
  decisionsList.innerHTML = '';
  for (const decision of records) {
    const card = document.createElement('div');
    card.className = `decision${decision.status === 'resolved' ? ' resolved' : ''}`;

    const head = document.createElement('div');
    head.className = 'decision-head';
    const when = document.createElement('span');
    when.className = 'decision-when';
    when.textContent = `${formatDate(decision.createdAt)} · ${decision.status}`;
    const discuss = document.createElement('button');
    discuss.type = 'button';
    discuss.className = 'decision-discuss';
    discuss.textContent = 'Discuss';
    discuss.addEventListener('click', () => discussDecision(decision));
    head.append(when, discuss);
    if (decision.status === 'open') {
      const resolve = document.createElement('button');
      resolve.type = 'button';
      resolve.className = 'decision-resolve';
      resolve.textContent = 'Resolve';
      resolve.addEventListener('click', async () => {
        const outcome = window.prompt('How did it hold up? (one line)') ?? '';
        await window.rocky.resolveDecision(decision.id, outcome);
        await refreshDecisions();
      });
      head.append(resolve);
    }
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'decision-delete';
    del.textContent = 'Delete';
    del.addEventListener('click', async () => {
      await window.rocky.deleteDecision(decision.id);
      await refreshDecisions();
    });
    head.append(del);

    const text = document.createElement('div');
    text.className = 'decision-text';
    text.textContent = decision.decision;
    card.append(head, text);

    const detail = [
      decision.reasons ? `Why: ${decision.reasons}` : '',
      decision.expectedOutcome ? `Expecting: ${decision.expectedOutcome}` : '',
      decision.resolution ? `Outcome: ${decision.resolution}` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    if (detail) {
      const meta = document.createElement('div');
      meta.className = 'decision-meta';
      meta.textContent = detail;
      card.appendChild(meta);
    }
    decisionsList.appendChild(card);
  }
}

async function refreshDecisions(): Promise<void> {
  try {
    paintDecisions(await window.rocky.listDecisions());
  } catch {
    /* the notebook still works without the decisions list */
  }
}

addNoteBtn.addEventListener('click', async () => {
  const text = noteInput.value.trim();
  if (!text) return;
  try {
    const result = await window.rocky.addNote(text, activeWorkspaceId);
    if (result.ok) {
      noteInput.value = '';
      setStatus(notebookStatus, 'Kept.', 'ok');
      await refreshNotes();
    } else {
      setStatus(notebookStatus, result.error ?? 'Could not keep that.', 'err');
    }
  } catch {
    setStatus(notebookStatus, 'Could not keep that.', 'err');
  }
});
noteInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') addNoteBtn.click();
});

clearNotesBtn.addEventListener('click', async () => {
  if (!window.confirm('Delete every note? Rocky cannot get them back.')) return;
  try {
    await window.rocky.clearNotes();
    setStatus(notebookStatus, 'Notebook emptied.', 'ok');
    await refreshNotes();
  } catch {
    setStatus(notebookStatus, 'Could not empty the notebook.', 'err');
  }
});

// ── Live wiring ──────────────────────────────────────────────────────────────

window.rocky.onNoteSaved(() => void refreshNotes());

// A global push-to-talk turn landed in the transcript (main already persisted
// and spoke it through the companion) — mirror it into this window live.
window.rocky.onChatTurn((turn) => {
  messages.push({ role: 'user', text: turn.user });
  messages.push({ role: 'rocky', text: turn.rocky });
  appendMessage('user', turn.user);
  appendMessage('rocky', turn.rocky, { sources: turn.sources, keepable: true });
  updateDecisionAffordance();
});

// Progress lines while Rocky searches, reads, or researches (targets this window).
window.rocky.onChatProgress(({ line }) => {
  if (busy || researching) setStatus(talkStatus, line, 'live');
});

window.rocky.onChatToken(({ requestId, delta }) => {
  if (requestId === activeChatRequestId && !chatCancelled) appendStreamingDelta(delta);
});

// Deep-link: Rocky's popover / tray asked for a reflection on arrival, or a
// decision follow-up seeded the composer.
const REFLECT_LABELS: Record<ReflectionKind, string> = {
  summarize: 'Summarize my notes',
  connections: 'Find connections',
  questions: 'Questions for me',
  weekly: 'Weekly reflection',
};
window.rocky.onChatAction((cmd) => {
  if (cmd.reflect) {
    const label = REFLECT_LABELS[cmd.reflect];
    if (label) {
      selectTab('talk');
      void reflect(cmd.reflect, label);
      return;
    }
  }
  if (cmd.seed) {
    selectTab('talk');
    chatInput.value = cmd.seed;
    chatInput.dispatchEvent(new Event('input'));
    chatInput.focus();
    chatInput.setSelectionRange(chatInput.value.length, chatInput.value.length);
  }
});

window.rocky.onVoiceState((state) => {
  voiceState.textContent =
    state === 'recording'
      ? 'Rocky is listening (push-to-talk)…'
      : state === 'processing'
        ? 'Rocky is translating your thought…'
        : 'Rocky is idle.';
});

/** Render the accelerator in macOS-style glyphs for the header hint. */
function describeShortcut(accelerator: string): string {
  return accelerator
    .replace(/CommandOrControl|CmdOrCtrl/gi, '⌘')
    .replace(/Command|Cmd/gi, '⌘')
    .replace(/Control|Ctrl/gi, '⌃')
    .replace(/Shift/gi, '⇧')
    .replace(/Alt|Option/gi, '⌥')
    .replace(/\+/g, '');
}

function applySettings(s: Settings): void {
  settings = s;
  spoken.setMuted(s.muted);
  pttHint.textContent = `Press ${describeShortcut(s.pushToTalkShortcut)} anywhere and just talk — Rocky keeps notes, answers questions, starts research.`;
}

window.rocky.onSettingsUpdated(applySettings);

/** Restore the persisted transcript into the log and the in-memory array. */
async function restoreHistory(): Promise<void> {
  try {
    const stored = await window.rocky.getChatHistory(activeWorkspaceId);
    messages.length = 0;
    chatLog.innerHTML = '';
    if (!stored || stored.length === 0) {
      paintEmptyLog();
      updateDecisionAffordance();
      return;
    }
    for (const m of stored) {
      messages.push({ role: m.role, text: m.text });
      appendMessage(m.role, m.text, m.role === 'rocky' ? { keepable: true, sources: m.sources } : undefined);
    }
    updateDecisionAffordance();
  } catch {
    paintEmptyLog();
  }
}

async function init(): Promise<void> {
  try {
    applySettings(await window.rocky.getSettings());
  } catch {
    /* defaults are fine until the settings event arrives */
  }
  await restoreHistory();
  await refreshWorkspaces();
  await Promise.all([refreshNotes(), refreshTasks(), refreshResearchArtifacts(), refreshDecisions()]);
  chatInput.focus();
}

const closeChatBtn = document.getElementById('close-chat');
closeChatBtn?.addEventListener('click', () => window.rocky.closeSelf());

void init();
