/**
 * `yoink-bridge keygen`: a fresh key for local development (`.dev.vars`). In
 * production the key comes from yoink ("Bridge einrichten"). Node-only.
 */
import { chmod, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { hasSecretLine, readIfExists, SECRET_ENV_VAR, UsageError, type CliIO } from './cli-shared.ts';
import { generateSecret } from './link.ts';

export interface KeygenArgs {
  /** Write the key into this dotenv file (fills an empty `KEY_FROM_YOINK_APP=` line, else appends). */
  envFile?: string;
}

/** Parses the arguments after `keygen`. */
export function parseKeygenArgs(argv: string[]): KeygenArgs {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, strict: true, allowPositionals: false, options: { 'env-file': { type: 'string' } } }));
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  return { envFile: values['env-file'] };
}

const EMPTY_LINE = new RegExp(`^([ \\t]*(?:export[ \\t]+)?${SECRET_ENV_VAR}[ \\t]*=)[ \\t]*(?:""|'')?[ \\t]*(?:#.*)?$`, 'm');

/** `text` with the key filled into its empty `KEY_FROM_YOINK_APP=` line, or appended. */
export function withSecretLine(text: string, secret: string): string {
  if (EMPTY_LINE.test(text)) return text.replace(EMPTY_LINE, `$1${secret}`);
  const separator = text.length > 0 && !text.endsWith('\n') ? '\n' : '';
  return `${text}${separator}${SECRET_ENV_VAR}=${secret}\n`;
}

const DEV_ONLY =
  'For local development only (wrangler dev, check, send). Your deployed bridge uses the key yoink\n' +
  'created: Einstellungen › Ausgänge › Bridge einrichten › Schlüssel kopieren.\n';

/** Runs `keygen`; returns the exit code. */
export async function runKeygen(argv: string[], io: CliIO): Promise<number> {
  const args = parseKeygenArgs(argv);
  const secret = generateSecret(io.randomBytes);
  if (args.envFile === undefined) {
    // The key alone on stdout (`>> .dev.vars` works), the note on stderr.
    io.stdout(`${SECRET_ENV_VAR}=${secret}\n`);
    io.stderr(DEV_ONLY);
    return 0;
  }
  const existing = await readIfExists(args.envFile);
  if (hasSecretLine(existing)) {
    throw new UsageError(
      `${args.envFile} already sets ${SECRET_ENV_VAR}. Remove that line first if you want a new key ` +
        '(the old one stops working wherever it is used).',
    );
  }
  await writeFile(args.envFile, withSecretLine(existing, secret), { mode: 0o600 });
  await chmod(args.envFile, 0o600); // also when the file already existed: it now holds a key
  io.stdout(`Wrote a new ${SECRET_ENV_VAR} to ${args.envFile}. Keep that file out of version control.\n`);
  io.stderr(DEV_ONLY);
  return 0;
}
