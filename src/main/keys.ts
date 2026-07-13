// Encrypted storage for the user's OpenAI API key (BYOK / cloud provider).
// The key is NEVER written to settings.json and NEVER logged. We use Electron's
// safeStorage, which is backed by the OS keychain (macOS Keychain), to encrypt
// the plaintext into an opaque Buffer; only that ciphertext is written to disk
// at userData/openai-key.enc. If encryption isn't available, we refuse to store
// rather than fall back to plaintext.

import { app, safeStorage } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import type { KeyResult } from '../shared/types';

/** Absolute path to the encrypted key file inside userData. */
function keyFilePath(): string {
  return path.join(app.getPath('userData'), 'openai-key.enc');
}

/** Read + decrypt the stored ciphertext, or null if absent/undecryptable. */
function readStoredKey(): string | null {
  let encrypted: Buffer;
  try {
    encrypted = fs.readFileSync(keyFilePath());
  } catch {
    return null; // No stored key.
  }
  if (encrypted.length === 0) return null;
  if (!safeStorage.isEncryptionAvailable()) return null;
  try {
    const plain = safeStorage.decryptString(encrypted);
    return plain.length > 0 ? plain : null;
  } catch {
    // Stale/corrupt ciphertext (e.g. keychain reset) — treat as no key.
    return null;
  }
}

/** True if a usable OpenAI key is available (stored ciphertext or env var). */
export function hasOpenAIKey(): boolean {
  return getOpenAIKey() !== null;
}

/**
 * Return the OpenAI key in plaintext for use by the cloud provider.
 * Precedence: the encrypted stored key, then process.env.OPENAI_API_KEY,
 * then null. The returned value must never be logged.
 */
export function getOpenAIKey(): string | null {
  const stored = readStoredKey();
  if (stored) return stored;
  const fromEnv = process.env.OPENAI_API_KEY?.trim();
  return fromEnv ? fromEnv : null;
}

/**
 * Encrypt and persist a user-supplied key. Trims surrounding whitespace.
 * Refuses (without writing) if OS-backed encryption isn't available, or if the
 * trimmed input is empty. Returns a KeyResult; never throws on the happy path.
 */
export function setOpenAIKey(plain: string): KeyResult {
  const trimmed = (plain ?? '').trim();
  if (!trimmed) {
    return { ok: false, error: 'Key is empty.' };
  }
  if (!safeStorage.isEncryptionAvailable()) {
    return {
      ok: false,
      error: 'Secure storage is unavailable on this system, so the key cannot be saved safely.',
    };
  }
  try {
    const encrypted = safeStorage.encryptString(trimmed);
    const target = keyFilePath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // Owner-only permissions; only the encrypted Buffer is written.
    fs.writeFileSync(target, encrypted, { mode: 0o600 });
    return { ok: true };
  } catch (err) {
    // Deliberately do NOT include the key or full error detail that might echo it.
    return { ok: false, error: `Failed to save key: ${(err as Error).message}` };
  }
}

/** Remove the stored encrypted key, if any. No-op when absent. */
export function deleteOpenAIKey(): void {
  try {
    fs.rmSync(keyFilePath(), { force: true });
  } catch {
    // Best-effort; nothing actionable if removal fails.
  }
}
