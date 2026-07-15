// Rocky Notes window: a conversation with Rocky about the user's own notes
// (Talk tab) and the notebook itself (Notebook tab). Conversation history is
// deliberately in-memory only — closing the window forgets the chat; only
// notes persist. All model access happens in main via window.rocky.
//
// Rocky's replies are spoken through the same TTS path as his bubbles when the
// spoken voice is configured (main enforces key + consent; we only ask).

import type { ChatMessage, NoteView, ReflectionKind, Settings } from '../shared/types';
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
const saveNoteBtn = el<HTMLButtonElement>('save-note');
const micBtn = el<HTMLButtonElement>('mic');
const talkStatus = el<HTMLDivElement>('talk-status');
const notesList = el<HTMLDivElement>('notes-list');
const noteInput = el<HTMLInputElement>('note-input');
const addNoteBtn = el<HTMLButtonElement>('add-note');
const clearNotesBtn = el<HTMLButtonElement>('clear-notes');
const notebookStatus = el<HTMLDivElement>('notebook-status');
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

function appendMessage(role: 'user' | 'rocky', text: string, options?: { error?: boolean; meta?: string }): void {
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
  wrap.appendChild(bubble);
  chatLog.appendChild(wrap);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function setBusy(value: boolean): void {
  busy = value;
  sendBtn.disabled = value;
  saveNoteBtn.disabled = value;
  for (const b of reflectButtons) b.disabled = value;
}

function usedNotesMeta(notes: NoteView[] | undefined): string | undefined {
  if (!notes || notes.length === 0) return undefined;
  return `drew on ${notes.length} note${notes.length === 1 ? '' : 's'}`;
}

/** Speak Rocky's reply through the configured spoken voice (best-effort). */
async function speak(text: string): Promise<void> {
  if (!settings || settings.voiceMode !== 'openai' || settings.muted) return;
  const segments = await window.rocky.speakLine(text).catch(() => null);
  if (segments && segments.length) {
    void spoken.playSequence(segments, settings.voicePitch).catch(() => 0);
  }
}

async function send(): Promise<void> {
  const text = chatInput.value.trim();
  if (!text || busy) return;
  chatInput.value = '';
  autoGrow();
  appendMessage('user', text);
  messages.push({ role: 'user', text });
  setBusy(true);
  setStatus(talkStatus, 'Rocky thinks…', 'live');
  try {
    const result = await window.rocky.sendChat(messages);
    if (result.ok && result.reply) {
      messages.push({ role: 'rocky', text: result.reply });
      appendMessage('rocky', result.reply, { meta: usedNotesMeta(result.usedNotes) });
      setStatus(talkStatus, '');
      void speak(result.reply);
    } else {
      appendMessage('rocky', result.error ?? 'Rocky lost the thread.', { error: true });
      setStatus(talkStatus, '');
    }
  } catch {
    appendMessage('rocky', 'Rocky lost the thread. Try again, question?', { error: true });
    setStatus(talkStatus, '');
  } finally {
    setBusy(false);
  }
}

async function reflect(kind: ReflectionKind, label: string): Promise<void> {
  if (busy) return;
  appendMessage('user', label);
  messages.push({ role: 'user', text: label });
  setBusy(true);
  setStatus(talkStatus, 'Rocky reads the notebook…', 'live');
  try {
    const result = await window.rocky.reflect(kind);
    if (result.ok && result.reply) {
      messages.push({ role: 'rocky', text: result.reply });
      appendMessage('rocky', result.reply, { meta: usedNotesMeta(result.usedNotes) });
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
    const result = await window.rocky.addNote(text);
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

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function paintNotes(notes: NoteView[]): void {
  notesList.innerHTML = '';
  if (notes.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-log';
    empty.textContent =
      'No notes yet. Press the talk key and speak a thought, or type one below.';
    notesList.appendChild(empty);
    return;
  }
  for (const note of notes) {
    const card = document.createElement('div');
    card.className = 'note';
    const head = document.createElement('div');
    head.className = 'note-head';
    const when = document.createElement('span');
    when.textContent = `${formatDate(note.createdAt)} · ${note.source === 'voice' ? 'spoken' : 'typed'}`;
    const del = document.createElement('button');
    del.type = 'button';
    del.textContent = 'Delete';
    del.addEventListener('click', async () => {
      await window.rocky.deleteNote(note.id);
      await refreshNotes();
    });
    head.append(when, del);
    const text = document.createElement('div');
    text.className = 'note-text';
    text.textContent = note.text;
    card.append(head, text);
    notesList.appendChild(card);
  }
}

async function refreshNotes(): Promise<void> {
  try {
    paintNotes(await window.rocky.listNotes());
  } catch {
    setStatus(notebookStatus, 'Could not load the notebook.', 'err');
  }
}

addNoteBtn.addEventListener('click', async () => {
  const text = noteInput.value.trim();
  if (!text) return;
  try {
    const result = await window.rocky.addNote(text);
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
  pttHint.textContent = `Press ${describeShortcut(s.pushToTalkShortcut)} anywhere to speak a note.`;
}

window.rocky.onSettingsUpdated(applySettings);

async function init(): Promise<void> {
  paintEmptyLog();
  try {
    applySettings(await window.rocky.getSettings());
  } catch {
    /* defaults are fine until the settings event arrives */
  }
  await refreshNotes();
  chatInput.focus();
}

void init();
