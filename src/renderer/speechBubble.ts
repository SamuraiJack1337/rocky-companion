// Speech-bubble UI controller. Renderer-only: talks to the DOM and to
// window.rocky (typed by RockyAPI) — never Node, ipcRenderer, or electron.
//
// The bubble's visual transition lives entirely in styles.css, keyed off the
// 'visible' class. This module only toggles that class, manages text, and
// owns the auto-dismiss timer. Clicking the bubble dismisses it early and
// notifies main via window.rocky.dismissBubble().

/** Auto-dismiss delay scales with line length, clamped to a readable window. */
function readableDelay(line: string): number {
  const raw = 1200 + 55 * line.length;
  return Math.min(9000, Math.max(2500, raw));
}

/** A bubble stays up much longer when it is asking for a decision. */
const ACTIONABLE_DELAY_MS = 30_000;

export interface BubbleAction {
  label: string;
  onClick: () => void;
}

export class SpeechBubble {
  private readonly root: HTMLElement | null;
  private readonly textNode: HTMLElement | null;
  private readonly activityNode: HTMLElement | null;
  private readonly actionsNode: HTMLElement | null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dismissCb: (() => void) | null = null;

  /**
   * @param rootSelector selector for the bubble container (default
   *   '#speech-bubble'). The text element is always '#bubble-text'.
   */
  constructor(rootSelector = '#speech-bubble') {
    this.root = document.querySelector<HTMLElement>(rootSelector);
    this.textNode = document.querySelector<HTMLElement>('#bubble-text');
    this.activityNode = document.querySelector<HTMLElement>('#translator-activity');
    this.actionsNode = document.querySelector<HTMLElement>('#bubble-actions');

    // Click anywhere on the bubble dismisses early. We bind once in the
    // constructor; the handler is a no-op while the bubble is hidden because
    // hide() clears the timer and the class.
    this.root?.addEventListener('click', this.handleClick);
  }

  /**
   * Show a line: set the text, reveal the bubble, and schedule auto-dismiss
   * after a readable delay. Re-showing cancels any pending dismiss timer.
   * Optional actions render as buttons and stretch the delay so the user can
   * actually decide; clicking any action dismisses the bubble. `delayMs`
   * overrides the auto-dismiss delay entirely (e.g. a bubble that must stay
   * up for a whole voice-note recording).
   */
  show(line: string, activity = 'signal', actions?: BubbleAction[], delayMs?: number): void {
    if (!this.root) return;

    if (this.textNode) {
      this.textNode.textContent = line;
    }
    if (this.activityNode) {
      this.activityNode.textContent = activity.toUpperCase();
    }
    this.setActions(actions ?? []);

    this.clearTimer();
    this.root.classList.add('visible');

    this.timer = setTimeout(() => {
      this.timer = null;
      // Auto-dismiss: hide and notify listeners (no early-click backend call).
      this.hide();
      this.dismissCb?.();
    }, delayMs ?? (actions?.length ? ACTIONABLE_DELAY_MS : readableDelay(line)));
  }

  /** Hide the bubble and clear any pending auto-dismiss timer. */
  hide(): void {
    this.clearTimer();
    this.setActions([]);
    this.root?.classList.remove('visible');
  }

  /** (Re)build the action-button row; hidden when there are none. */
  private setActions(actions: BubbleAction[]): void {
    if (!this.actionsNode) return;
    this.actionsNode.textContent = '';
    this.actionsNode.hidden = actions.length === 0;
    for (const action of actions) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = action.label;
      btn.addEventListener('click', (e) => {
        // Don't let the bubble's own click-to-dismiss swallow the choice.
        e.stopPropagation();
        this.hide();
        this.dismissCb?.();
        action.onClick();
      });
      this.actionsNode.appendChild(btn);
    }
  }

  /**
   * Register a callback fired on dismissal — whether the user clicks to
   * dismiss early or the auto-dismiss timer elapses. Replaces any prior cb.
   */
  onDismiss(cb: () => void): void {
    this.dismissCb = cb;
  }

  /** Early dismiss via click: hide, tell main, then notify listeners. */
  private handleClick = (): void => {
    // Ignore stray clicks when the bubble isn't actually showing.
    if (!this.root?.classList.contains('visible')) return;

    this.hide();
    window.rocky.dismissBubble();
    this.dismissCb?.();
  };

  /** Cancel a pending auto-dismiss timer, if any. */
  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
