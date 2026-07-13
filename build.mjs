// Build script for Rocky Companion.
//
// Bundles three independent surfaces with esbuild and copies static assets:
//   - main process   : src/main/main.ts      -> dist/main/main.js      (node/cjs)
//   - preload bridge  : src/main/preload.ts   -> dist/main/preload.js   (node/cjs)
//   - renderer entries: src/renderer/*.ts     -> dist/renderer/*.js     (browser/iife)
//
// Flags:
//   --dev    build, then launch Electron
//   --watch  rebuild on change (with --dev, restarts Electron on main changes)
//
// Kept intentionally light: esbuild + a tiny copy step, no bundler framework.

import * as esbuild from 'esbuild';
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEV = process.argv.includes('--dev');
const WATCH = process.argv.includes('--watch');

const OUT = path.join(__dirname, 'dist');
const RENDERER_OUT = path.join(OUT, 'renderer');
const STATIC = ['index.html', 'consent.html', 'settings.html', 'lab.html', 'styles.css'];

/** Copy renderer static assets (HTML/CSS) into dist/renderer. */
function copyStatic() {
  mkdirSync(RENDERER_OUT, { recursive: true });
  for (const file of STATIC) {
    const src = path.join(__dirname, 'src', 'renderer', file);
    if (existsSync(src)) cpSync(src, path.join(RENDERER_OUT, file));
  }
}

const shared = {
  bundle: true,
  sourcemap: true,
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': JSON.stringify(DEV ? 'development' : 'production') },
};

// Main + preload run in Node (Electron). Keep electron external; bundle the rest.
const nodeConfig = {
  ...shared,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['electron'],
  entryPoints: {
    'main/main': path.join(__dirname, 'src', 'main', 'main.ts'),
    'main/preload': path.join(__dirname, 'src', 'main', 'preload.ts'),
  },
  outdir: OUT,
};

// Renderer runs in the browser context (contextIsolation on, no Node).
const rendererConfig = {
  ...shared,
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  entryPoints: {
    companion: path.join(__dirname, 'src', 'renderer', 'companion.ts'),
    settings: path.join(__dirname, 'src', 'renderer', 'settings.ts'),
    consent: path.join(__dirname, 'src', 'renderer', 'consent.ts'),
    lab: path.join(__dirname, 'src', 'renderer', 'lab.ts'),
  },
  outdir: RENDERER_OUT,
};

let electronProc = null;
function launchElectron() {
  if (electronProc) {
    electronProc.removeAllListeners('exit');
    electronProc.kill();
  }
  // Resolve the electron binary path from the installed package.
  const electronBin = process.platform === 'win32'
    ? path.join(__dirname, 'node_modules', '.bin', 'electron.cmd')
    : path.join(__dirname, 'node_modules', '.bin', 'electron');
  // ELECTRON_RUN_AS_NODE (sometimes set by CI/agent shells) would make the
  // Electron binary boot as plain Node, so require('electron') yields a path
  // string instead of the API. Strip it so `npm run dev` works everywhere.
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  electronProc = spawn(electronBin, ['.'], { stdio: 'inherit', cwd: __dirname, env });
  electronProc.on('exit', (code) => {
    if (!WATCH) process.exit(code ?? 0);
  });
}

async function run() {
  copyStatic();

  if (WATCH) {
    const restartPlugin = {
      name: 'relaunch-electron',
      setup(b) {
        b.onEnd(() => {
          copyStatic();
          if (DEV) launchElectron();
        });
      },
    };
    const nodeCtx = await esbuild.context({ ...nodeConfig, plugins: [restartPlugin] });
    const rendererCtx = await esbuild.context(rendererConfig);
    await Promise.all([nodeCtx.watch(), rendererCtx.watch()]);
    console.log('[build] watching for changes…');
  } else {
    await Promise.all([esbuild.build(nodeConfig), esbuild.build(rendererConfig)]);
    copyStatic();
    console.log('[build] done.');
    if (DEV) launchElectron();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
