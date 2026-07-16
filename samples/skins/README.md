# Creature skins — asset delivery format for Rocky Companion

This folder holds the **official Rocky skin**, a complete drop-in creature skin:

- **`rocky-hq/`** — the official Rocky art (high-fidelity per-mood frames).

It ships bundled with the app and is seeded into your skins directory on first
run, so a fresh install shows the official creature automatically. Any skin that
follows the same structure works with **zero code changes**.

## How to install a skin

Copy the whole folder (images + `skin.json`) into the app's skins directory:

```
~/Library/Application Support/rocky-companion/skins/<skin-name>/
```

(Settings → skin picker has an "open skins folder" button that takes you
there.) Then pick the skin in **Settings**. The folder name is the skin's id;
`displayName` in `skin.json` is what the picker shows.

## Option A — per-mood image frames (these samples)

`skin.json`:

```json
{
  "displayName": "Rocky",
  "type": "frames",
  "fps": 6,
  "states": {
    "idle":      { "files": ["idle-1.png", "idle-2.png", "idle-3.png"], "fps": 3 },
    "talk":      { "files": ["talk-1.png", "talk-2.png", "talk-3.png"], "fps": 8 },
    "curious":   { "files": ["curious-1.png", "curious-2.png"], "fps": 3 },
    "concerned": { "files": ["concerned-1.png", "concerned-2.png"], "fps": 3 },
    "sleep":     { "files": ["sleep-1.png", "sleep-2.png"], "fps": 1 },
    "greet":     { "files": ["greet-1.png", "greet-2.png"], "fps": 4 }
  }
}
```

- Each state lists image files played in order at `fps` (state-level `fps`
  overrides the top-level default of 8). `"loop": false` plays once and holds
  the last frame.
- A **single still per state is fine** — the app adds a subtle breathing/bob
  motion so even one image feels alive (`rocky-hq` does this for `idle`).

## Option B — one sprite sheet

```json
{
  "displayName": "Rocky",
  "type": "sprite",
  "image": "sheet.png",
  "frameWidth": 512,
  "frameHeight": 512,
  "columns": 4,
  "fps": 8,
  "states": {
    "idle": { "frames": [0, 1, 2] },
    "talk": { "frames": [4, 5, 6], "fps": 10 }
  }
}
```

Frames are numbered left-to-right, top-to-bottom in a uniform grid.

## Which states to deliver

**Moods** (core set): `idle`, `talk`, `curious`, `concerned`, `sleep`.
Only `idle` is truly required — missing states fall back to `idle`.

**Gestures** (optional, take priority over moods when present): `observe`,
`listen`, `calculate`, `build`, `delight`, `alarm`, `protect`, `rest`,
`greet`, `fistBump`, `watch`, `farewell`. These samples include `greet` as a
demonstration.

## Image requirements

- **PNG with transparent background** preferred (JPEG/WebP/GIF also load).
- Square canvas, creature centered with a little margin; **512–1024 px**
  is plenty (it renders in a ~220 px stage, scaled with device pixel ratio).
- Keep every image in the same folder as `skin.json`; the manifest references
  bare filenames.
- File/folder names: letters, digits, `.`, `_`, `-` only.
