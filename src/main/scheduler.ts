// Screenshot scheduler. Owns the capture cadence and the manual "look now"
// trigger, decides Rocky's reaction, and enforces the behavioral rules:
//   - Pause = no captures at all.
//   - De-duplicate near-identical back-to-back lines.
//   - Late-night (after ~1am) nudges toward rest.
//   - Blank frames (likely missing Screen Recording permission) get a gentle,
//     non-spammy hint instead of a crash.
//   - Any provider/capture failure degrades to a calm in-character line.
//
// Cadence is humanized rather than mechanical: the interval carries ±20%
// jitter, and a lightweight watcher adds event-driven looks — when the
// frontmost app changes and sticks, or when the machine wakes from a long
// idle — under a global cooldown so Rocky never feels like a cron job.
//
// The scheduler is deliberately decoupled from Electron: everything it touches
// comes through SchedulerDeps, so it is easy to reason about and test.

import type { Activity, RelationshipStage, Settings, RockyReply, ScreenObservation } from '../shared/types';
import { clampInterval } from '../shared/types';
import { composeRockyReply, fallbackReply, linesAreSimilar } from '../shared/persona';
import { renderLine } from '../shared/lines';
import type { VisionProvider } from './providers/VisionProvider';
import type { CaptureResult } from './capture';
import { isAppBlocked } from './activeApp';

export interface SchedulerDeps {
  getSettings: () => Settings;
  /** Returns the currently-configured provider (rebuilt by main on changes). */
  getProvider: () => VisionProvider;
  capture: () => Promise<CaptureResult>;
  /** Push a reaction to the companion window. */
  emitReply: (reply: RockyReply) => void;
  /** Fire the subtle capture indicator (pulse) at the moment of capture. */
  emitCaptureIndicator: () => void;
  /** Whether macOS Screen Recording permission is granted. */
  isScreenGranted: () => boolean;
  /** Focus mode suppresses scheduled observations while leaving manual Look now available. */
  isFocusActive: () => boolean;
  /** Returns only the frontmost app's display name; no title or URL is requested. */
  getActiveAppName: () => Promise<string | null>;
  recordObservation: (observation: ScreenObservation) => ObservationOutcome;
  /** Seconds since the last user input (powerMonitor); used to notice idle→active wakes. */
  getIdleSeconds: () => number;
  /** Read the current same-activity run (session tracker) without recording. */
  peekSession: () => { activity: Activity; hours: number } | null;
}

/** What recording an observation produced beyond the counter bump. */
export interface ObservationOutcome {
  relationshipStage: RelationshipStage;
  /** A milestone/session-awareness reply that replaces the ordinary line. */
  specialReply: RockyReply | null;
  /** What produced specialReply. Realistic mode lets a model-written remark
   *  stand in for the templated session nudge, but never for a milestone. */
  specialKind?: 'milestone' | 'session';
}

/** Hard ceiling for a single analyze pass so a tick can never hang forever. */
const TICK_TIMEOUT_MS = 90_000;
/** How many of Rocky's own recent remarks the realistic prompt gets back. */
const REMARK_HISTORY_LIMIT = 3;
/** Session runs shorter than this never reach the prompt (avoid nag noise). */
const SESSION_NUDGE_MIN_HOURS = 1.75;
/** Cadence jitter: each scheduled gap is interval × [0.8, 1.2). */
const JITTER_MIN = 0.8;
const JITTER_SPAN = 0.4;
/** Watcher poll cadence for app changes and idle transitions. */
const WATCH_POLL_MS = 30_000;
/** A new frontmost app must stick this long before Rocky reacts to it. */
const APP_SETTLE_MS = 2 * 60_000;
/** Idle at least this long, then active again, counts as "coming back". */
const IDLE_WAKE_THRESHOLD_S = 5 * 60;
/** Floor between any two captures triggered by watcher events. */
const EVENT_COOLDOWN_MIN_MS = 3 * 60_000;

