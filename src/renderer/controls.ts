// On-Rocky quick controls. A small translucent dot below the creature toggles
// a compact popover with the everyday actions (look now, focus, fist bump,
// mute, settings, lab) so they are reachable without opening the Lab window.
//
// Both elements are -webkit-app-region: no-drag islands inside the draggable
// canvas window (same pattern as the speech bubble), so they receive normal
// DOM clicks while dragging Rocky elsewhere still moves the window.
//
// Runs with contextIsolation on: everything goes through the typed
// `window.rocky` bridge; all these channels already exist for the Lab window.

import type { FocusState, Settings, VoiceCaptureState } from '../shared/types';

const DEFAULT_FOCUS_MINUTES = 25;

export class ControlPopover {
  private readonly toggle: HTMLButtonElement;
  private readonly popover: HTMLDivElement;
  private readonly focusBtn: HTMLButtonElement;
  private readonly muteBtn: HTMLButtonElement;
  private readonly talkBtn: HTMLButtonElement;

  private muted = false;
  private voiceState: VoiceCaptureState = 'idle';
  private focusState: FocusState = {
    active: false,
    startedAt: null,
    endsAt: null,
    durationMinutes: DEFAULT_FOCUS_MINUTES,
  };

  constructor() {
    this.toggle = mustGet<HTMLButtonElement>('control-toggle');
    this.popover = mustGet<HTMLDivElement>('control-popover');
    this.focusBtn = mustGet<HTMLButtonElement>('ctl-focus');
    this.muteBtn = mustGet<HTMLButtonElement>('ctl-mute');
    this.talkBtn = mustGet<HTMLButtonElement>('ctl-talk');

    this.toggle.addEventListener('click', () => this.setOpen(this.popover.hidden));
    window.addEventListener('blur', () => this.setOpen(false));
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.setOpen(false);
    });

    this.wireActions();
    this.subscribe();
    void this.refresh();
  }

  private setOpen(open: boolean): void {
    this.popover.hidden = !open;
    this.toggle.classList.toggle('open', open);
  }

  /** Run an action, then close so Rocky's stage stays uncluttered. */
  private act(action: () => unknown): void {
    try {
      void action();
    } finally {
      this.setOpen(false);
    }
  }

  private wireActions(): void {
    // Voice notes + the notebook, reachable straight from Rocky's stage.
    this.talkBtn.addEventListener('click', () =>
      this.act(() => window.rocky.togglePushToTalk()),
    );
    mustGet<HTMLButtonElement>('ctl-chat').addEventListener('click', () =>
      this.act(() => window.rocky.openChat()),
    );
    mustGet<HTMLButtonElement>('ctl-weekly').addEventListener('click', () =>
      this.act(() => window.rocky.openChat('weekly')),
    );
    mustGet<HTMLButtonElement>('ctl-questions').addEventListener('click', () =>
      this.act(() => window.rocky.openChat('questions')),
    );
    mustGet<HTMLButtonElement>('ctl-look').addEventListener('click', () =>
      this.act(() => window.rocky.lookNow()),
    );
    this.focusBtn.addEventListener('click', () =>
      this.act(() =>
        this.focusState.active
          ? window.rocky.cancelFocus()
          : window.rocky.startFocus(DEFAULT_FOCUS_MINUTES),
      ),
    );
    mustGet<HTMLButtonElement>('ctl-bump').addEventListener('click', () =>
      this.act(() => window.rocky.fistBump()),
    );
    this.muteBtn.addEventListener('click', () =>
      this.act(() => window.rocky.setSettings({ muted: !this.muted })),
    );
    mustGet<HTMLButtonElement>('ctl-settings').addEventListener('click', () =>
      this.act(() => window.rocky.openSettings()),
    );
    mustGet<HTMLButtonElement>('ctl-lab').addEventListener('click', () =>
      this.act(() => window.rocky.openLab()),
    );
  }

  private subscribe(): void {
    window.rocky.onVoiceState((state: VoiceCaptureState) => {
      this.voiceState = state;
      this.paint();
    });
    window.rocky.onFocusState((state: FocusState) => {
      this.focusState = state;
      this.paint();
    });
    window.rocky.onState((state) => {
      this.muted = state.muted;
      this.paint();
    });
    window.rocky.onSettingsUpdated((s: Settings) => {
      this.muted = s.muted;
      this.paint();
    });
  }

  private async refresh(): Promise<void> {
    try {
      const [settings, focus] = await Promise.all([
        window.rocky.getSettings(),
        window.rocky.getFocusState(),
      ]);
      this.muted = settings.muted;
      this.focusState = focus;
    } catch {
      // Defaults stand; the subscriptions will correct them shortly.
    }
    this.paint();
  }

  private paint(): void {
    this.focusBtn.textContent = this.focusState.active
      ? `End focus (${this.focusState.durationMinutes} min)`
      : `Focus ${DEFAULT_FOCUS_MINUTES} min`;
    this.muteBtn.textContent = this.muted ? 'Unmute voice' : 'Mute voice';
    this.talkBtn.textContent =
      this.voiceState === 'recording'
        ? 'Stop & save note'
        : this.voiceState === 'processing'
          ? 'Translating…'
          : 'Talk (voice note)';
    this.talkBtn.disabled = this.voiceState === 'processing';
  }
}

function mustGet<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`controls: missing #${id} in index.html`);
  return node as T;
}

/** Install the quick controls; no-ops outside Electron (browser preview). */
export function installControls(): ControlPopover | null {
  if (typeof window.rocky === 'undefined') return null;
  try {
    return new ControlPopover();
  } catch {
    return null;
  }
}
