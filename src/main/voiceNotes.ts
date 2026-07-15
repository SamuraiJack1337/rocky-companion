// Push-to-talk voice notes (Stage 1a). One global shortcut toggles a tiny
// state machine: idle → recording → processing → idle. The actual microphone
// capture happens in the companion renderer (getUserMedia); this controller
// only orchestrates — it never touches audio devices itself.
//
// Flow: toggle → mic permission check → EV.PTT start → renderer records →
// toggle again → EV.PTT stop → renderer submits an in-memory WAV → the
// configured SpeechProvider transcribes → the notebook stores the text →
// Rocky confirms out loud with a snippet (so mishearings are visible).
//
// Audio is in-memory end to end, except the local whisper-cli path, which
// writes a transient owner-only temp file (see WhisperCliProvider).

import { globalShortcut } from 'electron';
import type {
  NoteView,
  RockyReply,
  Settings,
  TranscriptionResult,
  VoiceCaptureState,
  VoiceNoteResult,
} from '../shared/types';
import type { PttCommand } from '../shared/ipc';
import { createSpeechProvider } from './providers/SpeechProvider';
import { notes } from './notes';
import { embedTexts } from './embeddings';
import { getMicPermission, requestMicPermission } from './permissions';
import {
  listeningReply,
  micDeniedReply,
  noteEmptyReply,
  noteSavedReply,
  noteSnippet,
  voiceTroubleReply,
} from '../shared/persona';
import { renderLine } from '../shared/lines';

/** Recording longer than this is force-stopped (bounds renderer memory too). */
const MAX_RECORDING_MS = 120_000;
/** If the renderer never delivers audio after a stop, give up and reset. */
const SUBMIT_TIMEOUT_MS = 30_000;

export interface VoiceNotesDeps {
  getSettings: () => Settings;
  /** Show a bubble/gesture on the companion (and speak it, per voice settings). */
  emitReply: (reply: RockyReply) => void;
  /** Push a recorder command to the companion window. */
  sendPtt: (cmd: PttCommand) => void;
  /** Mirror the capture state to every window (tray/chat UI reflect it). */
  broadcastState: (state: VoiceCaptureState) => void;
  /** A note was saved — notebook views refresh on this. */
  broadcastNoteSaved: (note: NoteView) => void;
  /** Rocky must be visible while he listens. */
  showCompanion: () => void;
}

export class VoiceNotesController {
  private state: VoiceCaptureState = 'idle';
  private stopTimer: ReturnType<typeof setTimeout> | null = null;
  private submitTimer: ReturnType<typeof setTimeout> | null = null;
  private registeredShortcut: string | null = null;

  constructor(private readonly deps: VoiceNotesDeps) {}

  getState(): VoiceCaptureState {
    return this.state;
  }

  /** The one entry point — global shortcut, tray item, and IPC all land here. */
  async toggle(): Promise<void> {
    if (this.state === 'recording') {
      this.beginProcessing();
      return;
    }
    if (this.state === 'processing') return; // ignore until the last one lands

    const name = this.deps.getSettings().callName;
    const permission = getMicPermission();
    if (permission === 'not-determined') {
      const granted = (await requestMicPermission()) === 'granted';
      if (!granted) {
        this.deps.showCompanion();
        this.deps.emitReply(micDeniedReply(name));
        return;
      }
    } else if (permission !== 'granted') {
      this.deps.showCompanion();
      this.deps.emitReply(micDeniedReply(name));
      return;
    }

    this.setState('recording');
    this.deps.showCompanion();
    this.deps.sendPtt({ phase: 'start' });
    this.deps.emitReply(listeningReply(name));
    this.stopTimer = setTimeout(() => this.beginProcessing(), MAX_RECORDING_MS);
    this.stopTimer.unref?.();
  }

  /** Ask the renderer to stop and hand the audio over; arm a safety timeout. */
  private beginProcessing(): void {
    this.clearTimers();
    this.setState('processing');
    this.deps.sendPtt({ phase: 'stop' });
    this.submitTimer = setTimeout(() => {
      // The renderer never delivered (window closed, capture failed silently).
      this.resetToIdle();
    }, SUBMIT_TIMEOUT_MS);
    this.submitTimer.unref?.();
  }

