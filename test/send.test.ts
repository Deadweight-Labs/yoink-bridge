import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliIO } from '../src/cli-shared.ts';
import { createBridge, BridgeError, type EntrySendEvent, type EntryUpdateEvent } from '../src/index.ts';
import { runCli } from '../src/run-cli.ts';
import { buildSendEvent, buildUpdateEvent, parseSendArgs } from '../src/send.ts';
import { SECRET } from './helpers.ts';

const URL_ = 'http://localhost:8787/';
let out = '';
let err = '';
let dir = '';
const received: EntrySendEvent[] = [];
const updates: EntryUpdateEvent[] = [];
let updateAnswer: (() => void) | undefined;

const bridge = createBridge({
  secret: SECRET,
  destinations: {
    test: {
      name: 'Test',
      description: 'Entries meant as a test.',
      onEntry: (event) => {
        received.push(event);
        return { label: 'Log', url: 'https://example.com/log', external_id: 'x1' };
      },
      onUpdate: (event) => {
        updates.push(event);
        updateAnswer?.();
      },
    },
    chat: { name: 'Slack', description: 'Chat.', mode: 'suggest', onEntry: () => {} },
  },
});
const single = createBridge({ secret: SECRET, destinations: { only: { name: 'Only', onEntry: () => {} } } });

const io = (target = bridge, overrides: Partial<CliIO> = {}): CliIO => ({
  stdout: (t) => void (out += t),
  stderr: (t) => void (err += t),
  isTTY: false,
  env: { KEY_FROM_YOINK_APP: SECRET },
  fetch: (url, init) => target.fetch(new Request(url, init)),
  ...overrides,
});

