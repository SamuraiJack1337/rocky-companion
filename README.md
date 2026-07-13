# Rocky Companion

A privacy-first, movie-character desktop companion for macOS. Rocky is a
faceless five-limbed Eridian engineer: an intelligent collaborator who observes
only broad activity categories, speaks in five-part musical chords, and uses a
compact translator to work alongside you.

> ## No API key in this repo. Ever.
>
> **This repository contains NO API key, and it never will.** There is no shared
> or hidden key baked into the build. If you choose the optional Cloud provider,
> **you supply your own OpenAI key** (Bring Your Own Key). The default provider is
> **Local (Ollama)**, which runs entirely on your own machine and sends nothing to
> any server.

---

## What Rocky is

Rocky is an [Electron](https://www.electronjs.org/) + TypeScript desktop companion:

- **Gentle and privacy-first.** Rocky reacts to the *kind* of activity on screen
  (coding, writing, reading, watching video, idle…) at a **high level only**. He
  never transcribes, quotes, or repeats on-screen text, and he deliberately looks
  away from anything that appears sensitive (logins, banking, private messages).
- **Character-authentic.** Rocky is treated as a scientific and engineering
  equal, never a pet. The built-in faceless performance uses weight, silhouette,
  five articulated limbs, three digits per limb, and a musical language.
- **Rights-controlled.** The MIT license covers the software implementation only; Project Hail Mary
  characters, names, likenesses, and other underlying IP are not relicensed.
- **macOS-first.** Phase 1 targets macOS. Windows support is a future,
  non-committed idea (see [Future](#future)).

---

## Privacy model, in plain terms

Rocky periodically captures a single screenshot and asks a vision model for only
three fixed fields: activity, mood, and sensitivity. Dialogue and physical
performance are then generated locally from those enums; the vision layer cannot
author Rocky's line. How
that capture is handled depends entirely on which provider you choose:

| Provider | Where the screenshot goes | Opt-in required |
| --- | --- | --- |
| **Local (Ollama)** — *default* | Stays **on your device**. Sent only to your local Ollama server at `localhost:11434`. Nothing leaves your machine. | First-run capture consent. |
| **Cloud (OpenAI)** | Sent to **OpenAI**, under **your own API key**. | Separate, explicit **cloud opt-in** on top of capture consent. |

Hard guarantees that hold for **both** providers:

- **Screenshots are NEVER written to disk.** They live in memory only, for the
  moment it takes to analyze them, and are then discarded.
- **Understanding is enum-only.** Vision output is reduced to a fixed activity
  category such as `coding`, `meeting`, `idle`, or `sensitive`, plus mood and a
  sensitivity flag. Extra model output is discarded before character dialogue
  is generated.
- **Local really means loopback.** Ollama hosts are restricted to `localhost`,
  `127.0.0.1`, or `::1`. A remote endpoint cannot be silently configured as the
  local provider.
- **Your API key is never logged**, and image bytes are never logged.

The local provider is the default precisely because it keeps everything
on-device. Cloud is strictly opt-in.

---

## Install (no terminal needed)

Grab the latest `RockyCompanion-<version>-mac.dmg` from the
[Releases](../../releases/latest) page, open it, and drag **Rocky Companion**
into **Applications** (replace the old copy when updating — your settings and
Rocky's memory live in your user folder and survive).

**First open:** the app is not code-signed yet, so **macOS will refuse to open
it** — typically with a "damaged" or "cannot be opened" warning. Run this once
in Terminal, then open the app normally:

```bash
xattr -dr com.apple.quarantine "/Applications/Rocky Companion.app"
```

(Right-click → **Open** → **Open** sometimes works instead, but on recent
macOS versions the `xattr` command above is usually required.)

**After updating:** the app is ad-hoc signed (no Developer ID yet), and ad-hoc
signatures differ per build, so macOS treats each new version as a brand-new
app. Expect up to three one-time prompts after an update:

1. Run the `xattr` command again if macOS refuses to open the app.
2. **Re-grant Screen Recording** (System Settings → Privacy & Security → Screen
   Recording — toggle Rocky Companion **off and back on**, then relaunch). If
   the toggle already looks ON but Rocky still reports denied, that stale
   toggle belongs to the previous copy — flipping it off/on fixes it.
3. A keychain prompt — *"Rocky Companion wants to access key 'rocky-companion
   Safe Storage'"* — appears because the new build's signature no longer
   matches the one that created the item. Enter your Mac login password and
   click **Always Allow**; this is the app reading its own encryption key for
   your stored API key. Nothing leaves your machine.

Rocky checks the Releases page about once a day and offers new versions in a
speech bubble (you can turn this off in Settings — it is the app's only
network call besides your chosen vision provider).

Everything below is for running from source.

---

## Prerequisites

- **macOS** (Phase 1 is macOS-first).
- **Node.js LTS** — Node **22.12+**.
- **One vision provider**, either:
  - **Local:** [Ollama](https://ollama.com/) installed and running (default), or
  - **Cloud:** an [OpenAI](https://platform.openai.com/) account and **your own**
    API key.

---

## Quick start

```bash
# 1. Fork, then clone your fork
git clone https://github.com/<your-username>/rockycompanion.git
cd rockycompanion

# 2. Install dependencies
npm install

# 3. Choose a provider (see "Two setup paths" below)
#    - Local (Ollama): no key needed — recommended, fully private.
#    - Cloud (OpenAI): bring your own key. Add it later in Settings, OR
#      copy the example env file and put your key there:
cp .env.example .env        # then edit .env and set OPENAI_API_KEY=...

# 4. Run in development (builds, then launches Electron)
npm run dev
```

> `.env` is **git-ignored** — your key never gets committed. Copying it from
> `.env.example` is optional; you can instead enter the key in **Settings**, where
> it is stored encrypted in your macOS Keychain.

On first launch Rocky shows a consent screen. Pick your provider and, for Cloud,
explicitly opt in to sending screenshots to OpenAI. The default selection is
Local.

---

## Two setup paths

### Local (Ollama) — private, on-device, default

Everything stays on your machine. Recommended for privacy.

1. Install [Ollama](https://ollama.com/download).
2. Pull a vision model:

   ```bash
   ollama pull llama3.2-vision
   ```

   `llama3.2-vision` is the default. If you want something lighter, `moondream`
   works as a smaller fallback (less detailed, but faster and lower-memory):

   ```bash
   ollama pull moondream
   ```

3. Make sure Ollama is running. It listens on `http://localhost:11434` by
   default — this is the host Rocky uses out of the box.
4. In Rocky, leave the provider on **Local** (the default) and select your model.

No key, no account, no network egress for analysis.

### Cloud (OpenAI) — Bring Your Own Key

If you prefer a hosted model, you can use OpenAI with **your own** key.

1. Create an API key in the [OpenAI dashboard](https://platform.openai.com/api-keys).
2. Provide the key in **one** of two ways:
   - **Settings (recommended):** open Rocky's Settings and paste the key. It is
     validated with a tiny test call, then **stored encrypted in the macOS
     Keychain via Electron `safeStorage`** — never in the repo, never in plain
     text, never logged.
   - **`.env` file:** copy `.env.example` to `.env` and set:

     ```ini
     OPENAI_API_KEY=sk-your-own-key-here
     ```

     `.env` is git-ignored.
3. In Rocky, switch the provider to **Cloud** and complete the explicit cloud
   opt-in.

**Model note:** the default cloud model is **`gpt-5.4-mini`**. `gpt-4o` is
**retired** — use a current **GPT-5.x** vision-capable model. You can change the
model name in Settings.

---

## macOS Screen Recording permission

To capture the screen at all, macOS requires the **Screen Recording** permission.

1. Open **System Settings → Privacy & Security → Screen Recording**.
2. Enable **Rocky Companion** (in development, this may appear as **Electron** or
   your terminal app).
3. **Relaunch** the app after granting — macOS only applies the change on a fresh
   launch (Settings → Screen recording has a **Relaunch Rocky** button).
4. **If the toggle is already ON but Rocky still says denied:** the grant
   belongs to an older copy of the app (unsigned builds look like a new app to
   macOS after every update). Toggle it **off and back on**, then relaunch. As a
   last resort, run `tccutil reset ScreenCapture` in Terminal and grant again.

Without this permission, captures come back **blank/black**, and Rocky will tell
you his eyes are cloudy rather than pretend he can see. Rocky surfaces the
permission state so you are never left guessing.

---

## Changing settings

You can adjust Rocky's behavior from the **tray menu** or the **Settings** window:

- **Interval** — how often Rocky looks (1–120 minutes; presets at 1, 5, 15, 30,
  60, 120). Default is **15 minutes**.
- **Provider** — Local (Ollama) or Cloud (OpenAI).
- **Model** — the Ollama model name (local) or the OpenAI model name (cloud).
- **Voice** — how Rocky sounds (see below).
- **Mute / Unmute** — toggle Rocky's voice.
- **Click-through** — when on, the window ignores the mouse so Rocky floats over
  your work without getting in the way.
- **Blocked apps** — one frontmost macOS app name per line. Matches are exact
  and case-insensitive unless you add `*` wildcards. Rocky skips capture before
  a screenshot is taken whenever a blocked app is frontmost.

### Voice

Rocky has two voice modes, set in **Settings → Voice**:

- **Eridian chords (procedural)** — the default. Each syllable is a five-tone
  chord synthesized on-device, with mood changing register, harmonic tension,
  pacing, and timbre. No audio files, account, or network call is involved.
- **Spoken translation (OpenAI TTS)** — optional. Rocky's translated line can be read aloud using
  a configurable OpenAI TTS model (`tts-1` / `tts-1-hd` for the plain natural
  preset, or `gpt-4o-mini-tts` for a steerable delivery) and one of **OpenAI's
  own built-in synthetic voices** (`echo`, `onyx`, `ash`, `sage`, …). The
  synthesis happens in the main process so your key never reaches the renderer;
  only Rocky's short line text is sent (never a screenshot). A **delivery-style**
  instruction (gpt-4o-mini-tts only) shapes pace/warmth, a **pitch** slider
  shifts him deeper, and an optional **Eridian underlay** keeps his chord-language
  beneath the translation. Use **Play test line** to
  audition before saving. **Requires a stored OpenAI key** — without one (or if
  synthesis fails) Rocky gracefully falls back to on-device chords.

Cloud speech has its own explicit consent checkbox, separate from cloud vision.
Only the locally generated translation text is transmitted; screenshots are not.

> Note: the **vision provider** still defaults to **Local (Ollama)**, so a fresh
> install never sends a screenshot off-device by default. Spoken translation
> transmits the short generated line only when a key and cloud-voice consent are set.

> The TTS voices are OpenAI's synthetic presets — they are **not** modeled on,
> and must not be used to imitate, any real person. To use a different licensed
> voice later, swap in an authorized TTS provider behind the same hook.

### Creature skins (drop-in art)

The creature is drawn **procedurally** by default (no assets). You can swap in
your own art — a sprite sheet or per-mood stills — without touching code:

1. **Settings → Creature → Open skins folder** (this is `skins/` under the app's
   `userData` directory).
2. Add a folder `skins/<name>/` containing a `skin.json` manifest plus images.
3. **Refresh**, then pick your skin from the **Appearance** dropdown.

Cover five moods: `idle`, `talk`, `curious`, `concerned`, `sleep`. Images should
be transparent PNGs with the creature centered. Two manifest shapes are
supported:

```jsonc
// skins/my-rocky/skin.json — "frames" mode (one image per frame; great for AI stills)
{
  "name": "my-rocky", "displayName": "My Rocky",
  "type": "frames", "fps": 10,
  "states": {
    "idle":      { "files": ["idle.png"],              "loop": true },
    "talk":      { "files": ["talk1.png", "talk2.png"],"loop": true, "fps": 14 },
    "curious":   { "files": ["curious.png"],           "loop": true },
    "concerned": { "files": ["concerned.png"],         "loop": true },
    "sleep":     { "files": ["sleep.png"],             "loop": true, "fps": 3 }
  }
}
```

```jsonc
// "sprite" mode — one grid sheet; states list frame indices
{ "name": "my-rocky", "displayName": "My Rocky",
  "type": "sprite", "image": "rocky.png",
  "frameWidth": 512, "frameHeight": 512, "columns": 8, "fps": 12,
  "states": { "idle": { "frames": [0,1,2,3] }, "talk": { "frames": [8,9,10,11] } } }
```

A single still per mood is enough — the app adds subtle breathing/glow so it
still feels alive. Skin images are read by the main process and handed to the
renderer in-memory; the renderer never reads the filesystem. (Only original or
properly licensed art should be placed here.)

### Rocky Lab

Open **Rocky Lab…** from the tray for the interactive companion tools:

- **Focus watch** — start a preset or custom focus session. Scheduled screen
  observations stop while Rocky keeps watch; completion ends with a fist bump.
- **Engineering calculator** — evaluate arithmetic, parentheses, powers, and
  `pi`/`e` through a local parser. It never uses `eval` or a network service.
- **Unit converter** — convert length, mass, time, data, and temperature locally.
- **Relationship** — view Rocky's stage and privacy-safe counters, or reset them.
  Memory contains only timestamps and counts—never app names, activity history,
  screenshots, window titles, prompts, or document text.
- **Fist bump** — trigger Rocky's completion ritual directly.

Rocky's relationship progresses from first contact to colleague, buddy, and
trusted buddy through launches, observations, completed focus sessions,
calculations, and fist bumps.

### Tray controls summary

The menu-bar (tray) icon gives you quick access to:

- **Show / Hide Rocky** — toggle the companion window.
- **Look now** — trigger an immediate capture + reaction.
- **Pause / Resume** — stop or restart scheduled captures (paused = Rocky sleeps).
- **Mute / Unmute** — toggle Rocky's voice (tones or spoken).
- **Interval ▸** — submenu of cadence presets.
- **Start 25 min focus / Focus (active)** — start a focus-watch session, or
  cancel the one in progress.
- **Fist bump** — trigger the shared completion ritual.
- **Rocky Lab…** — open focus, engineering, and relationship tools.
- **Settings…** — open the full settings window.
- **Quit** — exit the app.

---

## How it works

A short architecture note:

- **Electron + TypeScript**, with three isolated surfaces: the **main process**,
  a minimal **preload bridge**, and the **renderer** (companion, settings,
  consent, and Lab windows). The renderer runs with `contextIsolation` on and no Node
  access — it talks to main only through a typed `window.rocky` bridge.
- **esbuild bundling.** Main and preload are bundled as Node/CJS into
  `dist/main`; the renderer entries (`companion.ts`, `settings.ts`, `consent.ts`,
  `lab.ts`) are bundled as browser/IIFE into `dist/renderer`; HTML and
  `styles.css` are copied alongside.
- **Pluggable `VisionProvider`.** Local (Ollama) and Cloud (OpenAI) are
  interchangeable backends behind one interface. Rocky's persona, prompt, and
  output parsing are **shared**, so behavior is identical regardless of backend.
- **In-memory capture pipeline.** Screenshots are captured, analyzed, and
  discarded in memory — never persisted.
- **Two-stage privacy boundary.** Vision returns fixed enums; local character
  code turns them into dialogue, gesture, and sound without seeing the image.
- **Web Audio Eridian voice.** Five independently detuned oscillators form every
  chord. Eleven stable motifs give greetings, questions, calculations, concern,
  focus, completion, rest, and farewell repeatable musical identities.
- **Faceless canvas performance.** Rocky is drawn and animated on an HTML canvas.
  Twelve gestures convey emotion through limb choreography, timing, weight, and
  silhouette, including greeting, calculation, building, watch, fist bump, and farewell.
- **Privacy-safe relationship memory.** A separate owner-only JSON file stores
  only counters and timestamps used to calculate the relationship stage.
- **Frontmost-app gate.** macOS LaunchServices supplies only the app display
  name; blocked apps are checked before capture, and window titles/URLs are never requested.

---

## Scripts

```bash
npm run dev        # build, then launch Electron (development)
npm run build      # production build into dist/
npm run typecheck  # tsc --noEmit (strict type checking)
npm test           # privacy-boundary, scheduler/capture-rule, and local-host tests
```

> **Testing note:** the majority of end-to-end testing to date has been done
> against the **Cloud (OpenAI)** provider. Local (Ollama) paths follow the same
> code, but have seen less real-world exercise — feedback welcome.

---

## Future

Ideas explicitly **not** part of Phase 1, and not promised:

- **Hosted proxy.** A real server-side option is a business/operational decision,
  not a code toggle. If it ever happens, it will run as a proper service — it will
  **never bake a shared key into the app**.
- **Windows support.**
- **Cloud sync** of settings.

### Long-term vision

In the long run, Rocky is intended to grow into a true ambient collaborator: one
that builds up richer context about you over time and can act on your behalf —
scheduling, reminders, research, and lightweight task execution — just like Rocky
himself would, working alongside you as a trusted engineering partner rather than
a passive observer.

---

## Privacy & security recap

- **No API key in the repo** — and there never will be one. Cloud users bring
  their own.
- **`.env` is git-ignored**; copy from `.env.example` if you want to use it.
- **Cloud keys are stored encrypted** in the macOS Keychain via `safeStorage`,
  and are **never logged**.
- **Screenshots live in memory only** — they are **never written to disk** and
  image bytes are never logged.
- **Understanding is high-level only** — Rocky never transcribes or repeats
  on-screen text, and looks away from anything sensitive.
- **Blocked apps are skipped before capture**, based only on the frontmost app's
  display name.
- **Relationship memory contains counters and timestamps only** and can be reset
  from Rocky Lab.

---

## License and character rights

The software implementation is MIT licensed. Project Hail Mary characters,
names, likenesses, and other underlying IP remain the property of their
respective rights holders and are not granted by the software license. Deploy or
distribute the character experience only under appropriate authorization.
