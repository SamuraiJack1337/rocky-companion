// Creature skin discovery + loading (main process). Skins live in
// userData/skins/<name>/ as a skin.json manifest plus image file(s). The
// renderer can't read the filesystem (contextIsolation + strict CSP), so main
// reads the manifest and inlines every referenced image as a data URL, which
// the renderer draws (img-src 'self' data: allows this). This is the drop-in
// path for licensed/official art or AI-generated stills — no code changes.

import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import type { SkinManifest, SkinInfo, LoadedSkin } from '../shared/types';
import { PROCEDURAL_SKIN } from '../shared/types';

/** Absolute path to the user's skins directory. */
function skinsDir(): string {
  return path.join(app.getPath('userData'), 'skins');
}

/** A safe single path segment (no traversal, no separators). */
function isSafeSegment(name: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(name) && name !== '.' && name !== '..';
}

/** Guess an image mime from a filename extension. */
function mimeFor(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  switch (ext) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.gif':
      return 'image/gif';
    default:
      return 'application/octet-stream';
  }
}

/** Read + parse a skin's manifest, or null if missing/invalid. */
function readManifest(name: string): SkinManifest | null {
  if (!isSafeSegment(name)) return null;
  try {
    const file = path.join(skinsDir(), name, 'skin.json');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as SkinManifest;
    if (!parsed || (parsed.type !== 'frames' && parsed.type !== 'sprite')) return null;
    if (!parsed.states || typeof parsed.states !== 'object') return null;
    parsed.name = name; // trust the folder name as the id
    return parsed;
  } catch {
    return null;
  }
}

/** List selectable skins: the built-in procedural creature plus valid folders. */
export function listSkins(): SkinInfo[] {
  const skins: SkinInfo[] = [
    { name: PROCEDURAL_SKIN, displayName: 'Rocky — faceless procedural', builtIn: true },
  ];
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(skinsDir(), { withFileTypes: true });
  } catch {
    return skins; // no skins dir yet
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !isSafeSegment(entry.name)) continue;
    const manifest = readManifest(entry.name);
    if (!manifest) continue;
    skins.push({
      name: entry.name,
      displayName: manifest.displayName || entry.name,
      builtIn: false,
    });
  }
  return skins;
}

/** Collect every image filename a manifest references. */
function referencedFiles(manifest: SkinManifest): string[] {
  const names = new Set<string>();
  if (manifest.type === 'sprite' && manifest.image) {
    names.add(path.basename(manifest.image));
  } else {
    for (const spec of Object.values(manifest.states)) {
      for (const f of spec.files ?? []) names.add(path.basename(f));
    }
  }
  return [...names];
}

/**
 * Load a skin: its manifest plus every referenced image inlined as a data URL.
 * Returns null for the built-in procedural skin, or on any error (caller then
 * keeps the procedural creature).
 */
export function loadSkin(name: string): LoadedSkin | null {
  if (!name || name === PROCEDURAL_SKIN) return null;
  const manifest = readManifest(name);
  if (!manifest) return null;

  const dir = path.join(skinsDir(), name);
  const assets: Record<string, string> = {};
  try {
    for (const filename of referencedFiles(manifest)) {
      const safe = path.basename(filename);
      const buffer = fs.readFileSync(path.join(dir, safe));
      assets[safe] = `data:${mimeFor(safe)};base64,${buffer.toString('base64')}`;
    }
  } catch {
    return null; // a referenced image is missing/unreadable
  }
  if (Object.keys(assets).length === 0) return null;
  return { manifest, assets };
}

/**
 * Directory holding the skins that ship bundled with the app. In a packaged
 * build these are copied in via electron-builder `extraResources` (to
 * <resources>/skins). In development we read them straight from the repo's
 * samples/skins folder, so `npm start` behaves like a real install.
 */
function bundledSkinsDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'skins')
    : path.join(app.getAppPath(), 'samples', 'skins');
}

/**
 * On first run, copy each bundled skin into the user's skins directory (unless
 * a folder of that name already exists — we never clobber a user's own art).
 * This is what makes the official Rocky skin appear on a fresh install instead
 * of the procedural fallback. Best-effort and fully silent: any failure just
 * leaves the procedural creature in place.
 */
export function seedBundledSkins(): void {
  const source = bundledSkinsDir();
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(source, { withFileTypes: true });
  } catch {
    return; // nothing bundled (or not readable)
  }

  const dest = skinsDir();
  try {
    fs.mkdirSync(dest, { recursive: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !isSafeSegment(entry.name)) continue;
    const from = path.join(source, entry.name);
    // Only treat a folder as a skin if it carries a manifest.
    if (!fs.existsSync(path.join(from, 'skin.json'))) continue;
    const to = path.join(dest, entry.name);
    if (fs.existsSync(to)) continue; // already installed — leave user copy alone
    try {
      fs.cpSync(from, to, { recursive: true });
    } catch {
      /* skip this skin; keep going with the rest */
    }
  }
}

/** Open the skins directory in the OS file manager (creating it if needed). */
export async function openSkinsFolder(): Promise<void> {
  const dir = skinsDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* ignore */
  }
  const { shell } = await import('electron');
  await shell.openPath(dir);
}
