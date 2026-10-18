/**
 * `yoink-bridge send`: builds a spec-conformant `entry.send`, signs it and
 * posts it to a bridge, for hacking against `wrangler dev`. With `--update`,
 * then edits it: an `entry.update` with the new text for that delivery.
 * Node-only.
 */
import { parseArgs } from 'node:util';
import { pingBody } from './check.ts';
import { UsageError, type CliIO } from './cli-shared.ts';
import { failureMessage, isoSeconds, postSigned, resolveSecret, validateToolUrl } from './client.ts';
import { parseManifest } from './manifest.ts';
import type { EntrySendEvent, EntryUpdateEvent, KnownTrigger } from './types.ts';
import { SDK_VERSION } from './version.ts';

const TRIGGERS: readonly KnownTrigger[] = ['manual', 'suggestion', 'auto'];

export interface SendArgs {
  url: string;
  envFile?: string;
  text: string;
  title?: string;
  project?: string;
  destination?: string;
  /** Default: `auto` for a destination in mode `all` (as yoink sends it), else `manual`. */
  trigger?: KnownTrigger;
  /** The key, if given with `--secret`. */
  secret?: string;
  /** New text: after the send, an `entry.update` with it follows, as yoink sends one after an edit. */
  update?: string;
}

/** Parses the arguments after `send`. */
export function parseSendArgs(argv: string[]): SendArgs {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        url: { type: 'string' },
        'env-file': { type: 'string' },
        text: { type: 'string' },
        title: { type: 'string' },
        project: { type: 'string' },
        destination: { type: 'string' },
        trigger: { type: 'string' },
        secret: { type: 'string' },
        update: { type: 'string' },
      },
    }));
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  if (!values.url) throw new UsageError('--url is required');
  const trigger = values.trigger as KnownTrigger | undefined;
  if (trigger !== undefined && !TRIGGERS.includes(trigger)) {
    throw new UsageError(`--trigger must be one of ${TRIGGERS.join(', ')}`);
  }
  const text = values.text ?? 'Test für meine Bridge';
  if (!text.trim()) throw new UsageError('--text must not be empty');
  const update = values.update;
  if (update !== undefined && !update.trim()) throw new UsageError('--update must not be empty');
  if (update !== undefined && update.trim() === text.trim()) throw new UsageError('--update must differ from --text');
  return {
    url: validateToolUrl(values.url),
    envFile: values['env-file'],
    text,
    title: values.title,
    project: values.project,
    destination: values.destination,
    trigger,
    secret: values.secret,
    update,
  };
}

/** The `entry.send` event `send` posts (connection id "cli"), shaped like yoink's for that destination's mode. */
export function buildSendEvent(
  args: SendArgs,
  destination: { id: string; name: string; mode?: string },
  now = new Date(),
): EntrySendEvent {
  const at = isoSeconds(now);
  const all = destination.mode === 'all';
  const trigger = args.trigger ?? (all ? 'auto' : 'manual');
  return {
    version: 1,
    type: 'entry.send',
    timestamp: at,
    data: {
      app: { name: 'yoink', build: `yoink-bridge send ${SDK_VERSION}` },
      connection: { id: 'cli', name: 'yoink-bridge send' },
      destination: { id: destination.id, name: destination.name },
      trigger,
      entry: {
        id: crypto.randomUUID(),
        title: args.title?.trim() || null,
        text: args.text,
        project: args.project?.trim() || null,
        type: 'note',
        due: null,
        created_at: at,
        source_url: null,
        attachments: [],
      },
      // No check ran when sent by hand or in mode "all"; otherwise pretend a confident match.
      fit: trigger === 'manual' || all ? null : { probability: 0.95 },
    },
  };
}

/**
 * The `entry.update` yoink would send after the text of `sent` was edited to
 * `text`: same destination, `delivery_id` = the send's `webhook-id`,
 * `external_id` as the bridge answered it (or `null`).
 */
export function buildUpdateEvent(
  sent: EntrySendEvent,
  delivery: { id: string; externalId: string | null },
  text: string,
  now = new Date(),
): EntryUpdateEvent {
  const { app, connection, destination, entry } = sent.data;
  return {
    version: 1,
    type: 'entry.update',
    timestamp: isoSeconds(now),
    data: {
      app,
      connection,
      destination,
      delivery_id: delivery.id,
      external_id: delivery.externalId,
      entry: { ...entry, text },
      previous: { title: entry.title, text: entry.text, due: entry.due },
      changes: ['text'],
    },
  };
}

