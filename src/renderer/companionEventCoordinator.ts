import type { RockyReply } from '../shared/types';

export interface CompanionEventCoordinatorDeps {
  /** Update the bubble, gesture, and visual state immediately. */
  present: (reply: RockyReply) => void;
  /** Stop every currently playing or scheduled voice. */
  cancelAudio: () => void;
  /** Start voice for a reply; the callback becomes false when superseded. */
  speak: (reply: RockyReply, isCurrent: () => boolean) => Promise<void>;
}

/**
 * Coordinates the companion's asynchronous visual/audio event stream.
 *
 * Replies are intentionally latest-wins: a fresh observation, milestone, or
 * research completion should not wait behind stale cloud TTS. Every async
 * continuation receives a generation predicate and must stop quietly when a
 * newer event supersedes it.
 */
export class CompanionEventCoordinator {
  private generation = 0;

  constructor(private readonly deps: CompanionEventCoordinatorDeps) {}

  enqueue(reply: RockyReply): void {
    const generation = ++this.generation;
    this.deps.cancelAudio();
    this.deps.present(reply);
    const isCurrent = () => this.generation === generation;
    void this.deps.speak(reply, isCurrent).catch(() => undefined);
  }

  cancel(): void {
    this.generation += 1;
    this.deps.cancelAudio();
  }
}
