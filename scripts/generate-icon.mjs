// One-time dev script: render the procedural creature to build/icon.icns.
//
// Run with:  npm run build && npx electron scripts/generate-icon.mjs
//
// It loads the companion renderer's browser preview (?preview) in an offscreen
// 1024x1024 transparent window, hides the translator bubble and quick-control
// dot, captures a frame, emits the full icon.iconset ladder, and shells out to
// macOS `iconutil` to produce the .icns. The result is committed; CI never
// runs this.

import { app, BrowserWindow, nativeImage } from 'electron';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const indexHtml = path.join(root, 'dist', 'renderer', 'index.html');
const buildDir = path.join(root, 'build');
const iconsetDir = path.join(buildDir, 'icon.iconset');
const icnsPath = path.join(buildDir, 'icon.icns');

const SIZE = 1024;
/** Render at this square size; the creature's leg span uses nearly the full
 *  window width, so the whole frame IS the icon composition. */
const RENDER = 1400;
/** iconset ladder: [filename suffix, pixel size]. */
const LADDER = [
  ['16x16', 16],
  ['16x16@2x', 32],
  ['32x32', 32],
  ['32x32@2x', 64],
  ['128x128', 128],
  ['128x128@2x', 256],
  ['256x256', 256],
  ['256x256@2x', 512],
  ['512x512', 512],
  ['512x512@2x', 1024],
];

async function main() {
  if (!fs.existsSync(indexHtml)) {
    console.error('dist/renderer/index.html missing — run `npm run build` first.');
    app.exit(1);
    return;
  }

  const win = new BrowserWindow({
    width: RENDER,
    height: RENDER,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: true },
  });

  await win.loadFile(indexHtml, { query: { icon: '1' } });
  // Icon wants only the creature: hide the translator and the control dot,
  // and let the pose tween settle into a readable silhouette.
  await win.webContents.executeJavaScript(`
    for (const id of ['speech-bubble', 'control-toggle', 'control-popover']) {
      const node = document.getElementById(id);
      if (node) node.style.display = 'none';
    }
    true;
  `);
  await new Promise((resolve) => setTimeout(resolve, 2500));

  const shot = await win.webContents.capturePage();
  const source = shot.resize({ width: SIZE, height: SIZE });

  fs.rmSync(iconsetDir, { recursive: true, force: true });
  fs.mkdirSync(iconsetDir, { recursive: true });
  for (const [suffix, px] of LADDER) {
    const img = px === SIZE ? source : source.resize({ width: px, height: px });
    fs.writeFileSync(path.join(iconsetDir, `icon_${suffix}.png`), img.toPNG());
  }

  execFileSync('iconutil', ['-c', 'icns', iconsetDir, '-o', icnsPath]);
  fs.rmSync(iconsetDir, { recursive: true, force: true });
  console.log(`wrote ${icnsPath}`);
  app.exit(0);
}

app.whenReady().then(() =>
  main().catch((err) => {
    console.error(err);
    app.exit(1);
  }),
);
