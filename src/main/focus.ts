import type { FocusState } from '../shared/types';

const MIN_MINUTES = 1;
const MAX_MINUTES = 180;

export class FocusManager {
  private state: FocusState = { active: false, startedAt: null, endsAt: null, durationMinutes: 0 };
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly onState: (state: FocusState) => void,
    private readonly onComplete: () => void,
  ) {}

  get(): FocusState {
    return { ...this.state };
  }

  isActive(): boolean {
    return this.state.active;
  }

  start(minutes: number): FocusState {
    this.clearTimer();
    const requested = typeof minutes === 'number' && Number.isFinite(minutes) ? minutes : 25;
    const durationMinutes = Math.min(
      MAX_MINUTES,
      Math.max(MIN_MINUTES, Math.round(requested)),
    );
    const started = new Date();
    const ends = new Date(started.getTime() + durationMinutes * 60_000);
    this.state = {
      active: true,
      startedAt: started.toISOString(),
      endsAt: ends.toISOString(),
      durationMinutes,
    };
    this.timer = setTimeout(() => this.complete(), durationMinutes * 60_000);
    this.onState(this.get());
    return this.get();
  }

  cancel(): FocusState {
    this.clearTimer();
    this.state = { active: false, startedAt: null, endsAt: null, durationMinutes: 0 };
    this.onState(this.get());
    return this.get();
  }

  dispose(): void {
    this.cancel();
  }

  private complete(): void {
    this.clearTimer();
    this.state = { active: false, startedAt: null, endsAt: null, durationMinutes: 0 };
    this.onState(this.get());
    this.onComplete();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
