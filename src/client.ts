/** Shared client side of `check` and `send`: talk to a bridge like yoink does. Node-only. */
import {
  promptHidden,
  readIfExists,
  SECRET_ENV_VAR,
  secretFromEnvText,
  UsageError,
  type CliIO,
} from './cli-shared.ts';
import { decodeSecret, signWebhook } from './signature.ts';
import { SDK_VERSION } from './version.ts';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** `https://`, or `http://` on localhost (e.g. `wrangler dev`). */
export function validateToolUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new UsageError(`--url is not a valid URL: ${input}`);
  }
  const local = url.protocol === 'http:' && LOOPBACK.has(url.hostname);
  if (url.protocol !== 'https:' && !local) {
    throw new UsageError('--url must start with https:// (http:// only for localhost)');
  }
  if (url.username || url.password) throw new UsageError('--url must not contain a username or password');
  return url.href;
}

/**
 * The key to sign with: `--secret`; else `YOINK_SECRET` from `--env-file` or
 * the environment (an `--env-file` without it is an error); else, without
 * `--env-file`, asked for (hidden) on a terminal.
 */
export async function resolveSecret(args: { secret?: string; envFile?: string }, io: CliIO): Promise<string> {
  const fromEnv = () => (io.env ?? process.env)[SECRET_ENV_VAR]?.trim() || undefined;
  let secret: string | undefined;
  let source: string;
  if (args.secret !== undefined) {
    secret = args.secret.trim();
    source = '--secret';
  } else if (args.envFile !== undefined) {
    secret = secretFromEnvText(await readIfExists(args.envFile));
    source = `${SECRET_ENV_VAR} in ${args.envFile}`;
    if (secret === undefined) {
      secret = fromEnv();
      source = SECRET_ENV_VAR;
    }
    if (secret === undefined) {
      throw new UsageError(
        `${args.envFile} does not set ${SECRET_ENV_VAR}, and it is not in the environment either ` +
          '(for local development: npm run keygen)',
      );
    }
  } else {
    secret = fromEnv();
    source = SECRET_ENV_VAR;
    if (secret === undefined) {
      secret = (await (io.readSecret ?? promptHidden)('Key (whsec_…): ')).trim();
      source = 'the key';
    }
  }
  if (!secret) throw new UsageError(`${source} is empty`);
  try {
    decodeSecret(secret);
  } catch {
    throw new UsageError(`${source} is not a valid whsec_… key`);
  }
  return secret;
}

/** Current time as yoink writes it: ISO-8601 UTC without milliseconds. */
export function isoSeconds(date = new Date()): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export interface SignedResult {
  id: string;
  status: number;
  text: string;
  /** `Retry-After` of the answer, if any. */
  retryAfter?: string;
}

/** Signs `body` with the key and POSTs it like yoink (no redirects, 15 s timeout). Throws on network errors. */
export async function postSigned(
  url: string,
  secret: string,
  body: string,
  idPrefix: string,
  io: CliIO,
): Promise<SignedResult> {
  const id = `msg_${idPrefix}_${Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('')}`;
  const timestamp = Math.floor(Date.now() / 1000);
  const doFetch = io.fetch ?? ((input: string, init: RequestInit) => fetch(input, init));
  const response = await doFetch(url, {
    method: 'POST',
    redirect: 'manual', // yoink does not follow redirects either
    signal: AbortSignal.timeout(15_000),
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'user-agent': `yoink-bridge/${SDK_VERSION} (${idPrefix})`,
      'webhook-id': id,
      'webhook-timestamp': String(timestamp),
      'webhook-signature': await signWebhook({ secret, id, timestamp, body }),
    },
    body,
  });
  const text = await response.text().catch(() => '');
  return { id, status: response.status, text, retryAfter: response.headers.get('retry-after') ?? undefined };
}

/** One line explaining a failed answer, as yoink would treat it. */
export function failureMessage(url: string, status: number, text: string): string {
  const detail = text.trim() ? `: ${text.trim().slice(0, 300)}` : '';
  let hint = '';
  if (status >= 300 && status < 400) hint = '\nyoink does not follow redirects; use the final URL.';
  else if (status === 401 || status === 403) {
    hint = `\nThe bridge rejected the signature. Is ${SECRET_ENV_VAR} the same key on both sides, and is this computer’s clock right?`;
  } else if (status === 404 || status === 410) hint = '\nyoink would pause this connection as unreachable.';
  return `yoink-bridge: ${url} answered ${status}${detail}${hint}\n`;
}
