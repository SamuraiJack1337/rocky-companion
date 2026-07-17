// Companion renderer — the canvas creature and its animation state machine.
//
// Runs in the browser context (contextIsolation on, no Node). It talks to the
// main process ONLY through the typed `window.rocky` bridge (RockyAPI), and to
// its two sibling modules through their pinned signatures.
//
// What this file owns:
//   - Sizing the #rocky-canvas to the window, devicePixelRatio-aware.
//   - Drawing an ORIGINAL "rock-spider" procedurally (no image assets): a
//     rounded pentagonal carapace in warm stone tones, five tapering legs, and
//     a soft glowing seam that brightens when speaking. There is no face — all
//     emotion is conveyed through posture, leg motion, and glow.
//   - A small state machine (idle / talk / curious / concerned / sleep) whose
//     parameters are TWEENED, never snapped, so transitions read as smooth.
//   - Wiring the four push events from main (reply / capture / state / settings)
//     to the creature, translator, and Eridian voice.
//
// Privacy note: nothing here ever touches screenshots, keys, or on-screen text.
// It only renders Rocky and reacts to locally-authored RockyReply lines.

import type { Mood, RockyGesture, RockyReply, RockyState, Settings } from '../shared/types';
import { PROCEDURAL_SKIN } from '../shared/types';
import { ToneVoice } from './toneVoice';
import { SpokenVoice } from './spokenVoice';
import { SystemVoice } from './systemVoice';
import { SpeechBubble } from './speechBubble';
import type { BubbleAction } from './speechBubble';
import { SpriteSkin } from './skins';
import type { CreatureMode, CreatureRenderer } from './skins';
import { installControls } from './controls';
import { VoiceRecorder } from './recorder';

// ── Constants ───────────────────────────────────────────────────────────────

/** Logical (CSS-pixel) size of the creature stage. The window is fixed to this. */
const STAGE = 165;

// CreatureMode and the CreatureRenderer interface are defined in ./skins so the
// procedural Creature and a drop-in SpriteSkin share one surface.

/**
 * The full pose Rocky can be in. Every field is a plain number/colour so two
 * poses can be linearly blended (tweened). The renderer never reads a "mode"
 * directly — it reads this interpolated pose, which is what keeps transitions
 * smooth and lets a sprite-sheet creature be swapped in behind the same shape.
 */
interface Pose {
  /** Overall vertical settle: 0 = standing tall, 1 = hunkered low (sleep). */
  settle: number;
  /** How far the legs splay outward (1 = neutral, <1 tucked in, >1 reaching). */
  legSpread: number;
  /** Amplitude of the idle/gesture leg sway, in radians. */
  legSway: number;
  /** Forward lean / tilt toward the screen, in radians (curious leans in). */
  tilt: number;
  /** Baseline seam-glow brightness, 0..1. */
  glow: number;
  /** Warmth of the glow: 0 = cool slate-blue, 1 = warm amber. */
  warmth: number;
  /** Breathing pulse amplitude (scale delta). Slows + shrinks toward sleep. */
  breathAmp: number;
  /** Breathing speed multiplier (1 = base, <1 = drowsy). */
  breathSpeed: number;
}

interface GestureBody {
  x: number;
  y: number;
  rotate: number;
  scale: number;
  spread: number;
}

interface GestureLimb {
  angle: number;
  reach: number;
  lift: number;
  bend: number;
  curl: number;
  tipScale: number;
}

const STILL_BODY: GestureBody = { x: 0, y: 0, rotate: 0, scale: 1, spread: 1 };
const STILL_LIMB: GestureLimb = {
  angle: 0, reach: 1, lift: 0, bend: 0, curl: 0, tipScale: 1,
};

/** Whole-shell direction and weight for every named performance. */
function gestureBody(gesture: RockyGesture, t: number, animate: boolean): GestureBody {
  const wave = (speed: number, amount: number, phase = 0): number =>
    animate ? Math.sin(t * speed + phase) * amount : 0;
  switch (gesture) {
    case 'observe':
      return { x: wave(0.65, 2), y: 0, rotate: wave(0.55, 0.035), scale: 1, spread: 1 };
    case 'listen':
      return { x: 0, y: -3, rotate: -0.08 + wave(0.8, 0.018), scale: 1.02, spread: 1.04 };
    case 'calculate':
      return { x: -2, y: 1, rotate: -0.11 + wave(1.4, 0.025), scale: 0.99, spread: 0.94 };
    case 'build':
      return { x: wave(2.1, 2), y: 2, rotate: wave(2.1, 0.035), scale: 1.01, spread: 1.02 };
    case 'delight':
      return { x: 0, y: animate ? -Math.abs(Math.sin(t * 5.5)) * 8 : -5, rotate: wave(4.2, 0.045), scale: 1.06, spread: 1.18 };
    case 'alarm':
      return { x: wave(11, 2.2), y: 7, rotate: wave(12.5, 0.035), scale: 0.93, spread: 1.2 };
    case 'protect':
      return { x: 0, y: 8, rotate: -0.035, scale: 0.96, spread: 0.72 };
    case 'rest':
      return { x: 0, y: 11, rotate: 0.025, scale: 0.94, spread: 0.82 };
    case 'greet':
      return { x: 3, y: -1, rotate: 0.1, scale: 1.01, spread: 1.02 };
    case 'fistBump':
      return { x: 0, y: -2, rotate: 0, scale: 1.06, spread: 0.9 };
    case 'watch':
      return { x: 5, y: 2, rotate: 0.14 + wave(0.7, 0.015), scale: 0.99, spread: 0.98 };
    case 'farewell':
      return { x: -3, y: 1, rotate: -0.11, scale: 0.99, spread: 1.01 };
    default:
      return STILL_BODY;
  }
}