export class Scheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private watchTimer: ReturnType<typeof setInterval> | null = null;
  /** True between start()/resume() and stop(); gates timer re-arming so a
   *  tick finishing after stop() can never resurrect the cadence. */
  private cadenceActive = false;
  private running = false; // guards against overlapping ticks
  private lastShownLine = '';
  private permissionHintShown = false;
  /** Controller for the capture/analysis currently in flight, if any. */
  private currentController: AbortController | null = null;

  /** Rocky's own recent raw remarks (realistic mode), oldest first. */
  private recentRemarks: string[] = [];

  // ── Watcher state (event-driven looks) ───────────────────────────────────
  /** When the last capture actually ran (any trigger), for the event cooldown. */
  private lastCaptureAt = 0;
  /** Frontmost app currently being tracked. undefined = not yet observed. */
  private watchedApp: string | null | undefined = undefined;
  private watchedAppSince = 0;
  /** True once this app stint has triggered (or been excused from) a look. */
  private watchedAppReacted = true;
  /** Idle seconds at the previous watcher poll, to spot idle→active edges. */
  private lastIdleSeconds = 0;

  constructor(private readonly deps: SchedulerDeps) {}

  /** Begin the cadence (no immediate capture; the first look is ~one interval out). */
  start(): void {
    this.cadenceActive = true;
    this.reschedule();
    this.startWatcher();
  }

  stop(): void {
    this.cadenceActive = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.watchTimer) {
      clearInterval(this.watchTimer);
      this.watchTimer = null;
    }
    // Cancel any capture/analysis already in flight so a reply can never
    // surface after the user has paused or quit.
    this.currentController?.abort();
  }

  /** Pause: stop capturing entirely. */
  pause(): void {
    this.stop();
  }

  /** Resume normal cadence. */
  resume(): void {
    this.permissionHintShown = false;
    this.cadenceActive = true;
    this.reschedule();
    this.startWatcher();
  }

  /** Re-apply cadence settings (interval length and/or strict mode). */
  setIntervalMinutes(_minutes: number): void {
    this.reschedule();
    // Strict mode may have flipped alongside; both no-op unless running.
    this.startWatcher();
  }

  dispose(): void {
    this.stop();
  }

  /** Manual trigger from the tray. Always reacts (bypasses dedupe). */
  async lookNow(): Promise<void> {
    const settings = this.deps.getSettings();
    // Never capture before first-run consent — not even on a manual trigger.
    if (!settings.consentGiven) return;
    if (settings.paused) {
      // Pause means sleeping — don't capture; offer a gentle resting line.
      this.deps.emitReply(fallbackReply('sleepy', settings.callName));
      return;
    }
    await this.tick(true);
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /**
   * (Re)arm the main cadence timer with a fresh jittered delay. One-shot: each
   * firing re-arms itself, so every gap gets its own jitter and an event look
   * can push the next scheduled look a full interval out (no double-taps).
   */
  private reschedule(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.cadenceActive) return;
    const settings = this.deps.getSettings();
    if (settings.paused || !settings.consentGiven) return;
    const minutes = clampInterval(settings.intervalMinutes);
    // Strict mode restores the classic clockwork: exactly every N minutes.
    const jitter = settings.strictInterval ? 1 : JITTER_MIN + Math.random() * JITTER_SPAN;
    this.timer = setTimeout(() => {
      void this.tick(false).finally(() => this.reschedule());
    }, minutes * 60_000 * jitter);
  }

  private startWatcher(): void {
    if (this.watchTimer) {
      clearInterval(this.watchTimer);
      this.watchTimer = null;
    }
    if (!this.cadenceActive) return;
    const settings = this.deps.getSettings();
    if (settings.paused || !settings.consentGiven) return;
    // Strict mode = timer only: no event-driven looks at all.
    if (settings.strictInterval) return;
    // Forget stale stint/idle state from before a pause so resuming can't
    // instantly fire an event look for something that happened while asleep.
    this.watchedApp = undefined;
    this.watchedAppReacted = true;
    this.lastIdleSeconds = 0;
    this.watchTimer = setInterval(() => void this.watchTick(), WATCH_POLL_MS);
    this.watchTimer.unref?.();
  }

  /**
   * One watcher poll: notice (a) a new frontmost app that has stuck around and
   * (b) an idle→active wake after a long break. Either earns one extra look,
   * under a global cooldown so events can never stack into spam.
   */
  private async watchTick(): Promise<void> {
    if (!this.cadenceActive) return;
    const settings = this.deps.getSettings();
    if (!settings.consentGiven || settings.paused) return;
    if (this.running) return; // a look is already happening

    const now = Date.now();

    // Idle edge detection: a long-idle machine becoming active again.
    const idle = this.deps.getIdleSeconds();
    const wokeFromIdle = this.lastIdleSeconds >= IDLE_WAKE_THRESHOLD_S && idle < WATCH_POLL_MS / 1000;
    this.lastIdleSeconds = idle;

    // App stint detection: new frontmost app that has settled for a while.
    const app = await this.deps.getActiveAppName();
    let appSettled = false;
    if (app !== this.watchedApp) {
      // The very first poll after (re)start is baseline, not a change — only
      // apps switched TO after that point can earn an event look.
      const isBaseline = this.watchedApp === undefined;
      this.watchedApp = app;
      this.watchedAppSince = now;
      this.watchedAppReacted = isBaseline;
    } else if (app && !this.watchedAppReacted && now - this.watchedAppSince >= APP_SETTLE_MS) {
      this.watchedAppReacted = true;
      appSettled = true;
    }

    if (!wokeFromIdle && !appSettled) return;

    // Global cooldown: at least EVENT_COOLDOWN floor, and never more often
    // than a third of the configured cadence.
    const interval = clampInterval(settings.intervalMinutes) * 60_000;
    const cooldown = Math.max(EVENT_COOLDOWN_MIN_MS, interval / 3);
    if (now - this.lastCaptureAt < cooldown) return;

    await this.tick(false);
    // Push the next scheduled look a full (jittered) interval out.
    this.reschedule();
  }

  /** True if this tick was cancelled (abort/timeout) or the user paused mid-flight. */
  private aborted(controller: AbortController): boolean {
    return controller.signal.aborted || this.deps.getSettings().paused;
  }

  /** Compute whether it is "very late" (after ~1am, before 5am) locally. */
  private isLateNight(): boolean {
    const hour = new Date().getHours();
    return hour >= 1 && hour < 5;
  }

  /**
   * One capture → analyze → react cycle.
   * @param force when true (manual look), always show the reply even if similar.
   */
  private async tick(force: boolean): Promise<void> {
    const settings = this.deps.getSettings();
    // Hard gate: no capture before consent, and none while paused.
    if (!settings.consentGiven || settings.paused) return;
    if (!force && this.deps.isFocusActive()) return;
    if (this.running) return; // never overlap captures
    this.running = true;

    const controller = new AbortController();
    this.currentController = controller;
    const killTimer = setTimeout(() => controller.abort(), TICK_TIMEOUT_MS);

    try {
      const activeApp = await this.deps.getActiveAppName();
      if (isAppBlocked(activeApp, settings.blockedApps)) return;

      this.lastCaptureAt = Date.now();
      let shot: CaptureResult;
      try {
        shot = await this.deps.capture();
      } catch {
        if (this.aborted(controller)) return;
        this.show(fallbackReply('concerned', settings.callName), force);
        return;
      }

      // If the user paused (or we were aborted) during capture, stop now —
      // pause must produce no output whatsoever.
      if (this.aborted(controller)) return;

      // Confirm observation only after a frame exists. The protected companion
      // window is excluded from that frame, avoiding a self-observation loop.
      this.deps.emitCaptureIndicator();

      // Blank frame: almost always a missing Screen Recording permission.
      if (shot.blank || !shot.base64) {
        if (!this.deps.isScreenGranted()) {
          // Only nudge once per resume so we never spam the permission hint.
          if (!this.permissionHintShown || force) {
            this.permissionHintShown = true;
            this.show(
              {
                line: renderLine('My senses are blocked, {name}. Open screen access in settings, question?', {
                  name: settings.callName,
                }),
                mood: 'concerned',
                activity: 'unknown',
                gesture: 'alarm',
                motif: 'concern',
              },
              force,
            );
          }
        }
        // Granted but genuinely black/idle screen → stay calm, do nothing noisy.
        return;
      }
      this.permissionHintShown = false;

      let reply: RockyReply;
      try {
        const lateNight = this.isLateNight();
        const realistic = settings.remarkStyle === 'realistic';
        // Session context is read BEFORE the call so a realistic remark can
        // carry the long-run nudge itself (record() only runs after analyze).
        const session = realistic ? this.deps.peekSession() : null;
        const nudgeworthy = session && session.hours >= SESSION_NUDGE_MIN_HOURS;
        const observation = await this.deps
          .getProvider()
          .analyze(shot.base64, shot.mime, {
            lateNight,
            remarkStyle: settings.remarkStyle,
            recentRemarks: realistic && this.recentRemarks.length ? [...this.recentRemarks] : undefined,
            sessionHours: nudgeworthy ? session.hours : undefined,
            sessionActivity: nudgeworthy ? session.activity : undefined,
            signal: controller.signal,
          });
        // Remember the raw remark ({name} still a placeholder — the call-name
        // never goes to any model) so the next prompt can build continuity.
        if (observation.remark) {
          this.recentRemarks.push(observation.remark);
          if (this.recentRemarks.length > REMARK_HISTORY_LIMIT) this.recentRemarks.shift();
        }
        const outcome = this.deps.recordObservation(observation);
        // Milestones always take the stage. The templated session nudge only
        // does when there is no model-written remark to carry it instead.
        const useSpecial =
          outcome.specialReply && !(outcome.specialKind === 'session' && observation.remark);
        reply = useSpecial
          ? (outcome.specialReply as RockyReply)
          : composeRockyReply(observation, {
              lateNight,
              relationshipStage: outcome.relationshipStage,
              name: settings.callName,
              appName: activeApp,
            });
      } catch (err) {
        // Providers throw short, in-character message templates — render the
        // {name} placeholder and surface them gently.
        const message = err instanceof Error ? err.message : '';
        reply =
          message && message.length <= 160
            ? {
                line: renderLine(message, { name: settings.callName }),
                mood: 'concerned',
                activity: 'unknown',
                gesture: 'alarm',
                motif: 'concern',
              }
            : fallbackReply('concerned', settings.callName);
      }

      // Re-check after the (possibly slow) analysis: if the user paused while it
      // was in flight, suppress the reply entirely.
      if (this.aborted(controller)) return;
      this.show(reply, force);
    } finally {
      clearTimeout(killTimer);
      if (this.currentController === controller) this.currentController = null;
      this.running = false;
    }
  }

  /** Emit a reply unless it is a near-duplicate of the last shown line. */
  private show(reply: RockyReply, force: boolean): void {
    if (!force && this.lastShownLine && linesAreSimilar(reply.line, this.lastShownLine)) {
      return; // de-dupe back-to-back near-identical lines; stay quietly idle
    }
    this.lastShownLine = reply.line;
    this.deps.emitReply(reply);
  }
}
