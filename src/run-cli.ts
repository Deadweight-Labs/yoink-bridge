/** Command dispatcher of the `yoink-bridge` CLI (Node-only). */
import { runCheck } from './check.ts';
import { SECRET_ENV_VAR, UsageError, type CliIO } from './cli-shared.ts';
import { runKeygen } from './keygen.ts';
import { runSend } from './send.ts';
import { SDK_VERSION } from './version.ts';

export const USAGE = `Usage:
  yoink-bridge check  --url <bridge-url> [--env-file <path> | --secret <whsec_…>]
  yoink-bridge send   --url <bridge-url> [--env-file <path> | --secret <whsec_…>] [--text <text>]
                      [--title <title>] [--project <name>] [--destination <id>] [--trigger manual|suggestion|auto]
                      [--update <new text>]
  yoink-bridge keygen [--env-file <path>]

With the npm scripts: npm run cli -- <command> …  (npm run check, send and keygen use
http://localhost:8787 and .dev.vars, for wrangler dev).

Commands:
  check   Send a signed ping like yoink does and show the destinations yoink will read.
  send    Send a signed test entry to a destination and show the receipt.
  keygen  Make a key for local development (.dev.vars). Your deployed bridge uses the key
          yoink created: Einstellungen › Ausgänge › Bridge einrichten › Schlüssel kopieren.

check and send options:
  --url <bridge-url>    URL of your bridge (http:// is allowed for localhost, e.g. wrangler dev)
  --env-file <path>     Read ${SECRET_ENV_VAR} from this file (e.g. .dev.vars)
  --secret <whsec_…>    The key itself. It ends up in your shell history: prefer --env-file,
                        ${SECRET_ENV_VAR} in the environment, or typing it when asked
                        (without any of these, the key is asked for on the terminal)

send options:
  --text <text>         Entry text (default "Test für meine Bridge")
  --title, --project    Entry title and project (default none)
  --destination <id>    Destination id; may be left out if the bridge has only one
  --trigger <value>     manual (default), suggestion or auto
  --update <new text>   Then edit it: send an entry.update with this text for the same delivery,
                        as yoink does 2 minutes after an edit (Linear/GitHub: a comment)

keygen options:
  --env-file <path>     Write ${SECRET_ENV_VAR}=… into this file (fills an empty ${SECRET_ENV_VAR}= line,
                        else appends; refuses if it already has a key). Without it, prints the line.

  -h, --help            Show this help
  -v, --version         Show the version
`;

const COMMANDS: Record<string, (argv: string[], io: CliIO) => Promise<number>> = {
  check: runCheck,
  send: runSend,
  keygen: runKeygen,
};

/** Runs the CLI and returns the exit code. */
export async function runCli(argv: string[], io: CliIO): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined) {
    io.stderr(USAGE);
    return 1;
  }
  if (command === '-h' || command === '--help' || command === 'help' || rest.includes('-h') || rest.includes('--help')) {
    io.stdout(USAGE);
    return 0;
  }
  if (command === '-v' || command === '--version') {
    io.stdout(`${SDK_VERSION}\n`);
    return 0;
  }
  const run = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : undefined;
  if (!run) {
    io.stderr(`Unknown command: ${command}\n\n${USAGE}`);
    return 1;
  }
  try {
    return await run(rest, io);
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`yoink-bridge: ${error.message}\n\nRun "yoink-bridge --help" for usage.\n`);
    } else {
      io.stderr(`yoink-bridge: ${(error as Error).message ?? String(error)}\n`);
    }
    return 1;
  }
}
