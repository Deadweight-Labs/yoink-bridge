/** Shared bits of the Node-only CLI. */
import { readFile } from 'node:fs/promises';

/** The bridge's key: the env var `defineWorkerBridge` reads, and the line in `.dev.vars`. */
export const SECRET_ENV_VAR = 'KEY_FROM_YOINK_APP';

/** A problem with the command line; reported without a stack trace. */
export class UsageError extends Error {
  override name = 'UsageError';
}

export interface CliIO {
  stdout(text: string): void;
  stderr(text: string): void;
  /** Whether stdout is a terminal. */
  isTTY: boolean;
  randomBytes?: (size: number) => Uint8Array;
  /** Environment variables (default: `process.env`). */
  env?: Record<string, string | undefined>;
  /** `fetch` used by `check` and `send` (default: the global one). */
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
  /** Asks for the key without echoing it (default: on the terminal). */
  readSecret?: (prompt: string) => Promise<string>;
}

/** Reads a line from the terminal without echoing it. */
export function promptHidden(prompt: string): Promise<string> {
  const { stdin, stderr } = process;
  if (!stdin.isTTY) {
    return Promise.reject(
      new UsageError(`set ${SECRET_ENV_VAR}, pass --env-file or --secret (there is no terminal to ask for the key)`),
    );
  }
  stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      stderr.write('\n');
    };
    const onData = (chunk: string) => {
      for (const c of chunk) {
        if (c === '\r' || c === '\n') {
          finish();
          resolve(value);
          return;
        }
        if (c === '\u0003') {
          finish();
          reject(new UsageError('cancelled'));
          return;
        }
        if (c === '\u007f' || c === '\b') value = value.slice(0, -1);
        else value += c;
      }
    };
    stdin.on('data', onData);
  });
}

export async function readIfExists(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

/** A value from a dotenv-style file text (`.env`, `.dev.vars`), or `undefined`. */
export function valueFromEnvText(text: string, name: string): string | undefined {
  const match = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=(.*)$`, 'm').exec(text);
  if (!match) return undefined;
  // As dotenv reads it: a quoted value ends at its closing quote; unquoted, `#` starts a comment.
  const raw = match[1]!.trim();
  const quoted = /^(['"`])(.*?)\1/.exec(raw);
  const value = quoted ? quoted[2]!.trim() : raw.replace(/#.*$/, '').trim();
  return value || undefined;
}

/** Whether a dotenv-style file text already sets the key to a value. */
export function hasSecretLine(text: string): boolean {
  return secretFromEnvText(text) !== undefined;
}

/** The key from a dotenv-style file text, or `undefined`. */
export function secretFromEnvText(text: string): string | undefined {
  return valueFromEnvText(text, SECRET_ENV_VAR);
}