beforeEach(async () => {
  out = '';
  err = '';
  received.length = 0;
  updates.length = 0;
  updateAnswer = undefined;
  dir = await mkdtemp(join(tmpdir(), 'yoink-bridge-send-'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe('send', () => {
  it('posts a spec-conformant entry.send and prints the receipt', async () => {
    const code = await runCli(
      ['send', '--url', URL_, '--destination', 'test', '--text', 'Test für meine Bridge', '--title', 'T', '--project', 'yoink'],
      io(),
    );
    expect(err).toBe('');
    expect(code).toBe(0);
    expect(out).toMatch(/^entry\.send to "test" \(msg_send_[0-9a-f]{24}, trigger manual\) → 200\n/);
    expect(out).toContain('  label        Log\n  url          https://example.com/log\n  external_id  x1\n');
    const [event] = received;
    expect(event).toMatchObject({
      version: 1,
      type: 'entry.send',
      data: {
        app: { name: 'yoink' },
        connection: { id: 'cli', name: 'yoink-bridge send' },
        destination: { id: 'test', name: 'Test' },
        trigger: 'manual',
        entry: { title: 'T', text: 'Test für meine Bridge', project: 'yoink', type: 'note', due: null, attachments: [] },
        fit: null,
      },
    });
    expect(event!.data.entry.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(event!.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it('picks the only destination, or asks which one', async () => {
    expect(await runCli(['send', '--url', URL_], io(single))).toBe(0);
    expect(out).toContain('entry.send to "only"');
    expect(out).toContain('No receipt.');

    expect(await runCli(['send', '--url', URL_], io())).toBe(1);
    expect(err).toContain('pass --destination (one of: test, chat)');
  });

  it('explains an unknown destination (422)', async () => {
    expect(await runCli(['send', '--url', URL_, '--destination', 'nope'], io())).toBe(1);
    expect(err).toContain('answered 422: {"error":"unknown_destination"}');
    expect(err).toContain('The bridge has no destination "nope" (it has: test, chat).');
  });

  it('reads the key from --env-file, falling back to the environment, or from --secret', async () => {
    const envFile = join(dir, '.dev.vars');
    await writeFile(envFile, `LINEAR_TEAM=x\nKEY_FROM_YOINK_APP=${SECRET}\n`);
    expect(await runCli(['send', '--url', URL_, '--destination', 'test', '--env-file', envFile], io(bridge, { env: {} }))).toBe(0);

    const withoutKey = join(dir, '.env');
    await writeFile(withoutKey, 'LINEAR_TEAM=x\n');
    expect(await runCli(['send', '--url', URL_, '--destination', 'test', '--env-file', withoutKey], io())).toBe(0);
    err = '';
    expect(await runCli(['send', '--url', URL_, '--env-file', withoutKey], io(bridge, { env: {} }))).toBe(1);
    expect(err).toContain('does not set KEY_FROM_YOINK_APP, and it is not in the environment either');

    err = '';
    expect(await runCli(['send', '--url', URL_, '--destination', 'test', '--secret', SECRET], io(bridge, { env: {} }))).toBe(0);
    expect(err).toBe('');
  });

  it('reports a wrong key from the ping', async () => {
    const other = createBridge({ secret: 'whsec_//79/Pv6+fj39vX08/Lx8O/u7ezr6uno5+bl5OPi4eA=', onEntry: () => {} });
    expect(await runCli(['send', '--url', URL_], io(other))).toBe(1);
    expect(err).toContain('answered 401');
  });

  it('validates its arguments', () => {
    expect(() => parseSendArgs(['--url', 'http://bridge.example'])).toThrow(/http:\/\/ only for localhost/);
    expect(() => parseSendArgs(['--url', URL_, '--trigger', 'always'])).toThrow(/--trigger must be one of/);
    expect(() => parseSendArgs(['--url', URL_, '--text', '  '])).toThrow(/must not be empty/);
    expect(() => parseSendArgs(['--url', URL_, '--password'])).toThrow(/Unknown option '--password'/);
    expect(() => parseSendArgs(['--url', URL_, '--update', ' '])).toThrow(/--update must not be empty/);
    expect(() => parseSendArgs(['--url', URL_, '--text', 'Gleich', '--update', 'Gleich '])).toThrow(/--update must differ from --text/);
    expect(parseSendArgs(['--url', 'https://r.example', '--trigger', 'auto'])).toMatchObject({
      url: 'https://r.example/',
      text: 'Test für meine Bridge',
      trigger: 'auto',
    });
  });

  it('--update sends the entry, then an entry.update for that delivery, as yoink does after an edit', async () => {
    const code = await runCli(
      ['send', '--url', URL_, '--destination', 'test', '--text', 'Alt', '--title', 'T', '--update', 'Neu\nmit mehr'],
      io(),
    );
    expect(err).toBe('');
    expect(code).toBe(0);
    const sendId = /entry\.send to "test" \((msg_send_[0-9a-f]{24})/.exec(out)![1]!;
    expect(out).toMatch(/\nentry\.update to "test" \(msg_update_[0-9a-f]{24}, changes text\) → 204\n$/);
    const [sent] = received;
    const [event] = updates;
    expect(event).toEqual({
      version: 1,
      type: 'entry.update',
      timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/),
      data: {
        app: sent!.data.app,
        connection: sent!.data.connection,
        destination: { id: 'test', name: 'Test' },
        delivery_id: sendId,
        external_id: 'x1',
        entry: { ...sent!.data.entry, text: 'Neu\nmit mehr' },
        previous: { title: 'T', text: 'Alt', due: null },
        changes: ['text'],
      },
    });
  });

  it('--update explains a 501 (no updates) and a dropped change; skips an ignored entry', async () => {
    expect(await runCli(['send', '--url', URL_, '--destination', 'chat', '--update', 'Neu'], io())).toBe(1);
    expect(out).toContain('entry.send to "chat"');
    expect(err).toContain('answered 501: {"error":"this bridge does not support entry.update"}');
    expect(err).toContain('"chat" takes no updates: yoink would send none for this entry anymore.');

    err = '';
    updateAnswer = () => {
      throw new BridgeError(422, 'no external_id');
    };
    expect(await runCli(['send', '--url', URL_, '--destination', 'test', '--update', 'Neu'], io())).toBe(1);
    expect(err).toContain('answered 422: {"error":"no external_id"}');
    expect(err).toContain('yoink would drop this change');

    err = '';
    updateAnswer = () => {
      throw new BridgeError(502, 'Linear answered 503');
    };
    expect(await runCli(['send', '--url', URL_, '--destination', 'test', '--update', 'Neu'], io())).toBe(1);
    expect(err).toContain('yoink would try this update again later.');

    out = '';
    const ignoring = createBridge({
      secret: SECRET,
      destinations: { inbox: { name: 'Inbox', mode: 'all', onEntry: () => ({ ignored: true }) as never, onUpdate: () => {} } },
    });
    expect(await runCli(['send', '--url', URL_, '--update', 'Neu'], io(ignoring))).toBe(0);
    expect(out).toContain('No update: yoink sends none for an ignored entry.');
  });

  it('buildUpdateEvent: external_id null when the send answered none', () => {
    const sent = buildSendEvent(parseSendArgs(['--url', URL_]), { id: 'a', name: 'A' });
    const event = buildUpdateEvent(sent, { id: 'msg_1', externalId: null }, 'Neu');
    expect(event.data).toMatchObject({ delivery_id: 'msg_1', external_id: null, changes: ['text'], entry: { text: 'Neu' } });
    expect(event.data.previous).toEqual({ title: null, text: 'Test für meine Bridge', due: null });
  });

  it('auto and suggestion carry a fit probability, manual none', () => {
    const args = parseSendArgs(['--url', URL_, '--trigger', 'suggestion']);
    expect(buildSendEvent(args, { id: 'a', name: 'A' }).data.fit).toEqual({ probability: 0.95 });
    expect(buildSendEvent({ ...args, trigger: 'manual' }, { id: 'a', name: 'A' }).data.fit).toBeNull();
  });
});