/** Individual five-limb choreography. Motion augments, but never defines, pose. */
function gestureLimb(
  gesture: RockyGesture,
  index: number,
  t: number,
  animate: boolean,
): GestureLimb {
  const out = { ...STILL_LIMB };
  const wave = (speed: number, amount: number, phase = index * 1.1): number =>
    animate ? Math.sin(t * speed + phase) * amount : 0;
  const side = index < 2 ? -1 : index > 2 ? 1 : 0;

  switch (gesture) {
    case 'observe':
      out.reach = index === 2 ? 0.92 : 1;
      out.angle = side * 0.035 + wave(0.8, 0.018);
      break;
    case 'listen':
      // Two raised receivers, three planted supports.
      if (index === 1 || index === 3) {
        out.reach = 0.78;
        out.lift = 0.34;
        out.angle = -side * 0.16;
        out.bend = -side * 0.18;
      } else out.reach = 1.05;
      break;
    case 'calculate':
      // One limb folds inward while the opposite taps a repeating count.
      if (index === 0) {
        out.reach = 0.62; out.lift = 0.42; out.angle = 0.38; out.bend = 0.32; out.curl = 0.55;
      } else if (index === 4) {
        out.reach = 0.9; out.lift = 0.1 + Math.max(0, wave(7, 0.1, 0)); out.angle = wave(7, 0.1, 0);
      } else out.angle = wave(2.2, 0.035);
      break;
    case 'build': {
      const toolHand = index === 1 || index === 3;
      if (toolHand) {
        const alternate = index === 1 ? 0 : Math.PI;
        out.reach = 1.18 + wave(3.7, 0.08, alternate);
        out.lift = 0.18 + wave(3.7, 0.08, alternate);
        out.angle = -side * 0.1 + wave(3.7, 0.08, alternate);
        out.curl = 0.28;
      } else out.reach = 0.95;
      break;
    }
    case 'delight':
      out.angle = side * 0.13 + wave(5.5, 0.04);
      out.reach = 1.14;
      out.lift = index === 2 ? 0.18 : 0.08;
      break;
    case 'alarm':
      out.angle = side * 0.17 + wave(10.5, 0.045);
      out.reach = 1.2;
      out.lift = 0.08;
      out.bend = side * 0.1;
      break;
    case 'protect':
      out.angle = -side * 0.24;
      out.reach = index === 2 ? 0.68 : 0.76;
      out.lift = index === 1 || index === 3 ? 0.25 : 0.08;
      out.bend = -side * 0.28;
      out.curl = 0.72;
      break;
    case 'rest':
      out.angle = -side * 0.1;
      out.reach = index === 2 ? 0.64 : 0.74;
      out.lift = -0.03;
      out.curl = 0.45;
      break;
    case 'greet':
      if (index === 4) {
        out.angle = -0.52 + wave(3.1, 0.16, 0);
        out.reach = 1.02;
        out.lift = 0.76;
        out.bend = -0.22;
        out.curl = 0.18;
      } else out.reach = 0.9;
      break;
    case 'fistBump':
      if (index === 2) {
        out.reach = 1.28;
        out.lift = 0.12;
        out.curl = 0.94;
        out.tipScale = 1.5;
      } else {
        out.reach = 0.76; out.angle = -side * 0.12; out.curl = 0.42;
      }
      break;
    case 'watch':
      if (index === 3) {
        out.reach = 1.2;
        out.lift = 0.36;
        out.angle = -0.22;
        out.bend = -0.14;
      } else if (index === 4) out.reach = 1.08;
      else out.reach = 0.88;
      break;
    case 'farewell':
      if (index === 0) {
        out.angle = 0.5 + wave(2.25, 0.2, 0);
        out.reach = 1.05;
        out.lift = 0.72;
        out.bend = 0.24;
        out.curl = 0.26;
      } else {
        out.reach = 0.84;
        out.angle = -side * 0.06;
      }
      break;
  }
  return out;
}

/** Per-mode target poses. The live pose tweens toward whichever is active. */
const POSES: Record<CreatureMode, Pose> = {
  // Calm resting: gentle breath, slow sway, dim cool seam with rare pulses.
  idle: {
    settle: 0.18,
    legSpread: 1.0,
    legSway: 0.06,
    tilt: 0,
    glow: 0.22,
    warmth: 0.35,
    breathAmp: 0.05,
    breathSpeed: 1.0,
  },
  // Talking: legs gesture wider, seam pumps bright. Glow is driven on top of
  // this baseline by note onsets from the tone-voice.
  talk: {
    settle: 0.1,
    legSpread: 1.12,
    legSway: 0.16,
    tilt: 0.05,
    glow: 0.5,
    warmth: 0.6,
    breathAmp: 0.04,
    breathSpeed: 1.4,
  },
  // Curious: leans toward the screen, holds a steady brighter glow.
  curious: {
    settle: 0.05,
    legSpread: 1.06,
    legSway: 0.04,
    tilt: 0.16,
    glow: 0.42,
    warmth: 0.45,
    breathAmp: 0.045,
    breathSpeed: 1.15,
  },
  // Concerned: legs tuck in protectively, glow dims and warms.
  concerned: {
    settle: 0.32,
    legSpread: 0.82,
    legSway: 0.03,
    tilt: -0.04,
    glow: 0.18,
    warmth: 0.85,
    breathAmp: 0.035,
    breathSpeed: 0.85,
  },
  // Sleep: settles very low, breathes slowly, seam barely embers.
  sleep: {
    settle: 0.6,
    legSpread: 0.9,
    legSway: 0.015,
    tilt: -0.02,
    glow: 0.1,
    warmth: 0.7,
    breathAmp: 0.025,
    breathSpeed: 0.5,
  },
};

/** Map an LLM mood to the resting mode Rocky settles into after talking. */
function moodToRestingMode(mood: Mood): CreatureMode {
  switch (mood) {
    case 'curious':
      return 'curious';
    case 'concerned':
      return 'concerned';
    case 'sleepy':
      return 'sleep'; // sleepy mood lingers in a low, drowsy pose
    case 'excited':
    case 'calm':
    default:
      return 'idle';
  }
}

/**
 * Evenly-spaced glow-pulse onset times (seconds) spanning a spoken line, so the
 * seam visibly "speaks" for the duration of the TTS audio.
 */
