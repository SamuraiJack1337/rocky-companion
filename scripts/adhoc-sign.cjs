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
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], {
    stdio: 'inherit',
  });
  execFileSync('codesign', ['--verify', '--deep', appPath], { stdio: 'inherit' });
};
