/** Keys and connection links (PROTOCOL.md §2, §9). Web APIs only. */
import { base64ToBytes, bytesToBase64 } from './signature.ts';

const defaultRandomBytes = (size: number): Uint8Array => crypto.getRandomValues(new Uint8Array(size));

/**
 * A fresh key: `whsec_` + base64 of 32 random bytes, the same shape yoink
 * creates in "Bridge einrichten". In production the key comes from yoink; use
 * this for local development and tests.
 */
export function generateSecret(randomBytes: (size: number) => Uint8Array = defaultRandomBytes): string {
  const bytes = randomBytes(32);
  if (bytes.length !== 32) throw new Error('randomBytes returned the wrong length');
  return `whsec_${bytesToBase64(bytes)}`;
}

/**
 * Why `value` is not a key as yoink creates it, or `null` if it is one:
 * `'missing'` for nothing or blank, `'invalid'` for anything but `whsec_` +
 * base64 of 32 bytes. Surrounding whitespace is ignored (a pasted key often
 * ends in a newline). The value itself never appears in the result.
 */
export function secretProblem(value: unknown): 'missing' | 'invalid' | null {
  if (value === undefined || value === null) return 'missing';
  if (typeof value !== 'string') return 'invalid';
  const trimmed = value.trim();
  if (!trimmed) return 'missing';
  if (!trimmed.startsWith('whsec_')) return 'invalid';
  return base64ToBytes(trimmed.slice('whsec_'.length))?.length === 32 ? null : 'invalid';
}

export interface SetupLinkOptions {
  /** The bridge's public `https://` URL. */
  url: string;
  /** Name of the connection in yoink, used if the bridge's manifest sets none. */
  name?: string;
}

/**
 * The connection link `yoink://ausgang?v=1&url=…&name=…`. It never carries a
 * key: yoink signs with the key it created itself. Values are percent-encoded
 * with `encodeURIComponent` (spaces as `%20`, never `+`), as PROTOCOL.md §9
 * requires; an empty `name` is left out.
 */
export function buildSetupLink(options: SetupLinkOptions): string {
  const params: [string, string][] = [
    ['v', '1'],
    ['url', options.url],
  ];
  if (options.name?.trim()) params.push(['name', options.name.trim()]);
  const query = params.map(([key, value]) => `${key}=${encode(value)}`).join('&');
  return `yoink://ausgang?${query}`;
}

function encode(value: string): string {
  try {
    return encodeURIComponent(value);
  } catch {
    throw new TypeError('connection link values must be valid Unicode text');
  }
}
