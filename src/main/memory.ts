// Privacy-safe relationship memory. This file intentionally stores only
// counters, day-stamps, and timestamps—never screenshots, app names, window
// titles, text, prompts, replies, or activity history.

import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CompanionMemory, RelationshipStage } from '../shared/types';

function stageFor(memory: Omit<CompanionMemory, 'relationshipStage'>): RelationshipStage {
  const score =
    memory.launches * 2 +
    memory.observations +
    memory.focusSessionsCompleted * 8 +
    memory.fistBumps * 3 +
    memory.calculationsCompleted * 2;
  if (score >= 100) return 'trusted-buddy';
  if (score >= 35) return 'buddy';
  if (score >= 10) return 'colleague';
  return 'first-contact';
}

function fresh(): CompanionMemory {
  const now = new Date().toISOString();
  const base = {
    firstSeenAt: now,
    lastSeenAt: now,
    launches: 0,
    observations: 0,
    focusSessionsCompleted: 0,
    fistBumps: 0,
    calculationsCompleted: 0,
    focusDayStreak: 0,
    lastFocusDayISO: null,
  };
  return { ...base, relationshipStage: stageFor(base) };
}

/** Local calendar day as YYYY-MM-DD (not UTC — streaks follow the user's clock). */
function dayISO(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

class MemoryStore {
  private current: CompanionMemory | null = null;

  private filePath(): string {
    return path.join(app.getPath('userData'), 'companion-memory.json');
  }

  private load(): CompanionMemory {
    if (this.current) return this.current;
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath(), 'utf8')) as Partial<CompanionMemory>;
      const seed = fresh();
      const merged = {
        firstSeenAt: typeof raw.firstSeenAt === 'string' ? raw.firstSeenAt : seed.firstSeenAt,
        lastSeenAt: typeof raw.lastSeenAt === 'string' ? raw.lastSeenAt : seed.lastSeenAt,
        launches: safeCount(raw.launches),
        observations: safeCount(raw.observations),
        focusSessionsCompleted: safeCount(raw.focusSessionsCompleted),
        fistBumps: safeCount(raw.fistBumps),
        calculationsCompleted: safeCount(raw.calculationsCompleted),
        focusDayStreak: safeCount(raw.focusDayStreak),
        lastFocusDayISO: typeof raw.lastFocusDayISO === 'string' ? raw.lastFocusDayISO : null,
      };
      this.current = { ...merged, relationshipStage: stageFor(merged) };
    } catch {
      this.current = fresh();
    }
    return this.current;
  }

  private save(): void {
    if (!this.current) return;
    const target = this.filePath();
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const tmp = `${target}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.current, null, 2), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, target);
    } catch {
      // Memory is optional; failure must never interrupt the companion.
    }
  }

  get(): CompanionMemory {
    return { ...this.load() };
  }

  private increment(field: 'launches' | 'observations' | 'focusSessionsCompleted' | 'fistBumps' | 'calculationsCompleted'): CompanionMemory {
    const current = this.load();
    current[field] += 1;
    current.lastSeenAt = new Date().toISOString();
    current.relationshipStage = stageFor(current);
    this.save();
    return this.get();
  }

  recordLaunch(): CompanionMemory { return this.increment('launches'); }
  recordObservation(): CompanionMemory { return this.increment('observations'); }
  recordFistBump(): CompanionMemory { return this.increment('fistBumps'); }
  recordCalculation(): CompanionMemory { return this.increment('calculationsCompleted'); }

  /** Completing a focus session also advances the day streak (first per local day). */
  recordFocusCompleted(now: Date = new Date()): CompanionMemory {
    const current = this.load();
    current.focusSessionsCompleted += 1;
    const today = dayISO(now);
    if (current.lastFocusDayISO !== today) {
      const yesterday = dayISO(new Date(now.getTime() - 86_400_000));
      current.focusDayStreak = current.lastFocusDayISO === yesterday ? current.focusDayStreak + 1 : 1;
      current.lastFocusDayISO = today;
    }
    current.lastSeenAt = now.toISOString();
    current.relationshipStage = stageFor(current);
    this.save();
    return this.get();
  }

  reset(): CompanionMemory {
    this.current = fresh();
    this.save();
    return this.get();
  }
}

function safeCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

export const memory = new MemoryStore();