function glowPulsesForDuration(duration: number): number[] {
  if (!(duration > 0)) return [0];
  const pulses: number[] = [];
  for (let t = 0; t < duration; t += 0.28) pulses.push(t);
  return pulses;
}

/** Palette — warm stone with amber accents. Defined once for easy retheming. */
const COLOR = {
  carapaceDark: '#25231f',
  carapaceMid: '#403d36',
  carapaceLight: '#68635a',
  legDark: '#24221e',
  legLight: '#575249',
  amber: '#c58a45',
  amberHot: '#edbd79',
  seamCool: '#829c9d',
} as const;

// ── Small math helpers ────────────────────────────────────────────────────

const TAU = Math.PI * 2;
const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Frame-rate independent exponential approach toward a target. */
function approach(current: number, target: number, dt: number, speed: number): number {
  // 1 - e^(-k*dt) gives a smooth, stable tween regardless of frame timing.
  const k = 1 - Math.exp(-speed * dt);
  return current + (target - current) * k;
}

/** Tween every field of a pose toward the target pose. */
function approachPose(cur: Pose, target: Pose, dt: number, speed: number): void {
  cur.settle = approach(cur.settle, target.settle, dt, speed);
  cur.legSpread = approach(cur.legSpread, target.legSpread, dt, speed);
  cur.legSway = approach(cur.legSway, target.legSway, dt, speed);
  cur.tilt = approach(cur.tilt, target.tilt, dt, speed);
  cur.glow = approach(cur.glow, target.glow, dt, speed);
  cur.warmth = approach(cur.warmth, target.warmth, dt, speed);
  cur.breathAmp = approach(cur.breathAmp, target.breathAmp, dt, speed);
  cur.breathSpeed = approach(cur.breathSpeed, target.breathSpeed, dt, speed);
}

/** Blend two hex colours (#rrggbb) by t. Used to warm/cool the seam glow. */
function mixHex(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ar = (pa >> 16) & 255,
    ag = (pa >> 8) & 255,
    ab = pa & 255;
  const br = (pb >> 16) & 255,
    bg = (pb >> 8) & 255,
    bb = pb & 255;
  const r = Math.round(lerp(ar, br, t));
  const g = Math.round(lerp(ag, bg, t));
  const bl = Math.round(lerp(ab, bb, t));
  // Return hex (not rgb()) so a mixed colour can be safely fed back into
  // mixHex() again — the seam core and foot embers re-mix this output, and an
  // rgb() string would fail to parse and collapse to black.
  return '#' + [r, g, bl].map((v) => v.toString(16).padStart(2, '0')).join('');
}

// ── The creature renderer ───────────────────────────────────────────────────

/**
 * Holds the canvas, the live (tweened) pose, the active mode, and the transient
 * glow/flash energy. Exposes a single draw(state, t) entry so the whole visual
 * could later be replaced by a sprite-sheet without touching the state machine.
 */
