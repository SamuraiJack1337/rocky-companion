// Screenshot scheduler. Owns the capture cadence and the manual "look now"
// trigger, decides Rocky's reaction, and enforces the behavioral rules:
//   - Pause = no captures at all.
//   - De-duplicate near-identical back-to-back lines.
//   - Late-night (after ~1am) nudges toward rest.
//   - Blank frames (likely missing Screen Recording permission) get a gentle,
//     non-spammy hint instead of a crash.
//   - Any provider/capture failure degrades to a calm in-character line.
//
// The scheduler is deliberately decoupled from Electron: everything it touches
// comes through SchedulerDeps, so it is easy to reason about and test.

import type { RelationshipStage, Settings, RockyReply, ScreenObservation } from '../shared/types';
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
}

/** What recording an observation produced beyond the counter bump. */
export interface ObservationOutcome {
  relationshipStage: RelationshipStage;
  /** A milestone/session-awareness reply that replaces the ordinary line. */
  specialReply: RockyReply | null;
}

/** Hard ceiling for a single analyze pass so a tick can never hang forever. */
const TICK_TIMEOUT_MS = 90_000;

export class Scheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false; // guards against overlapping ticks
  private lastShownLine = '';
  private permissionHintShown = false;
  /** Controller for the capture/analysis currently in flight, if any. */
  private currentController: AbortController | null = null;

  constructor(private readonly deps: SchedulerDeps) {}

  /** Begin the interval timer (no immediate capture; first capture is one interval out). */
  start(): void {
    this.reschedule();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
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
    this.reschedule();
  }

  setIntervalMinutes(_minutes: number): void {
    this.reschedule();
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

  private reschedule(): void {
    this.stop();
    const settings = this.deps.getSettings();
    if (settings.paused || !settings.consentGiven) return;
    const minutes = clampInterval(settings.intervalMinutes);
    this.timer = setInterval(() => {
      void this.tick(false);
    }, minutes * 60_000);
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
        const observation = await this.deps
          .getProvider()
          .analyze(shot.base64, shot.mime, { lateNight, signal: controller.signal });
        const outcome = this.deps.recordObservation(observation);
        reply =
          outcome.specialReply ??
          composeRockyReply(observation, {
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
