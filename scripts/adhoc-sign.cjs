// electron-builder afterPack hook: ad-hoc sign the .app bundle.
//
// `identity: null` skips electron-builder's signing entirely, which leaves the
// app with only the linker signature from the prebuilt Electron binary
// (identifier "Electron", Info.plist not bound, no sealed resources). macOS TCC
// cannot durably attach a Screen Recording grant to a bundle in that state —
// System Settings shows the toggle ON while the app still reads "denied".
//
// A plain ad-hoc signature (`codesign --sign -`) gives the bundle a real
// identity (the appId) that TCC can bind to. It does NOT bypass Gatekeeper —
// users still clear quarantine once per install — and because ad-hoc
// signatures differ per build, macOS asks users to re-grant Screen Recording
// (and re-allow the Safe Storage keychain item) after each update. A real
// Developer ID would fix both; until then this is the minimum viable identity.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  // Universal builds pack per-arch slices into "<out>-x64-temp"/"<out>-arm64-temp"
  // (afterPack fires for each) before merging; signing a slice rewrites its
  // CodeResources and the merge then rejects the non-identical files. Skip the
  // slices — afterPack fires once more on the merged universal app, and that
  // is the copy that ships.
  if (context.appOutDir.endsWith('-temp')) return;
  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);

  // Sign inside-out. The offline-voice (sherpa-onnx) engine ships as a Mach-O
  // binary + onnxruntime dylib under Contents/Resources/piper. The app's
  // `--deep` sign below does NOT reach them — codesign only recurses standard
  // nested-code locations (Frameworks, Helpers, MacOS), not arbitrary files in
  // Resources — so an unsigned/inconsistent nested Mach-O would get
  // Gatekeeper-killed on user Macs. Sign the dylib first, then the executable
  // that links it, so each seal is consistent before the app is sealed over
  // them. (No-op on Windows resources, which have no such dir.)
  const piperDir = path.join(appPath, 'Contents', 'Resources', 'piper');
  if (fs.existsSync(piperDir)) {
    const nested = fs
      .readdirSync(piperDir)
      .filter((f) => f.endsWith('.dylib') || f === 'sherpa-onnx-offline-tts')
      .sort((a, b) => Number(b.endsWith('.dylib')) - Number(a.endsWith('.dylib')))
      .map((f) => path.join(piperDir, f));
    for (const bin of nested) {
      execFileSync('codesign', ['--force', '--sign', '-', bin], { stdio: 'inherit' });
    }
  }

  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], {
    stdio: 'inherit',
  });
  execFileSync('codesign', ['--verify', '--deep', appPath], { stdio: 'inherit' });
};