class Creature implements CreatureRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private dpr = 1;

  /** The live, interpolated pose. Starts at idle. */
  private readonly pose: Pose = { ...POSES.idle };
  /** The mode we are tweening toward. */
  private mode: CreatureMode = 'idle';
  private gesture: RockyGesture = 'observe';
  private gestureStartedAt = performance.now();
  private readonly motionQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null;

  /** Extra glow energy added by tone-note onsets or capture flashes, 0..~1.5. */
  private glowPulse = 0;
  /** Scheduled pulse trigger times (performance.now ms) from a tone playback. */
  private pulseSchedule: number[] = [];

  /** Rare spontaneous idle glow blink bookkeeping. */
  private nextIdleBlink = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context unavailable');
    this.ctx = ctx;
    this.resize();
  }

  /** Resize the backing store to the window size, accounting for DPR. */
  resize(): void {
    this.dpr = Math.max(1, window.devicePixelRatio || 1);
    // Logical size is fixed to the stage; the CSS already constrains the window,
    // but we read the actual client box so an OS zoom still looks crisp.
    const cssW = this.canvas.clientWidth || STAGE;
    const cssH = this.canvas.clientHeight || STAGE;
    this.canvas.width = Math.round(cssW * this.dpr);
    this.canvas.height = Math.round(cssH * this.dpr);
  }

  /** Switch the target mode; the pose tweens toward it (never snaps). */
  setMode(mode: CreatureMode): void {
    this.mode = mode;
  }

  setGesture(gesture: RockyGesture): void {
    if (gesture === this.gesture) return;
    this.gesture = gesture;
    this.gestureStartedAt = performance.now();
  }

  getMode(): CreatureMode {
    return this.mode;
  }

  /**
   * Register note onset times (seconds, relative to "now") from ToneVoice.play
   * so the seam-glow can pulse in time with the spoken music.
   */
  scheduleGlowPulses(onsetsSec: number[]): void {
    const now = performance.now();
    this.pulseSchedule = onsetsSec.map((s) => now + s * 1000);
  }

  /** Add an immediate glow flash (e.g. the capture indicator). */
  flash(amount = 0.6): void {
    this.glowPulse = Math.min(1.5, this.glowPulse + amount);
  }

  /**
   * Advance time-based energy (pulses decay, scheduled pulses fire, idle blink).
   * Kept separate from draw() so the math is testable and the draw stays pure.
   */
  private update(dt: number, nowMs: number): void {
    // Tween the live pose toward the active mode. Talk snaps a touch faster so
    // gestures feel responsive; sleep eases slowly so settling reads as heavy.
    const speed = this.mode === 'talk' ? 9 : this.mode === 'sleep' ? 2.5 : 5;
    approachPose(this.pose, POSES[this.mode], dt, speed);

    // Fire any scheduled tone pulses whose time has arrived.
    if (this.pulseSchedule.length) {
      const remaining: number[] = [];
      for (const t of this.pulseSchedule) {
        if (nowMs >= t) this.glowPulse = Math.min(1.5, this.glowPulse + 0.5);
        else remaining.push(t);
      }
      this.pulseSchedule = remaining;
    }

    // Rare spontaneous glow blink while idle, so a resting Rocky still breathes
    // light occasionally. Disabled while sleeping (kept dim and steady).
    if (this.mode === 'idle' && !this.motionQuery?.matches) {
      if (nowMs >= this.nextIdleBlink) {
        this.glowPulse = Math.min(1.5, this.glowPulse + 0.3);
        this.nextIdleBlink = nowMs + 4000 + Math.random() * 6000;
      }
    } else {
      // Re-arm so the first idle blink after returning isn't immediate.
      this.nextIdleBlink = nowMs + 3000 + Math.random() * 4000;
    }

    // Decay transient glow energy back to zero.
    this.glowPulse = approach(this.glowPulse, 0, dt, 4);
  }

  /**
   * SINGLE draw entry point. Given the elapsed time, advance state and paint a
   * frame. A future sprite-sheet creature would replace only the body of this
   * method while keeping the same signature and the same `pose` inputs.
   */
  draw(dt: number, nowMs: number): void {
    this.update(dt, nowMs);

    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    ctx.clearRect(0, 0, W, H);

    // Work in logical units, scaled by DPR, centred on the stage.
    ctx.save();
    ctx.scale(this.dpr, this.dpr);
    const cssW = W / this.dpr;
    const cssH = H / this.dpr;
    const cx = cssW / 2;
    // Anchor the body a little below centre and let `settle` sink it further.
    const baseY = cssH * 0.52;
    const tSec = nowMs / 1000;
    const gestureSec = Math.max(0, (nowMs - this.gestureStartedAt) / 1000);
    const animate = !this.motionQuery?.matches;
    const performancePose = gestureBody(this.gesture, gestureSec, animate);
    const cy = baseY + this.pose.settle * cssH * 0.06 + performancePose.y;

    // Breathing pulse — a slow scale oscillation in [1-amp, 1+amp].
    const breath = animate
      ? 1 + Math.sin(tSec * 1.6 * this.pose.breathSpeed) * this.pose.breathAmp
      : 1;

    // Broad, weighty silhouette: Rocky should read as a compact stone organism,
    // not a thin spider or a humanoid mascot.
    const R = cssW * 0.29 * breath * performancePose.scale;

    // Effective glow = baseline pose glow plus any transient pulse energy.
    const glow = clamp01(this.pose.glow + this.glowPulse);
    const seamColor = mixHex(COLOR.seamCool, COLOR.amber, this.pose.warmth);

    ctx.save();
    ctx.translate(cx + performancePose.x, cy);
    // A gentle forward tilt toward the screen (top of window) for curiosity.
    ctx.rotate(this.pose.tilt + performancePose.rotate);

    this.drawLegs(ctx, R, tSec, gestureSec, animate, performancePose.spread, glow, seamColor);
    this.drawShadow(ctx, R);
    this.drawCarapace(ctx, R);
    this.drawSeam(ctx, R, glow, seamColor);

    ctx.restore();
    ctx.restore();
  }

  // ── Body parts ────────────────────────────────────────────────────────────

  /** Soft contact shadow grounding the creature, fades as it settles/sleeps. */
  private drawShadow(ctx: CanvasRenderingContext2D, R: number): void {
    ctx.save();
    const sy = R * 0.95;
    const grad = ctx.createRadialGradient(0, sy, 1, 0, sy, R * 1.1);
    grad.addColorStop(0, 'rgba(0,0,0,0.28)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.ellipse(0, sy, R * 1.05, R * 0.32, 0, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  /**
   * Five tapering legs radiating from beneath the carapace. Each leg is a
   * two-segment limb whose tip sways. Spread and sway come from the pose, and a
   * per-leg phase offset keeps the motion from looking mechanical.
   */
  private drawLegs(
    ctx: CanvasRenderingContext2D,
    R: number,
    tSec: number,
    gestureSec: number,
    animate: boolean,
    gestureSpread: number,
    glow: number,
    seamColor: string,
  ): void {
    const legCount = 5;
    // Legs fan across the lower hemisphere so the pentagon top stays clean.
    // Angles measured from straight-down, symmetric left/right.
    const baseAngles = [-1.15, -0.58, 0, 0.58, 1.15];

    for (let i = 0; i < legCount; i++) {
      const phase = i * 1.3;
      const choreography = gestureLimb(this.gesture, i, gestureSec, animate);
      const sway = animate
        ? Math.sin(tSec * 2.2 * this.pose.breathSpeed + phase) * this.pose.legSway
        : 0;
      const angle =
        baseAngles[i] * this.pose.legSpread * gestureSpread + sway + choreography.angle;

      // Anchor point on the carapace underside.
      const ax = Math.sin(angle) * R * 0.55;
      const ay = R * 0.35 + Math.cos(angle) * R * 0.25;

      // Knee and foot positions: legs reach down-and-out, lifting slightly with
      // the sway so gestures read as articulated rather than rigid pivots.
      const reach = R * (0.82 + 0.13 * this.pose.legSpread) * choreography.reach;
      const kneeAngle = angle + choreography.bend;
      const kneeX = ax + Math.sin(kneeAngle) * reach * 0.55;
      const kneeY = ay + Math.cos(kneeAngle) * reach * 0.45 - R * 0.05;
      const lift =
        (animate ? Math.sin(tSec * 2.6 + phase) * this.pose.legSway * R * 0.6 : 0) +
        choreography.lift * R;
      const footX = kneeX + Math.sin(angle) * reach * 0.6;
      const footY = kneeY + Math.cos(angle) * reach * 0.6 - lift;

      // Two-segment stroke, tapering from thigh to tip.
      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = COLOR.legDark;
      ctx.lineWidth = R * 0.22;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.quadraticCurveTo(kneeX, kneeY, footX, footY);
      ctx.stroke();

      // Thinner light edge on top for a chitinous highlight.
      ctx.strokeStyle = COLOR.legLight;
      ctx.globalAlpha = 0.7;
      ctx.lineWidth = R * 0.075;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.quadraticCurveTo(kneeX, kneeY, footX, footY);
      ctx.stroke();

      // Three short digits at every limb tip: all five appendages are equally
      // capable hands, a key piece of the non-humanoid silhouette.
      ctx.globalAlpha = 1;
      ctx.strokeStyle = COLOR.legDark;
      ctx.lineWidth = R * 0.075;
      const digitLength = R * 0.24 * (1 - choreography.curl * 0.55) * choreography.tipScale;
      for (const digit of [-0.18, 0, 0.18]) {
        const da = angle + digit * (1 - choreography.curl * 0.7);
        ctx.beginPath();
        ctx.moveTo(footX, footY);
        ctx.quadraticCurveTo(
          footX + Math.sin(da + digit * choreography.curl) * digitLength * 0.65,
          footY + Math.cos(da + digit * choreography.curl) * digitLength * 0.65,
          footX + Math.sin(da) * digitLength,
          footY + Math.cos(da) * digitLength,
        );
        ctx.stroke();
      }
      // A compact closed hand makes the forward fist-bump readable in silhouette.
      if (choreography.curl > 0.85) {
        ctx.fillStyle = COLOR.legDark;
        ctx.beginPath();
        ctx.arc(footX, footY, R * 0.12 * choreography.tipScale, 0, TAU);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  /**
   * The rounded pentagonal carapace — five rounded corners, top-lit so it reads
   * as a stone shell. Built once per frame from a parametric pentagon with
   * corner rounding applied via quadratic curves.
   */
  private drawCarapace(ctx: CanvasRenderingContext2D, R: number): void {
    const pts = this.pentagonPoints(R);

    ctx.save();
    // Body fill: a vertical gradient gives a lit-from-above stone look.
    const grad = ctx.createLinearGradient(0, -R, 0, R);
    grad.addColorStop(0, COLOR.carapaceLight);
    grad.addColorStop(0.55, COLOR.carapaceMid);
    grad.addColorStop(1, COLOR.carapaceDark);

    this.tracePentagon(ctx, pts, R * 0.28);
    ctx.fillStyle = grad;
    ctx.fill();

    // Subtle rim to crisp the silhouette against any wallpaper.
    ctx.lineWidth = Math.max(1, R * 0.02);
    ctx.strokeStyle = 'rgba(20,24,30,0.55)';
    ctx.stroke();

    // Deterministic facets and mineral pores give the shell tactile scale
    // without introducing eyes, a mouth, or any face-like arrangement.
    ctx.globalAlpha = 0.22;
    ctx.strokeStyle = '#aaa397';
    ctx.lineWidth = Math.max(0.7, R * 0.012);
    const facets = [
      [-0.62, -0.12, -0.18, -0.58],
      [-0.18, -0.58, 0.34, -0.38],
      [0.34, -0.38, 0.58, 0.08],
      [-0.55, 0.18, -0.06, 0.48],
      [-0.06, 0.48, 0.48, 0.28],
    ];
    for (const [x1, y1, x2, y2] of facets) {
      ctx.beginPath();
      ctx.moveTo(x1 * R, y1 * R);
      ctx.lineTo(x2 * R, y2 * R);
      ctx.stroke();
    }
    ctx.fillStyle = '#171612';
    for (const [x, y, size] of [[-0.34, -0.23, 0.04], [0.22, -0.12, 0.03], [0.18, 0.34, 0.045], [-0.18, 0.18, 0.025]]) {
      ctx.beginPath();
      ctx.arc(x * R, y * R, size * R, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  /** Compute the five pentagon vertices, point-up, scaled to R. */
  private pentagonPoints(R: number): Array<{ x: number; y: number }> {
    const pts: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < 5; i++) {
      // Start at top (-90°) and go clockwise.
      const a = -Math.PI / 2 + (i * TAU) / 5;
      pts.push({ x: Math.cos(a) * R, y: Math.sin(a) * R });
    }
    return pts;
  }

  /** Trace a pentagon path with rounded corners of the given radius. */
  private tracePentagon(
    ctx: CanvasRenderingContext2D,
    pts: Array<{ x: number; y: number }>,
    round: number,
  ): void {
    ctx.beginPath();
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const prev = pts[(i - 1 + n) % n];
      const cur = pts[i];
      const next = pts[(i + 1) % n];

      // Points `round` distance back along each edge from the corner.
      const v1 = norm(prev.x - cur.x, prev.y - cur.y);
      const v2 = norm(next.x - cur.x, next.y - cur.y);
      const start = { x: cur.x + v1.x * round, y: cur.y + v1.y * round };
      const end = { x: cur.x + v2.x * round, y: cur.y + v2.y * round };

      if (i === 0) ctx.moveTo(start.x, start.y);
      else ctx.lineTo(start.x, start.y);
      ctx.quadraticCurveTo(cur.x, cur.y, end.x, end.y);
    }
    ctx.closePath();
  }

  /**
   * The signature glowing seam — a soft luminous crack running across the shell.
   * Its brightness is the whole emotional tell: bright + cool when calm/curious,
   * dim + warm when concerned, pulsing in time with the voice when talking.
   */
  private drawSeam(
    ctx: CanvasRenderingContext2D,
    R: number,
    glow: number,
    seamColor: string,
  ): void {
    ctx.save();

    // Clip to the carapace so the glow never spills past the shell edge.
    this.tracePentagon(ctx, this.pentagonPoints(R), R * 0.28);
    ctx.clip();

    // Seam path: a gentle diagonal crack with two small forks.
    const seam = new Path2D();
    seam.moveTo(-R * 0.5, -R * 0.35);
    seam.quadraticCurveTo(-R * 0.05, -R * 0.1, R * 0.12, R * 0.2);
    seam.quadraticCurveTo(R * 0.25, R * 0.4, R * 0.45, R * 0.5);
    // small fork
    seam.moveTo(-R * 0.05, -R * 0.1);
    seam.lineTo(-R * 0.35, R * 0.25);

    // Outer bloom: a wide, faint halo of the seam colour.
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = seamColor;
    ctx.lineCap = 'round';

    ctx.globalAlpha = 0.18 * glow;
    ctx.lineWidth = R * 0.5;
    ctx.stroke(seam);

    ctx.globalAlpha = 0.4 * glow;
    ctx.lineWidth = R * 0.18;
    ctx.stroke(seam);

    // Bright core line — a hot highlight when glow is high.
    ctx.strokeStyle = mixHex(seamColor, COLOR.amberHot, clamp01(glow));
    ctx.globalAlpha = clamp01(0.5 + glow * 0.5);
    ctx.lineWidth = R * 0.05;
    ctx.stroke(seam);

    ctx.restore();
  }
}

/** Normalise a 2D vector; returns {0,0} for a zero vector. */
function norm(x: number, y: number): { x: number; y: number } {
  const len = Math.hypot(x, y) || 1;
  return { x: x / len, y: y / len };
}

// ── App wiring ───────────────────────────────────────────────────────────────

/**
 * Top-level controller: owns the creature, the bubble, the tone-voice, the
 * render loop, and the subscriptions to window.rocky. Keeps the live runtime
 * flags (muted/paused) that came from settings and the STATE event.
 */
class Companion {
  private readonly canvas: HTMLCanvasElement;
  /** The built-in procedural creature; also the fallback for any skin failure. */
  private readonly creature: Creature;
  /** The currently-active renderer (procedural Creature or a drop-in SpriteSkin). */
  private active: CreatureRenderer;
  /** Name of the skin currently applied, to avoid redundant reloads. */
  private currentSkinName = PROCEDURAL_SKIN;
  private readonly bubble: SpeechBubble;
  private readonly tone = new ToneVoice();
  private readonly spoken = new SpokenVoice();
  private readonly system = new SystemVoice();
  /** Push-to-talk microphone capture (started/stopped by main via EV.PTT). */
  private readonly recorder = new VoiceRecorder();

  private muted = false;
  private paused = false;

  /** Voice settings mirrored from Settings. */
  private voiceMode: Settings['voiceMode'] = 'procedural';
  private voicePitch = 0;
  private musicUnderlay = true;

  /** The mood Rocky should rest in after the current bubble dismisses. */
  private pendingRestMode: CreatureMode = 'idle';
  private currentGesture: RockyGesture = 'observe';

  /** rAF bookkeeping. */
  private lastFrame = 0;
  private rafId = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.creature = new Creature(canvas);
    this.active = this.creature;
    this.bubble = new SpeechBubble('#speech-bubble');

    // When the bubble dismisses (auto-timeout, click, or main asking), drop the
    // talk gesture and settle into the resting mode chosen by the last mood —
    // unless we are paused, in which case Rocky always returns to sleep.
    this.bubble.onDismiss(() => {
      this.active.setMode(this.paused ? 'sleep' : this.pendingRestMode);
      this.currentGesture = this.paused ? 'rest' : 'observe';
      this.active.setGesture(this.currentGesture);
    });
  }

  /** Initialise runtime flags from persisted settings, then subscribe + run. */
  async start(): Promise<void> {
    // Browser-only art direction preview. Electron always supplies the bridge;
    // this branch makes the renderer independently inspectable in development.
    if (typeof window.rocky === 'undefined') {
      const params = new URLSearchParams(window.location.search);
      if (params.has('icon')) {
        // Calm, symmetric pose for the app-icon capture (scripts/generate-icon.mjs).
        this.creature.setGesture('observe');
        this.creature.setMode('idle');
        this.installResize();
        this.loop(performance.now());
      } else if (params.has('preview')) {
        this.creature.setGesture('calculate');
        this.creature.setMode('talk');
        this.bubble.show('Problem is stubborn. Good. We are more stubborn.', 'coding');
        this.installResize();
        this.loop(performance.now());
      }
      return;
    }
    // Pull current settings so muted/paused are correct before the first frame.
    try {
      const settings = await window.rocky.getSettings();
      this.applyFlags(settings.muted, settings.paused);
      this.applyVoice(settings);
      void this.applySkin(settings.creatureSkin);
    } catch {
      // If settings are momentarily unavailable, fall through with defaults.
    }

    this.subscribe();
    this.installResize();
    this.installPointer();
    this.loop(performance.now());
  }

  /**
   * Click vs drag on Rocky himself. The canvas is a no-drag region, so we
   * implement window dragging manually (pointer deltas streamed to main) and
   * treat a press that never travels as a click — a poke asking Rocky to look
   * at the screen right now.
   */
  private installPointer(): void {
    const CLICK_SLOP_PX = 4;
    const CLICK_MAX_MS = 600;
    /** Holding Rocky without moving this long starts/stops a voice note. */
    const LONG_PRESS_MS = 550;
    let down = false;
    let dragging = false;
    let longPressed = false;
    let downX = 0;
    let downY = 0;
    let downAt = 0;
    let pressTimer: ReturnType<typeof setTimeout> | null = null;

    const clearPressTimer = () => {
      if (pressTimer !== null) {
        clearTimeout(pressTimer);
        pressTimer = null;
      }
    };

    this.canvas.addEventListener('pointerdown', (e: PointerEvent) => {
      if (e.button !== 0) return;
      down = true;
      dragging = false;
      longPressed = false;
      downX = e.screenX;
      downY = e.screenY;
      downAt = performance.now();
      // Capture so we keep receiving moves even if the cursor briefly outruns
      // the window while it is being repositioned.
      this.canvas.setPointerCapture(e.pointerId);
      // Long-press = push-to-talk, so capturing a thought is one physical
      // gesture on Rocky himself (a press that drags or releases early still
      // means move / look).
      clearPressTimer();
      pressTimer = setTimeout(() => {
        pressTimer = null;
        if (!down || dragging) return;
        longPressed = true;
        this.active.flash(0.7);
        void window.rocky.togglePushToTalk();
      }, LONG_PRESS_MS);
    });

    this.canvas.addEventListener('pointermove', (e: PointerEvent) => {
      if (!down) return;
      const dx = e.screenX - downX;
      const dy = e.screenY - downY;
      if (!dragging && Math.hypot(dx, dy) > CLICK_SLOP_PX) {
        clearPressTimer();
        if (longPressed) return; // recording started; a late wobble is not a drag
        dragging = true;
        this.canvas.classList.add('dragging');
        window.rocky.beginWindowDrag();
      }
      if (dragging) window.rocky.dragWindowBy(dx, dy);
    });

    const end = () => {
      if (!down) return;
      down = false;
      clearPressTimer();
      this.canvas.classList.remove('dragging');
      if (!dragging && !longPressed && performance.now() - downAt <= CLICK_MAX_MS) {
        this.pokeLook();
      }
      dragging = false;
      longPressed = false;
    };
    this.canvas.addEventListener('pointerup', end);
    this.canvas.addEventListener('pointercancel', end);
  }

  /** Throttle stamp for pokes, so click-spam can't queue a capture barrage. */
  private lastPokeAt = 0;

  /** A poke: acknowledge instantly, then ask main for a real look. */
  private pokeLook(): void {
    const now = performance.now();
    if (now - this.lastPokeAt < 2_000) return;
    this.lastPokeAt = now;
    // Immediate physical acknowledgement so the poke never feels ignored —
    // the observation reply (or paused/sleepy line) follows from main.
    this.active.flash(0.5);
    if (!this.paused && this.active.getMode() !== 'talk') {
      this.currentGesture = 'observe';
      this.active.setGesture(this.currentGesture);
      this.active.setMode('curious');
    }
    void window.rocky.lookNow();
  }

  /** Mirror the voice-related settings into the local fields. */
  private applyVoice(s: Settings): void {
    this.voiceMode = s.voiceMode;
    this.voicePitch = s.voicePitch;
    this.musicUnderlay = s.musicUnderlay;
  }

  /**
   * Switch the active renderer to the named skin. Falls back to the built-in
   * procedural creature for PROCEDURAL_SKIN or any load/decode failure, so the
   * companion always renders something.
   */
  private async applySkin(name: string): Promise<void> {
    if (name === this.currentSkinName) return;
    this.currentSkinName = name;

    if (name === PROCEDURAL_SKIN) {
      this.setActive(this.creature);
      return;
    }
    try {
      const loaded = await window.rocky.loadSkin(name);
      // Bail if the user switched again while we were loading.
      if (this.currentSkinName !== name) return;
      if (!loaded) {
        this.setActive(this.creature);
        return;
      }
      const skin = await SpriteSkin.create(this.canvas, loaded);
      if (this.currentSkinName !== name) return;
      this.setActive(skin ?? this.creature);
    } catch {
      this.setActive(this.creature);
    }
  }

  /** Make `renderer` active, carrying over the current mood and re-sizing it. */
  private setActive(renderer: CreatureRenderer): void {
    if (renderer === this.active) return;
    renderer.setMode(this.paused ? 'sleep' : this.active.getMode());
    renderer.setGesture(this.paused ? 'rest' : this.currentGesture);
    this.active = renderer;
    this.active.resize();
  }

  /** Apply muted/paused, propagating muted to both voices and paused to pose. */
  private applyFlags(muted: boolean, paused: boolean): void {
    this.muted = muted;
    this.tone.setMuted(muted);
    this.spoken.setMuted(muted);
    this.system.setMuted(muted);

    const wasPaused = this.paused;
    this.paused = paused;

    if (paused) {
      // Going to sleep: stop any pending tone gesture energy and settle low.
      this.active.setMode('sleep');
      this.currentGesture = 'rest';
      this.active.setGesture(this.currentGesture);
    } else if (wasPaused && !paused) {
      // Waking up: only return to idle if we are not mid-conversation.
      if (this.active.getMode() === 'sleep') {
        this.currentGesture = 'observe';
        this.active.setGesture(this.currentGesture);
        this.active.setMode('idle');
      }
    }
  }

  /** Subscribe to every push event from main. */
  private subscribe(): void {
    // A new reaction: talk (tinted by mood), show the bubble, optionally voice.
    window.rocky.onReply((reply: RockyReply) => this.handleReply(reply));

    // A capture happened: a brief glow flash so it is never invisible.
    window.rocky.onCaptureIndicator(() => this.active.flash(0.55));

    // Mirror of paused/muted runtime state.
    window.rocky.onState((state: RockyState) => this.applyFlags(state.muted, state.paused));

    // Live settings refresh (e.g. user toggled mute in the settings window).
    window.rocky.onSettingsUpdated((s: Settings) => {
      this.applyFlags(s.muted, s.paused);
      this.applyVoice(s);
      void this.applySkin(s.creatureSkin);
    });

    // Push-to-talk: main drives the recorder lifecycle; the audio itself never
    // leaves this renderer except as the in-memory WAV handed back to main.
    window.rocky.onPtt((cmd) => void this.handlePtt(cmd.phase));

    // A newer release exists: Rocky offers it with Fetch / Later buttons.
    window.rocky.onUpdateAvailable((update) => {
      this.pendingRestMode = 'curious';
      this.currentGesture = 'greet';
      this.active.setGesture(this.currentGesture);
      this.active.setMode('talk');
      this.bubble.show(update.line, 'update', [
        { label: 'Fetch update', onClick: () => void window.rocky.openUpdate() },
        { label: 'Later', onClick: () => void window.rocky.dismissUpdate() },
      ]);
    });
  }

  /** Drive the push-to-talk recorder on main's command. */
  private async handlePtt(phase: 'start' | 'stop' | 'cancel'): Promise<void> {
    if (phase === 'start') {
      try {
        await this.recorder.start();
        // Hold the listening posture while the mic is live.
        this.currentGesture = 'listen';
        this.active.setGesture(this.currentGesture);
        this.active.setMode('curious');
      } catch {
        // Mic denied/unavailable at the OS level — tell main to reset.
        window.rocky.cancelVoiceNote('mic-failed');
      }
      return;
    }
    if (phase === 'cancel') {
      this.recorder.cancel();
      return;
    }
    // stop → hand the audio to main (transcribe + save happen there).
    try {
      const wav = await this.recorder.stop();
      if (!wav) {
        window.rocky.cancelVoiceNote('no-audio');
        return;
      }
      await window.rocky.submitVoiceNote(wav);
    } catch {
      window.rocky.cancelVoiceNote('capture-failed');
    }
  }

  /**
   * Bubble quick-actions for special reply kinds, so voice notes and the
   * notebook are reachable straight from Rocky himself.
   */
  private bubbleExtras(reply: RockyReply): { actions?: BubbleAction[]; delayMs?: number } {
    if (reply.kind === 'listening') {
      return {
        actions: [
          { label: 'Save note', onClick: () => void window.rocky.togglePushToTalk() },
          { label: 'Cancel', onClick: () => window.rocky.cancelVoiceNote() },
        ],
        // Stay up for the whole possible recording window (main caps at 2 min).
        delayMs: 130_000,
      };
    }
    if (reply.kind === 'note-saved') {
      return {
        actions: [{ label: 'Notes & chat…', onClick: () => void window.rocky.openChat() }],
        delayMs: 12_000,
      };
    }
    if (reply.kind === 'weekly-offer') {
      return {
        actions: [
          { label: 'Reflect now', onClick: () => void window.rocky.openChat('weekly') },
          { label: 'Later', onClick: () => undefined },
        ],
      };
    }
    return {};
  }

  /** Handle an incoming reply: animate, show the bubble, and voice the line. */
  private async handleReply(reply: RockyReply): Promise<void> {
    // Remember where to settle once the bubble goes away.
    this.pendingRestMode = moodToRestingMode(reply.mood);
    this.currentGesture = reply.gesture;
    this.active.setGesture(this.currentGesture);
    this.active.setMode('talk');

    // Show the locally generated translation (plus any quick-action buttons).
    const extras = this.bubbleExtras(reply);
    this.bubble.show(reply.line, reply.activity, extras.actions, extras.delayMs);

    if (this.muted) return;

    if (this.voiceMode === 'openai') {
      // Spoken voice. Rocky "speaks in music", so optionally keep a soft
      // procedural phrase underneath as his real language; the TTS is the
      // translated words on top.
      if (this.musicUnderlay) this.playTone(reply.motif, 0.22);

      const segments = await window.rocky.speakLine(reply.line).catch(() => null);
      if (segments && segments.length && !this.muted) {
        const duration = await this.spoken
          .playSequence(segments, this.voicePitch)
          .catch(() => 0);
        // Pulse the seam glow across the spoken line so Rocky "speaks" visibly.
        this.active.scheduleGlowPulses(glowPulsesForDuration(duration));
      } else if (!this.muted) {
        // No key / no consent / synthesis failed — fall back to the full
        // procedural tone so Rocky still says something audible. The soft
        // underlay (if any) has short scheduled chords, so replaying at full
        // volume just reasserts the phrase rather than doubling it.
        this.playTone(reply.motif, 1);
      }
    } else if (this.voiceMode === 'offline') {
      // Offline spoken voice: no key, fully on-device. Optional soft chords
      // underneath as Rocky's real language.
      if (this.musicUnderlay) this.playTone(reply.motif, 0.22);

      // Prefer the bundled neural voice (main/Piper): it returns WAV segments
      // that play through the shared spoken path with accurate glow timing.
      const segments = await window.rocky.speakLineOffline(reply.line).catch(() => null);
      if (segments && segments.length && !this.muted) {
        const duration = await this.spoken.playSequence(segments, this.voicePitch).catch(() => 0);
        this.active.scheduleGlowPulses(glowPulsesForDuration(duration));
      } else if (!this.muted) {
        // Piper not bundled on this platform (e.g. macOS) — fall back to the
        // OS speech engine. It reports no duration up front, so glow on an
        // estimate rather than awaiting the utterance.
        this.active.scheduleGlowPulses(
          glowPulsesForDuration(this.system.estimateDuration(reply.line)),
        );
        const ok = await this.system.speak(reply.line, this.voicePitch).catch(() => false);
        // Nothing spoke and no underlay already played — full tone so Rocky is
        // never silent.
        if (!ok && !this.musicUnderlay && !this.muted) this.playTone(reply.motif, 1);
      }
    } else {
      // Procedural Eridian chords; glow pulses align to their onsets.
      this.playTone(reply.motif, 1);
    }
  }

  /** Play the procedural tone at `volume` and align glow pulses to its onsets. */
  private playTone(motif: RockyReply['motif'], volume: number): void {
    const onsets = this.tone.play(motif, volume);
    if (Array.isArray(onsets) && onsets.length) {
      this.active.scheduleGlowPulses(onsets);
    }
  }

  /** Keep the canvas backing store matched to the window on resize. */
  private installResize(): void {
    window.addEventListener('resize', () => this.active.resize());
  }

  /** The render loop. dt is clamped so a backgrounded tab can't jump the anim. */
  private loop = (now: number): void => {
    const dtRaw = (now - this.lastFrame) / 1000;
    this.lastFrame = now;
    const dt = dtRaw > 0 && dtRaw < 0.1 ? dtRaw : 0.016; // clamp/guard first frame
    this.active.draw(dt, now);
    this.rafId = requestAnimationFrame(this.loop);
  };
}

// ── Bootstrap ────────────────────────────────────────────────────────────────

function boot(): void {
  const canvas = document.getElementById('rocky-canvas');
  if (!(canvas instanceof HTMLCanvasElement)) {
    // Without the canvas there is nothing to draw; fail quietly (no logs of
    // anything sensitive — there is nothing sensitive here anyway).
    return;
  }
  const companion = new Companion(canvas);
  void companion.start();
  installControls();
}

// The script tag is at the end of <body>, so the DOM is already parsed; but
// guard for safety in case the bundler or load order ever changes.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
