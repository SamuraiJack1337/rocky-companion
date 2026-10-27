// The decision journal: decisions the human logged from a conversation, which
// Rocky follows up on later. Same owner-only, atomic-write storage as notes.ts
// (userData/decisions.json). Content stays on the machine except as chat
// context for the selected provider. Capture is always explicit — the model
// distills a draft, the human confirms it, and only then is it saved here.

import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DecisionDraft, DecisionRecord } from '../shared/types';
import { DECISION_FIELD_MAX_LENGTH, DECISION_FOLLOW_UP_DAYS } from '../shared/types';

interface DecisionsFile {
  decisions: DecisionRecord[];
}

/** Collapse whitespace and clamp one field. */
function normalizeField(text: string): string {
  return (text || '').replace(/\s+/g, ' ').trim().slice(0, DECISION_FIELD_MAX_LENGTH).trim();
}

function isRecord(d: unknown): d is DecisionRecord {
  if (!d || typeof d !== 'object') return false;
  const r = d as DecisionRecord;
  return (
    typeof r.id === 'string' &&
    typeof r.createdAt === 'string' &&
    typeof r.decision === 'string' &&
    typeof r.followUpAfter === 'string' &&
    (r.status === 'open' || r.status === 'resolved')
  );
}

export class DecisionsStore {
  private current: DecisionRecord[] | null = null;

  /** Overridable for tests; defaults to the userData location. Now() is
   *  injectable so follow-up math is deterministic under test. */
  constructor(
    private readonly resolvePath: () => string = () =>
      path.join(app.getPath('userData'), 'decisions.json'),
    private readonly now: () => Date = () => new Date(),
  ) {}

  private load(): DecisionRecord[] {
    if (this.current) return this.current;
    try {
      const raw = JSON.parse(fs.readFileSync(this.resolvePath(), 'utf8')) as Partial<DecisionsFile>;
      this.current = Array.isArray(raw.decisions) ? raw.decisions.filter(isRecord) : [];
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
      const payload: DecisionsFile = { decisions: this.current };
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, target);
    } catch (err) {
      console.error('[decisions] failed to persist:', (err as Error).message);
    }
  }

  /** Save a confirmed draft. Returns null when the decision text is empty. */
  add(draft: DecisionDraft): DecisionRecord | null {
    const decision = normalizeField(draft.decision);
    if (!decision) return null;
    const now = this.now();
    const followUp = new Date(now.getTime() + DECISION_FOLLOW_UP_DAYS * 86_400_000);
    const record: DecisionRecord = {
      id: randomUUID(),
      createdAt: now.toISOString(),
      decision,
      reasons: normalizeField(draft.reasons),
      expectedOutcome: normalizeField(draft.expectedOutcome),
      followUpAfter: followUp.toISOString(),
      status: 'open',
    };
    const decisions = this.load();
    decisions.push(record);
    this.save();
    return record;
  }

  /** All decisions, newest first. */
  list(): DecisionRecord[] {
    return [...this.load()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Open decisions, newest first (for the chat DECISIONS context). */
  open(): DecisionRecord[] {
    return this.list().filter((d) => d.status === 'open');
  }

  /** Push a decision's follow-up horizon out by N days (after Rocky asks once). */
  snoozeFollowUp(id: string, days: number): void {
    const record = this.load().find((d) => d.id === id);
    if (!record) return;
    record.followUpAfter = new Date(this.now().getTime() + days * 86_400_000).toISOString();
    this.save();
  }

  /** Mark a decision resolved with a one-line outcome. */
  resolve(id: string, resolution: string): void {
    const record = this.load().find((d) => d.id === id);
    if (!record) return;
    record.status = 'resolved';
    record.resolution = normalizeField(resolution);
    this.save();
  }

  delete(id: string): void {
    const decisions = this.load();
    const index = decisions.findIndex((d) => d.id === id);
    if (index < 0) return;
    decisions.splice(index, 1);
    this.save();
  }

  clear(): void {
    this.current = [];
    this.save();
  }

  /**
   * The single oldest open decision whose follow-up time has passed, or null.
   * The scheduler uses this to surface at most one nudge per tick.
   */
  dueForFollowUp(): DecisionRecord | null {
    const nowISO = this.now().toISOString();
    const due = this.load()
      .filter((d) => d.status === 'open' && d.followUpAfter <= nowISO)
      .sort((a, b) => a.followUpAfter.localeCompare(b.followUpAfter));
    return due[0] ?? null;
  }
}

/** Process-wide singleton decision journal. */
export const decisions = new DecisionsStore();
