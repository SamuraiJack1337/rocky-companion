// The user's notebook — the first user content Rocky ever persists, and it is
// always user-authored (spoken via push-to-talk or typed in the chat window).
// Stored as owner-only JSON at userData/notes.json with atomic writes, the
// same pattern as companion-memory.json. Embedding vectors live alongside
// each note for retrieval but are NEVER handed to the renderer (NoteView
// strips them). Deleting a note deletes its embedding with it.

import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { NoteSource, NoteView } from '../shared/types';
import { NOTE_MAX_LENGTH } from '../shared/types';
import { rankNotes } from '../shared/notesSearch';

/** The persisted note shape (NoteView + private retrieval fields). */
export interface StoredNote extends NoteView {
  embedding?: number[];
  embeddingModel?: string;
}

interface NotesFile {
  notes: StoredNote[];
}

/** Collapse whitespace and clamp to the note length cap. */
function normalizeNoteText(text: string): string {
  return (text || '')
    .replace(/[\r\t]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, NOTE_MAX_LENGTH)
    .trim();
}

function toView(note: StoredNote): NoteView {
  return { id: note.id, createdAt: note.createdAt, text: note.text, source: note.source };
}

class NotesStore {
  private current: StoredNote[] | null = null;

  private filePath(): string {
    return path.join(app.getPath('userData'), 'notes.json');
  }

  private load(): StoredNote[] {
    if (this.current) return this.current;
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath(), 'utf8')) as Partial<NotesFile>;
      const notes = Array.isArray(raw.notes) ? raw.notes : [];
      this.current = notes.filter(
        (n): n is StoredNote =>
          !!n &&
          typeof n.id === 'string' &&
          typeof n.createdAt === 'string' &&
          typeof n.text === 'string' &&
          (n.source === 'voice' || n.source === 'chat'),
      );
    } catch {
      this.current = [];
    }
    return this.current;
  }

  private save(): void {
    if (!this.current) return;
    const target = this.filePath();
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const tmp = `${target}.${process.pid}.tmp`;
      const payload: NotesFile = { notes: this.current };
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, target);
    } catch (err) {
      // Persisting is best-effort; the in-memory notebook still governs runtime.
      console.error('[notes] failed to persist notes:', (err as Error).message);
    }
  }

  /** Save a new note. Returns null when the text is empty after cleanup. */
  add(text: string, source: NoteSource): NoteView | null {
    const clean = normalizeNoteText(text);
    if (!clean) return null;
    const notes = this.load();
    const note: StoredNote = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      text: clean,
      source,
    };
    notes.push(note);
    this.save();
    return toView(note);
  }

  /** Attach an embedding to a note (computed asynchronously after save). */
  setEmbedding(id: string, embedding: number[], model: string): void {
    const note = this.load().find((n) => n.id === id);
    if (!note) return;
    note.embedding = embedding;
    note.embeddingModel = model;
    this.save();
  }

  /** All notes, newest first, embeddings stripped. */
  list(): NoteView[] {
    return this.load()
      .map(toView)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Newest first, capped, optionally only notes since a given time. */
  recent(limit: number, sinceISO?: string): NoteView[] {
    let notes = this.list();
    if (sinceISO) notes = notes.filter((n) => n.createdAt >= sinceISO);
    return notes.slice(0, Math.max(0, limit));
  }

  count(): number {
    return this.load().length;
  }

  delete(id: string): void {
    const notes = this.load();
    const index = notes.findIndex((n) => n.id === id);
    if (index < 0) return;
    notes.splice(index, 1);
    this.save();
  }

  clear(): void {
    this.current = [];
    this.save();
  }

  /**
   * Retrieve the notes most relevant to a query, best first. Cosine over
   * embeddings when a query embedding is supplied; keyword overlap otherwise
   * (see shared/notesSearch).
   */
  search(query: string, queryEmbedding: number[] | null, topK: number): NoteView[] {
    const notes = this.load();
    const ranked = rankNotes(query, notes, queryEmbedding, topK);
    const byId = new Map(notes.map((n) => [n.id, n]));
    return ranked
      .map((r) => byId.get(r.id))
      .filter((n): n is StoredNote => !!n)
      .map(toView);
  }

  /** Notes that still need an embedding under the given model (for backfill). */
  missingEmbeddings(model: string): NoteView[] {
    return this.load()
      .filter((n) => !n.embedding || n.embeddingModel !== model)
      .map(toView);
  }
}

/** Process-wide singleton notebook. */
export const notes = new NotesStore();
