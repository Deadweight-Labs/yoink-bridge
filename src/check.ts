/**
 * `yoink-bridge check`: sends a signed `ping` exactly like yoink does and
 * shows the destinations yoink will read from the answer. Node-only.
 */
import { parseArgs } from 'node:util';
import { UsageError, type CliIO } from './cli-shared.ts';
import { failureMessage, isoSeconds, postSigned, resolveSecret, validateToolUrl } from './client.ts';
import { describeBridge, MANIFEST_LIMITS } from './manifest.ts';
import { SDK_VERSION } from './version.ts';

export { validateToolUrl as validateCheckUrl } from './client.ts';

export interface CheckArgs {
  url: string;
  envFile?: string;
  /** The key, if given with `--secret`. */
  secret?: string;
}

/** Parses the arguments after `check`. */
export function parseCheckArgs(argv: string[]): CheckArgs {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: { url: { type: 'string' }, 'env-file': { type: 'string' }, secret: { type: 'string' } },
    }));
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  if (!values.url) throw new UsageError('--url is required');
  return { url: validateToolUrl(values.url), envFile: values['env-file'], secret: values.secret };
}

/** A ping body as yoink sends it. */
export function pingBody(build: string): string {
  return JSON.stringify({
    version: 1,
    type: 'ping',
    timestamp: isoSeconds(),
    data: {
      app: { name: 'yoink', build },
      connection: { id: 'yoink-bridge-check', name: 'yoink-bridge check' },
    },
  });
}

/** Runs `check` with the arguments after the command; returns the exit code. */
export async function runCheck(argv: string[], io: CliIO): Promise<number> {
  const args = parseCheckArgs(argv);
  const secret = await resolveSecret(args, io);
  let result;
  try {
    result = await postSigned(args.url, secret, pingBody(`yoink-bridge check ${SDK_VERSION}`), 'check', io);
  } catch (error) {
    io.stderr(`yoink-bridge: could not reach ${args.url}: ${(error as Error).message ?? String(error)}\n`);
    return 1;
  }
  const { status, text } = result;
  if (status >= 200 && status < 300) {
    io.stdout(`${args.url} answered ${status}: URL and key work.\n\n${describeBridge(text)}`);
    if (new TextEncoder().encode(text).length > MANIFEST_LIMITS.bytes) {
      io.stdout(`\nThe answer is over ${MANIFEST_LIMITS.bytes} bytes; yoink reads no more than that.\n`);
    }
    return 0;
  }
  io.stderr(failureMessage(args.url, status, text));
  return 1;
}