  /** Renderer capture failed or was cancelled; reset without a note. */
  cancel(reason?: string): void {
    if (this.state === 'idle') return;
    this.clearTimers();
    this.deps.sendPtt({ phase: 'cancel' });
    this.resetToIdle();
    const name = this.deps.getSettings().callName;
    if (reason === 'no-audio') {
      this.deps.emitReply(noteEmptyReply(name));
    } else if (reason === 'mic-failed') {
      this.deps.emitReply(micDeniedReply(name));
    } else if (reason === 'capture-failed') {
      this.deps.emitReply(
        voiceTroubleReply('Rocky’s ears glitched, {name}. Try once more, question?', name),
      );
    }
  }

  /** The captured WAV arrives from the renderer: transcribe, store, confirm. */
  async submit(wavBase64: string): Promise<VoiceNoteResult> {
    this.clearTimers();
    const settings = this.deps.getSettings();
    const name = settings.callName;
    // Accept audio even if a timeout already reset us — the words still matter.
    this.setState('processing');
    try {
      const transcription = await this.transcribe(wavBase64);
      if (!transcription.ok) {
        const error = transcription.error ?? 'Rocky could not translate the sound, {name}.';
        this.deps.emitReply(voiceTroubleReply(error, name));
        return { ok: false, error };
      }
      const note = notes.add(transcription.text ?? '', 'voice');
      if (!note) {
        this.deps.emitReply(noteEmptyReply(name));
        return { ok: false, error: 'Nothing to keep.' };
      }
      this.deps.emitReply(noteSavedReply(noteSnippet(note.text), name));
      this.deps.broadcastNoteSaved(note);
      this.embedInBackground(note);
      return { ok: true, note };
    } finally {
      this.resetToIdle();
    }
  }

  /** Transcribe without saving (the chat window's mic button). Error lines
   *  come back fully rendered — safe to show in any window as-is. */
  async transcribe(wavBase64: string): Promise<TranscriptionResult> {
    const settings = this.deps.getSettings();
    if (!wavBase64 || typeof wavBase64 !== 'string') {
      return { ok: false, error: renderLine('Rocky received no audio, {name}.', { name: settings.callName }) };
    }
    const provider = createSpeechProvider(settings);
    const result = await provider.transcribe(wavBase64);
    return result.ok
      ? result
      : { ok: false, error: renderLine(result.error ?? '', { name: settings.callName }) };
  }

  /** Compute + attach the note's embedding without blocking the confirmation. */
  private embedInBackground(note: NoteView): void {
    const settings = this.deps.getSettings();
    void embedTexts([note.text], settings).then((batch) => {
      if (batch) notes.setEmbedding(note.id, batch.vectors[0], batch.model);
    });
  }

  /**
   * (Re-)register the global push-to-talk accelerator. Returns false when the
   * accelerator is invalid or taken; any previous registration stays removed
   * so a bad value can never leave a stale hotkey active.
   */
  registerShortcut(accelerator: string): boolean {
    if (this.registeredShortcut) {
      try {
        globalShortcut.unregister(this.registeredShortcut);
      } catch {
        /* already gone */
      }
      this.registeredShortcut = null;
    }
    const accel = (accelerator || '').trim();
    if (!accel) return false;
    try {
      const ok = globalShortcut.register(accel, () => void this.toggle());
      if (ok) this.registeredShortcut = accel;
      return ok;
    } catch {
      return false;
    }
  }

  dispose(): void {
    this.clearTimers();
    if (this.registeredShortcut) {
      try {
        globalShortcut.unregister(this.registeredShortcut);
      } catch {
        /* shutting down */
      }
      this.registeredShortcut = null;
    }
  }

  private setState(state: VoiceCaptureState): void {
    if (this.state === state) return;
    this.state = state;
    this.deps.broadcastState(state);
  }

  private resetToIdle(): void {
    this.clearTimers();
    this.setState('idle');
  }

  private clearTimers(): void {
    if (this.stopTimer) {
      clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }
    if (this.submitTimer) {
      clearTimeout(this.submitTimer);
      this.submitTimer = null;
    }
  }
}
