// Creature skin rendering. The built-in creature is drawn procedurally (see the
// Creature class in companion.ts); a SpriteSkin instead renders drop-in art — a
// sprite sheet or per-mood frames — supplied by the user under userData/skins.
// Both implement CreatureRenderer so companion.ts can swap them transparently.
//
// Images arrive already inlined as data URLs from main (the renderer never
// touches the filesystem). A subtle breathing transform keeps even single-still
// skins feeling alive, and a soft glow overlay mirrors the procedural creature's
// "speaking"/capture cues.

import type { LoadedSkin, RockyGesture, SkinManifest } from '../shared/types';

/** Named animation states shared by every creature renderer. */
export type CreatureMode = 'idle' | 'talk' | 'curious' | 'concerned' | 'sleep';

/** The common surface companion.ts drives, whether procedural or sprite-based. */
export interface CreatureRenderer {
  resize(): void;
  setMode(mode: CreatureMode): void;
  setGesture(gesture: RockyGesture): void;
  getMode(): CreatureMode;
  scheduleGlowPulses(onsets: number[]): void;
  flash(amount?: number): void;
  draw(dt: number, nowMs: number): void;
}

const DEFAULT_FPS = 8;

/** Load a data URL into a decoded image, or null on failure. */
function loadImage(dataUrl: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

interface ResolvedState {
  frames: number[]; // indices into `images` (frames mode) or into the sheet grid (sprite)
  fps: number;
  loop: boolean;
}

export class SpriteSkin implements CreatureRenderer {
  private readonly ctx: CanvasRenderingContext2D;
  private mode: CreatureMode = 'idle';
  private gesture: RockyGesture = 'observe';
  private stateName = 'idle';
  private frameIdx = 0;
  private frameClock = 0; // seconds accumulated toward the next frame
  private flashUntil = 0; // ms
  private speakingUntil = 0; // ms — glow while a line is being spoken
  private readonly motionQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null;

  private constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly manifest: SkinManifest,
    /** For 'frames': one image per frame. For 'sprite': a single-element sheet. */
    private readonly images: HTMLImageElement[],
    private readonly sheet: HTMLImageElement | null,
  ) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context unavailable');
    this.ctx = ctx;
    this.resize();
    this.applyState('idle');
  }

  /** Build a SpriteSkin from a loaded skin, decoding its images. Null on failure. */
  static async create(canvas: HTMLCanvasElement, loaded: LoadedSkin): Promise<SpriteSkin | null> {
    const { manifest, assets } = loaded;
    try {
      if (manifest.type === 'sprite') {
        const file = manifest.image ? manifest.image.split('/').pop() ?? '' : '';
        const url = assets[file];
        if (!url || !manifest.frameWidth || !manifest.frameHeight) return null;
        const sheet = await loadImage(url);
        if (!sheet) return null;
        return new SpriteSkin(canvas, manifest, [], sheet);
      }
      // frames mode: decode every referenced file, in a stable order.
      const order: string[] = [];
      for (const spec of Object.values(manifest.states)) {
        for (const f of spec.files ?? []) {
          const base = f.split('/').pop() ?? f;
          if (!order.includes(base)) order.push(base);
        }
      }
      const images: HTMLImageElement[] = [];
      const indexByFile = new Map<string, number>();
      for (const base of order) {
        const url = assets[base];
        if (!url) continue;
        const img = await loadImage(url);
        if (!img) continue;
        indexByFile.set(base, images.length);
        images.push(img);
      }
      if (images.length === 0) return null;
      // Rewrite each state's file list into image indices, stored on the skin.
      const skin = new SpriteSkin(canvas, manifest, images, null);
      skin.framesByState = {};
      for (const [state, spec] of Object.entries(manifest.states)) {
        const idxs = (spec.files ?? [])
          .map((f) => indexByFile.get(f.split('/').pop() ?? f))
          .filter((n): n is number => typeof n === 'number');
        skin.framesByState[state] = {
          frames: idxs.length ? idxs : [0],
          fps: spec.fps ?? manifest.fps ?? DEFAULT_FPS,
          loop: spec.loop !== false,
        };
      }
      skin.applyState('idle');
      return skin;
    } catch {
      return null;
    }
  }

  /** Per-state resolved frame lists (frames mode). Built in create(). */
  private framesByState: Record<string, ResolvedState> = {};

  /** Prefer licensed gesture art, then degrade through legacy mood states. */
  private resolveStateName(mode: CreatureMode, gesture = this.gesture): string {
    if (this.manifest.states[gesture]) return gesture;
    if (this.manifest.states[mode]) return mode;
    if (this.manifest.states.idle) return 'idle';
    const first = Object.keys(this.manifest.states)[0];
    return first ?? 'idle';
  }

  private currentState(): ResolvedState {
    if (this.manifest.type === 'frames') {
      return this.framesByState[this.stateName] ?? { frames: [0], fps: DEFAULT_FPS, loop: true };
    }
    const spec = this.manifest.states[this.stateName];
    return {
      frames: spec?.frames?.length ? spec.frames : [0],
      fps: spec?.fps ?? this.manifest.fps ?? DEFAULT_FPS,
      loop: spec?.loop !== false,
    };
  }

  private applyState(mode: CreatureMode): void {
    const next = this.resolveStateName(mode);
    if (next === this.stateName) return;
    this.stateName = next;
    this.frameIdx = 0;
    this.frameClock = 0;
  }

  // ── CreatureRenderer ────────────────────────────────────────────────────────

  resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth || this.canvas.width || 220;
    const h = this.canvas.clientHeight || this.canvas.height || 220;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  setMode(mode: CreatureMode): void {
    this.mode = mode;
    this.applyState(mode);
  }

  setGesture(gesture: RockyGesture): void {
    this.gesture = gesture;
    this.applyState(this.mode);
  }

  getMode(): CreatureMode {
    return this.mode;
  }

  scheduleGlowPulses(onsets: number[]): void {
    // Keep a soft glow lit for the duration the line is being spoken.
    const last = onsets.length ? onsets[onsets.length - 1] : 0;
    this.speakingUntil = performance.now() + (last + 0.6) * 1000;
  }

  flash(amount = 0.5): void {
    this.flashUntil = performance.now() + 220 + amount * 200;
  }

  draw(dt: number, nowMs: number): void {
    const ctx = this.ctx;
    const w = this.canvas.clientWidth || 220;
    const h = this.canvas.clientHeight || 220;
    ctx.clearRect(0, 0, w, h);

    const state = this.currentState();
    // Advance animation.
    if (!this.motionQuery?.matches) this.frameClock += dt;
    const frameDur = 1 / Math.max(1, state.fps);
    while (this.frameClock >= frameDur) {
      this.frameClock -= frameDur;
      if (this.frameIdx + 1 < state.frames.length) this.frameIdx++;
      else if (state.loop) this.frameIdx = 0;
    }

    // Subtle "alive" breathing so even single stills move.
    const breath = this.motionQuery?.matches ? 1 : 1 + Math.sin(nowMs / 1400) * 0.018;
    const bob = this.motionQuery?.matches ? 0 : Math.sin(nowMs / 1700) * (h * 0.006);

    // Soft glow overlay when speaking / on capture flash.
    const speaking = nowMs < this.speakingUntil || this.mode === 'talk';
    const flashing = nowMs < this.flashUntil;
    const glow = (speaking ? 0.5 : 0.12) + (flashing ? 0.4 : 0);
    if (glow > 0.05) {
      const cx = w / 2;
      const cy = h * 0.56;
      const r = Math.min(w, h) * 0.5;
      const grad = ctx.createRadialGradient(cx, cy, r * 0.1, cx, cy, r);
      grad.addColorStop(0, `rgba(217, 164, 65, ${0.22 * glow})`);
      grad.addColorStop(1, 'rgba(217, 164, 65, 0)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);
    }

    this.drawFrame(state.frames[this.frameIdx] ?? 0, w, h, breath, bob);
  }

  /** Draw one frame, contained within the stage with a little padding. */
  private drawFrame(frame: number, w: number, h: number, scale: number, bob: number): void {
    const ctx = this.ctx;
    const pad = 0.9; // leave a little breathing room around the creature
    let img: HTMLImageElement | null;
    let sx = 0;
    let sy = 0;
    let sw: number;
    let sh: number;

    if (this.manifest.type === 'sprite' && this.sheet) {
      img = this.sheet;
      sw = this.manifest.frameWidth ?? this.sheet.width;
      sh = this.manifest.frameHeight ?? this.sheet.height;
      const cols = this.manifest.columns ?? Math.max(1, Math.floor(this.sheet.width / sw));
      const rows = Math.max(1, Math.floor(this.sheet.height / sh));
      const safeFrame = Number.isInteger(frame) && frame >= 0 && frame < cols * rows ? frame : 0;
      sx = (safeFrame % cols) * sw;
      sy = Math.floor(safeFrame / cols) * sh;
    } else {
      img = this.images[frame] ?? this.images[0] ?? null;
      if (!img) return;
      sw = img.width;
      sh = img.height;
    }
    if (!img) return;

    const fit = Math.min((w * pad) / sw, (h * pad) / sh) * scale;
    const dw = sw * fit;
    const dh = sh * fit;
    const dx = (w - dw) / 2;
    const dy = (h - dh) / 2 + bob;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
  }
}
