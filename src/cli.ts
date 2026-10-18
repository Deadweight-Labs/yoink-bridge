#!/usr/bin/env node
// Runs as is with Node 22.18+ (type stripping): `node src/cli.ts --help`, or `npm run cli -- --help`.
import { runCli } from './run-cli.ts';

process.exitCode = await runCli(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  isTTY: Boolean(process.stdout.isTTY),
});
