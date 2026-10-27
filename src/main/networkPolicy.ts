import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/** True when an address is local, private, reserved, or otherwise non-public. */
export function isPrivateOrReservedIp(address: string): boolean {
  const value = address.toLowerCase().split('%')[0];
  if (value.startsWith('::ffff:')) return isPrivateOrReservedIp(value.slice(7));
  if (isIP(value) === 4) {
    const [a, b] = value.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0) ||
      a >= 224
    );
  }
  if (isIP(value) === 6) {
    return (
      value === '::' || value === '::1' ||
      value.startsWith('fc') || value.startsWith('fd') ||
      /^fe[89ab]/.test(value) || value.startsWith('ff') ||
      value.startsWith('2001:db8:')
    );
  }
  return true;
}

/** Resolve an http(s) URL and allow it only when every answer is public. */
export async function validatePublicHttpUrl(raw: string): Promise<URL | null> {
  try {
    const url = new URL(raw);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
      return null;
    }
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
      return null;
    }
    if (isIP(host)) return isPrivateOrReservedIp(host) ? null : url;
    const answers = await lookup(host, { all: true, verbatim: true });
    if (answers.length === 0 || answers.some((answer) => isPrivateOrReservedIp(answer.address))) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}