/** Runs `send`; returns the exit code. */
export async function runSend(argv: string[], io: CliIO): Promise<number> {
  const args = parseSendArgs(argv);
  const secret = await resolveSecret(args, io);

  // The destination's name (and, without --destination, its id) come from the manifest.
  let manifest;
  try {
    const ping = await postSigned(args.url, secret, pingBody(`yoink-bridge send ${SDK_VERSION}`), 'send', io);
    if (ping.status < 200 || ping.status >= 300) {
      io.stderr(failureMessage(args.url, ping.status, ping.text));
      return 1;
    }
    manifest = parseManifest(ping.text);
  } catch (error) {
    io.stderr(`yoink-bridge: could not reach ${args.url}: ${(error as Error).message ?? String(error)}\n`);
    return 1;
  }
  const ids = manifest.destinations.map((d) => d.id);
  let destination = manifest.destinations.find((d) => d.id === args.destination);
  if (!destination) {
    if (args.destination === undefined && manifest.destinations.length === 1) {
      destination = manifest.destinations[0]!;
    } else if (args.destination === undefined) {
      throw new UsageError(
        ids.length === 0 ? 'the bridge has no destinations' : `pass --destination (one of: ${ids.join(', ')})`,
      );
    }
  }
  // An id the manifest doesn't list is still sent: that is how you test the 422.
  const target = destination ?? { id: args.destination!, name: args.destination! };
  const event = buildSendEvent(args, target);

  let result;
  try {
    result = await postSigned(args.url, secret, JSON.stringify(event), 'send', io);
  } catch (error) {
    io.stderr(`yoink-bridge: could not reach ${args.url}: ${(error as Error).message ?? String(error)}\n`);
    return 1;
  }
  const { status, text, id } = result;
  if (status >= 200 && status < 300) {
    let receipt = '';
    let ignored = false;
    let externalId: string | null = null;
    if (text.trim()) {
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        ignored = parsed.ignored === true;
        if (typeof parsed.external_id === 'string') externalId = parsed.external_id;
        receipt = ['label', 'url', 'external_id']
          .filter((key) => typeof parsed[key] === 'string')
          .map((key) => `  ${key.padEnd(12)} ${String(parsed[key])}`)
          .join('\n');
      } catch {
        receipt = `  (not JSON) ${text.slice(0, 200)}`;
      }
    }
    const outcome = ignored
      ? 'Ignored by the bridge (yoink shows nothing).\n'
      : receipt
        ? `Receipt:\n${receipt}\n`
        : 'No receipt.\n';
    io.stdout(`entry.send to "${target.id}" (${id}, trigger ${event.data.trigger}) → ${status}\n${outcome}`);
    if (args.update === undefined) return 0;
    if (ignored) {
      io.stdout('No update: yoink sends none for an ignored entry.\n');
      return 0;
    }
    return sendUpdate(args, secret, buildUpdateEvent(event, { id, externalId }, args.update), io);
  }
  let message = failureMessage(args.url, status, text);
  if (status === 422 && text.includes('unknown_destination')) {
    message += `The bridge has no destination "${target.id}"${ids.length ? ` (it has: ${ids.join(', ')})` : ''}.\n`;
  }
  io.stderr(message);
  return 1;
}

/** Posts the `entry.update` and reports the answer as yoink would treat it. */
async function sendUpdate(args: SendArgs, secret: string, event: EntryUpdateEvent, io: CliIO): Promise<number> {
  let result;
  try {
    result = await postSigned(args.url, secret, JSON.stringify(event), 'update', io);
  } catch (error) {
    io.stderr(`yoink-bridge: could not reach ${args.url}: ${(error as Error).message ?? String(error)}\n`);
    return 1;
  }
  const { status, text, id } = result;
  const target = event.data.destination.id;
  if (status >= 200 && status < 300) {
    io.stdout(`entry.update to "${target}" (${id}, changes ${event.data.changes.join(', ')}) → ${status}\n`);
    return 0;
  }
  let message = failureMessage(args.url, status, text);
  if (status === 501) message += `"${target}" takes no updates: yoink would send none for this entry anymore.\n`;
  else if (status >= 500 || status === 408 || status === 429) message += 'yoink would try this update again later.\n';
  else if (status >= 400 && status !== 401 && status !== 403 && status !== 404 && status !== 410) {
    message += 'yoink would drop this change (the next edit is sent again).\n';
  }
  io.stderr(message);
  return 1;
}
