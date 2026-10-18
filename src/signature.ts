/**
 * Standard Webhooks v1 signing (HMAC-SHA256), Web Crypto only.
 *
 * content   = "<webhook-id>.<webhook-timestamp>.<raw body bytes>"
 * signature = "v1," + base64(HMAC-SHA256(base64decode(secret without "whsec_"), content))
 */

/** Allowed clock difference between `webhook-timestamp` and now, in seconds. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

const SECRET_PREFIX = 'whsec_';
const encoder = new TextEncoder();

/** A Fetch `Headers` object or a plain record (e.g. Node's `req.headers`). */
export type HeadersLike = Headers | Record<string, string | readonly string[] | undefined>;

/** The raw request body, exactly as received. */
export type RawBody = string | Uint8Array | ArrayBuffer;

export interface VerifyWebhookOptions {
  /** `whsec_…` secret (the prefix is optional). */
  secret: string;
  headers: HeadersLike;
  /** Raw body. Never re-serialize parsed JSON: the signature covers the exact bytes. */
  body: RawBody;
  /** Current time in Unix seconds. Defaults to the system clock. */
  now?: number;
  /** Defaults to 300 seconds. */
  toleranceSeconds?: number;
}

export type VerifyFailureReason = 'headers' | 'timestamp' | 'signature';
export type VerifyResult = { ok: true } | { ok: false; reason: VerifyFailureReason };

export interface SignWebhookOptions {
  secret: string;
  id: string;
  /** Unix seconds. */
  timestamp: number;
  body: RawBody;
}

/**
 * Verifies a yoink (Standard Webhooks v1) signature.
 *
 * Fails with `headers` when `webhook-id`, `webhook-timestamp` or
 * `webhook-signature` is missing or malformed, with `timestamp` when the
 * timestamp is more than `toleranceSeconds` away from `now`, and with
 * `signature` when no `v1` signature matches. Signatures are checked with
 * `crypto.subtle.verify`, which compares in constant time.
 *
 * Throws a `TypeError` if the secret itself is not valid base64.
 */
export async function verifyWebhook(options: VerifyWebhookOptions): Promise<VerifyResult> {
  const key = await importSecretKey(options.secret);
  return verifyWithKey(key, options);
}

/** Produces the `webhook-signature` header value (`"v1,<base64>"`). */
export async function signWebhook(options: SignWebhookOptions): Promise<string> {
  const key = await importSecretKey(options.secret);
  const content = signedContent(options.id, String(options.timestamp), toBytes(options.body));
  const mac = new Uint8Array(await subtle().sign('HMAC', key, content));
  return `v1,${bytesToBase64(mac)}`;
}

// ---------------------------------------------------------------------------
// Internals shared with the bridge (not part of the public API).

/** Decodes a `whsec_…` secret to its key bytes. Throws `TypeError` when invalid. */
export function decodeSecret(secret: string): Uint8Array<ArrayBuffer> {
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new TypeError('yoink-bridge: secret is missing');
  }
  const raw = secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : secret;
  const bytes = base64ToBytes(raw);
  if (bytes === null || bytes.length === 0) {
    throw new TypeError('yoink-bridge: secret is not valid base64 (expected whsec_<base64>)');
  }
  return bytes;
}

export function importSecretKey(secret: string): Promise<CryptoKey> {
  const keyBytes = decodeSecret(secret);
  return subtle().importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

export async function verifyWithKey(
  key: CryptoKey,
  options: Omit<VerifyWebhookOptions, 'secret'>,
): Promise<VerifyResult> {
  const id = readHeader(options.headers, 'webhook-id');
  const timestamp = readHeader(options.headers, 'webhook-timestamp');
  const signatureHeader = readHeader(options.headers, 'webhook-signature');
  if (!id || !timestamp || !signatureHeader) return { ok: false, reason: 'headers' };
  if (!/^\d{1,15}$/.test(timestamp)) return { ok: false, reason: 'headers' };

  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > tolerance) return { ok: false, reason: 'timestamp' };

  // Several space-separated signatures are allowed (key rotation on the
  // sender's side); one valid `v1` signature is enough. `crypto.subtle.verify`
  // compares in constant time.
  const content = signedContent(id, timestamp, toBytes(options.body));
  for (const candidate of signatureHeader.split(/\s+/)) {
    const comma = candidate.indexOf(',');
    if (comma === -1 || candidate.slice(0, comma) !== 'v1') continue;
    const mac = base64ToBytes(candidate.slice(comma + 1));
    if (mac !== null && mac.length === 32 && (await subtle().verify('HMAC', key, mac, content))) return { ok: true };
  }
  return { ok: false, reason: 'signature' };
}

/** Case-insensitive header lookup for `Headers` and plain records. */
export function readHeader(headers: HeadersLike, name: string): string | undefined {
  if (typeof (headers as Headers).get === 'function') {
    return (headers as Headers).get(name) ?? undefined;
  }
  const record = headers as Record<string, string | readonly string[] | undefined>;
  let value = record[name];
  if (value === undefined) {
    const lower = name.toLowerCase();
    for (const key of Object.keys(record)) {
      if (key.toLowerCase() === lower) {
        value = record[key];
        break;
      }
    }
  }
  if (value === undefined) return undefined;
  return typeof value === 'string' ? value : value.join(', ');
}

export function toBytes(body: RawBody): Uint8Array {
  if (typeof body === 'string') return encoder.encode(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  throw new TypeError('yoink-bridge: body must be a string, Uint8Array or ArrayBuffer');
}

function signedContent(id: string, timestamp: string, body: Uint8Array): Uint8Array<ArrayBuffer> {
  const prefix = encoder.encode(`${id}.${timestamp}.`);
  const out = new Uint8Array(prefix.length + body.length);
  out.set(prefix, 0);
  out.set(body, prefix.length);
  return out;
}

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) {
    throw new Error(
      'yoink-bridge: Web Crypto (globalThis.crypto.subtle) is not available. ' +
        "On Node 18, import 'yoink-bridge/node' first or upgrade to Node 20+.",
    );
  }
  return s;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

/** Strict base64 decode (standard alphabet, padding optional). `null` when invalid. */
export function base64ToBytes(input: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(input) || input.length % 4 === 1) return null;
  let binary: string;
  try {
    binary = atob(input);
  } catch {
    return null;
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
