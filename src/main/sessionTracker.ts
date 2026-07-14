// Same-day session awareness. Tracks how long the user has been on one
// activity so Rocky can notice a long run ("third hour of coding") — entirely
// in memory, by design: persisting activity history would break the privacy
// contract in memory.ts, and same-day nudges don't need to survive a relaunch.

import type { Activity } from '../shared/types';

export interface SessionInsight {
  kind: 'long-run';
  activity: Activity;
  /** The whole-hour threshold that was just crossed (2, 3, 4). */
  hours: number;
}

/** Activities that neither extend nor (alone) end a run — breaks, basically. */
const IGNORED: readonly Activity[] = ['idle', 'sensitive', 'unknown'];
const THRESHOLD_HOURS: readonly number[] = [2, 3, 4];
/** Minimum quiet time between two insights, so Rocky never nags. */
const INSIGHT_COOLDOWN_MS = 45 * 60_000;
/** No observations for this long (pause, sleep, lid closed) ends the run. */
const STALE_GAP_MS = 75 * 60_000;

export class SessionTracker {
  private runActivity: Activity | null = null;
  private runStartMs = 0;
  private lastSeenMs = 0;
  private offStreak = 0;
  private fired = new Set<number>();
  private lastInsightMs = 0;

  /**
   * Record one observation. Returns an insight when a run just crossed a new
   * whole-hour threshold (each fires once per run, with a global cooldown).
   */
  record(activity: Activity, now: Date = new Date()): SessionInsight | null {
    const nowMs = now.getTime();
    if (this.runActivity && nowMs - this.lastSeenMs > STALE_GAP_MS) this.resetRun();

    // Breaks (idle/sensitive/unknown) are invisible: they don't advance
    // lastSeenMs, so a long enough break ends the run via the stale gap while
    // a short one leaves it untouched.
    if (IGNORED.includes(activity)) return null;

    if (this.runActivity === null) {
      this.startRun(activity, nowMs);
      return null;
    }

    if (activity !== this.runActivity) {
      // Tolerate a single stray observation (a quick doc lookup mid-coding
      // shouldn't reset the run); two in a row means the activity changed.
      this.offStreak += 1;
      if (this.offStreak >= 2) this.startRun(activity, nowMs);
      return null;
    }

    this.offStreak = 0;
    this.lastSeenMs = nowMs;

    const hours = (nowMs - this.runStartMs) / 3_600_000;
    for (const threshold of THRESHOLD_HOURS) {
      if (hours < threshold || this.fired.has(threshold)) continue;
      this.fired.add(threshold);
      if (nowMs - this.lastInsightMs < INSIGHT_COOLDOWN_MS) continue;
      this.lastInsightMs = nowMs;
      return { kind: 'long-run', activity, hours: threshold };
    }
    return null;
  }

  /**
   * Read the current run without recording anything: which activity, and how
   * long it has lasted so far. Used to give the realistic remark prompt session
   * context BEFORE the vision call (record() only runs after it). Returns null
   * when there is no live run or it has gone stale.
   */
  peek(now: Date = new Date()): { activity: Activity; hours: number } | null {
    if (!this.runActivity) return null;
    const nowMs = now.getTime();
    if (nowMs - this.lastSeenMs > STALE_GAP_MS) return null;
    return { activity: this.runActivity, hours: (nowMs - this.runStartMs) / 3_600_000 };
  }

  private startRun(activity: Activity, nowMs: number): void {
    this.runActivity = activity;
    this.runStartMs = nowMs;
    this.lastSeenMs = nowMs;
    this.offStreak = 0;
    this.fired.clear();
  }

  private resetRun(): void {
    this.runActivity = null;
    this.offStreak = 0;
    this.fired.clear();
  }
}
