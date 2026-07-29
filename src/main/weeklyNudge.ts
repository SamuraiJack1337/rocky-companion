// Weekly-reflection nudge conditions (Stage 1c polish). Pure logic, no
// Electron: main.ts feeds it the clock, settings, and a local note count, and
// only when everything lines up does Rocky offer — a bubble with Reflect now /
// Later buttons. Entirely local; the reflection itself runs only if accepted.

/** Local weekday for the offer (5 = Friday). */
const NUDGE_WEEKDAY = 5;
/** Local hours (inclusive start, exclusive end) — the afternoon window. */
const NUDGE_HOUR_START = 14;
const NUDGE_HOUR_END = 21;
/** Notes captured in the last 7 days needed before a reflection is worth it. */
export const NUDGE_MIN_NOTES = 3;
/** Never offer twice within this many days (guards long Friday sessions). */
const NUDGE_COOLDOWN_DAYS = 6;

export interface WeeklyNudgeInput {
  enabled: boolean;
  paused: boolean;
  /** ISO timestamp of the previous offer, or null. */
  lastNudgeISO: string | null;
  /** Notes captured in the trailing 7 days. */
  recentNoteCount: number;
}

/** True when Rocky should offer the weekly reflection right now. */
export function shouldOfferWeeklyNudge(now: Date, input: WeeklyNudgeInput): boolean {
  if (!input.enabled || input.paused) return false;
  if (now.getDay() !== NUDGE_WEEKDAY) return false;
  const hour = now.getHours();
  if (hour < NUDGE_HOUR_START || hour >= NUDGE_HOUR_END) return false;
  if (input.recentNoteCount < NUDGE_MIN_NOTES) return false;
  if (input.lastNudgeISO) {
    const last = Date.parse(input.lastNudgeISO);
    if (Number.isFinite(last) && now.getTime() - last < NUDGE_COOLDOWN_DAYS * 86_400_000) {
      return false;
    }
  }
  return true;
}
