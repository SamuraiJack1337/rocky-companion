# Rocky Companion: Voice-First Roadmap — Feasibility Notes

Branch: `feature/voice-companion-roadmap`
Assessed against the codebase at v0.1.6 (~7.7k lines of TypeScript, Electron + esbuild, macOS-first).

## Vision (as proposed)

Rocky evolves from a screenshot-reactive desktop companion into a voice-first AI
companion in two stages:

- **Stage 1 — Voice notes + conversation around notes.** Talk to Rocky, capture
  thoughts as notes, later ask Rocky to recall, summarize, connect, and question
  those notes.
- **Stage 2 — Full companion.** Wake word ("Hey Rocky"), real-time speech,
  personal intelligence (projects, habits, goals), proactive help, and
  controlled computer actions (open apps, manage files, assist workflows).

## What the current product already gives us

| Existing piece | Reused for |
| --- | --- |
| `VisionProvider` interface + local/cloud factory with consent gating (`src/main/providers/`) | Template for `SpeechProvider` (STT) and `EmbeddingProvider` — local-default, cloud BYOK opt-in |
| TTS pipeline in main + Web Audio playback (`src/main/tts.ts`, `src/renderer/spokenVoice.ts`) | Rocky's half of the conversation is already done |
| Typed IPC bridge, 20+ channels (`src/shared/ipc.ts`, `preload.ts`) | Add `startListening`, `saveNote`, `queryNotes`, `chat` channels the same way |
| Window management (companion/settings/consent/lab) | New chat/notes window follows the same pattern |
| Consent architecture (capture consent, cloud opt-in, TTS opt-in) | Add mic consent, notes-persistence consent, (later) automation consent as new tiers |
| macOS permission UX (`permissions.ts`, Screen Recording flow) | Same shape for Microphone (and later Accessibility) permission |
| Persona/lines system (`src/shared/persona.ts`) | Personality layer for conversations |
| Scheduler + frontmost-app/idle watcher (`scheduler.ts`, `activeApp.ts`) | Foundation for Stage 2 proactive nudges |
| Relationship memory JSON store (`memory.ts`) | Pattern for the note store (atomic writes in userData) |

## What does not exist today

- **No audio input of any kind** — zero microphone, STT, or recording code.
- **No free-text chat surface** — the app is one-directional (screenshot → bubble).
- **No content persistence** — by design, nothing the user does is stored.

## Stage 1 assessment: HIGH feasibility

All new modules, no rework of the core loop.

1. **Voice capture** — `getUserMedia` in the renderer works in Electron on
   macOS; needs `NSMicrophoneUsageDescription` in the plist + mic permission
   handling (mirror the Screen Recording UX). Start with **push-to-talk**
   (global shortcut or click-and-hold on Rocky), not a wake word.
2. **STT** — dual provider like vision: local **whisper.cpp** (new dependency;
   Ollama does not do STT) and cloud **OpenAI Whisper / gpt-4o-transcribe** via
   the existing BYOK key. Cloud path is a day of work; local path is the risk
   item (binary packaging, non-Apple-Silicon latency).
3. **Note store** — JSON or SQLite in userData, timestamps + text + topics.
   ⚠ This is the first time Rocky persists user content — the README privacy
   guarantees must be updated and the store gated behind explicit consent
   (and optionally `safeStorage`-encrypted).
4. **Retrieval** — at personal scale (≤ a few thousand notes) skip a vector DB:
   embeddings (local `nomic-embed-text` via Ollama, or `text-embedding-3-small`
   cloud) + brute-force cosine in memory. Upgrade to `sqlite-vec` only if needed.
5. **Chat + reflection** — new window; both providers already speak chat-style
   APIs; retrieval-augmented prompt + persona layer.

Suggested slices, each shippable:
- **1a:** push-to-talk → STT → note saved, Rocky confirms verbally.
- **1b:** chat window with retrieval ("what did I say about…", summaries).
- **1c:** reflection (connections, follow-up questions, weekly digest).

Rough effort: ~3–6 weeks part-time (cloud-first), +1–2 weeks for solid local STT.

## Stage 2 assessment: MIXED — split it

- **Wake word:** feasible fully on-device (Picovoice Porcupine custom
  "Hey Rocky" keyword, or openWakeWord). Always-on mic is a brand-level
  privacy decision for a privacy-first product; must be provably local-only
  and clearly indicated.
- **Real-time conversation:** cloud-first via OpenAI Realtime API is very
  doable under BYOK. A fully local streaming pipeline (streaming whisper →
  local LLM → TTS) will feel laggy on most machines today; treat as later.
- **Personal intelligence / proactive help:** the hard part is *product*, not
  tech — it directly conflicts with the current guarantee that no activity
  history is persisted. Needs a new consent tier and an encrypted local
  profile store. The watcher/sessionTracker/milestones machinery is a head
  start on the proactive triggers.
- **Computer actions:** start with a small whitelisted tool set in main
  (open app, reveal/search files via Spotlight `mdfind`, create note, timers,
  AppleScript one-liners) with per-action confirmation. General desktop
  automation (Accessibility API driving arbitrary apps) is a months-long
  reliability problem — defer.

Rough effort: wake word + realtime voice 4–8 weeks; basic tool actions
2–4 weeks; full proactive assistant is an ongoing program, not a milestone.

## Backlog (agreed, not yet built)

- **Streaming chat replies.** Ollama chat on long answers feels slow; stream
  tokens over IPC into the chat window's Rocky bubble as they arrive (Ollama
  `stream: true` NDJSON / OpenAI Responses streaming → an `EV.CHAT_TOKEN`
  push event, falling back to the current one-shot path on error). Agreed to
  do this after the Stage 1 UX round; medium effort.

## Prerequisites / risks

- **Code signing:** ad-hoc signing already forces per-update re-grants of
  Screen Recording. Adding Microphone (Stage 1) and Accessibility (Stage 2)
  makes that untenable — a Developer ID certificate becomes effectively
  required before Stage 2, strongly recommended before shipping Stage 1.
- **Privacy narrative:** "screenshots never persisted" stays true; add a
  clearly separated, consent-gated "Rocky's notebook" story for notes.
- **Scope control:** Stage 2's "agent architecture" should stay a typed tool
  registry in the main process, not a general computer-use agent.
