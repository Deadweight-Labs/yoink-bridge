/** Own routing: mode "all", ignore(), presets as building blocks, async destinations. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineWorkerBridge, MemoryKV, type WorkerEnv } from '../src/cloudflare/index.ts';
import type { CliIO } from '../src/cli-shared.ts';
import { createBridge, describeBridge, ignore, parseManifest, BridgeError, type EntrySendEvent } from '../src/index.ts';
import { discord } from '../src/presets/discord.ts';
import { linear } from '../src/presets/linear.ts';
import { slack } from '../src/presets/slack.ts';
import { runCli } from '../src/run-cli.ts';
import { newId, ping, SECRET, sendAuto, signedRequest } from './helpers.ts';

const ctx = { waitUntil() {} };
const ORIGIN = 'https://bridge.example.workers.dev';

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const to = (event: EntrySendEvent, id: string): EntrySendEvent => ({
  ...event,
  data: { ...event.data, destination: { id, name: id } },
});

describe('mode "all"', () => {
  it('needs no description and is announced as such', async () => {
    const bridge = createBridge({
      secret: SECRET,
      destinations: {
        inbox: { name: 'Inbox', mode: 'all', onEntry: () => {} },
        router: { name: 'Router', mode: 'all', description: 'Everything for my router', projects: ['yoink'], onEntry: () => {} },
      },
    });
    expect(bridge.manifest.destinations).toEqual([
      { id: 'inbox', name: 'Inbox', mode: 'all' },
      { id: 'router', name: 'Router', description: 'Everything for my router', projects: ['yoink'], mode: 'all' },
    ]);
    const parsed = parseManifest(JSON.stringify(bridge.manifest));
    expect(parsed.destinations.map((d) => d.mode)).toEqual(['all', 'all']);
    expect(describeBridge(bridge)).toContain('inbox: Inbox\n  mode:        all (gets every new entry – switch it on in yoink)');
  });

  it('is validated like the other modes', () => {
    expect(() => createBridge({ secret: SECRET, destinations: { a: { name: 'A', mode: 'ALL' as never, onEntry: () => {} } } })).toThrow(
      /unknown mode "ALL" \(auto, suggest, manual or all\)/,
    );
    expect(() => createBridge({ secret: SECRET, destinations: { a: { name: 'A', mode: 'auto', onEntry: () => {} } } })).toThrow(
      /needs a description/,
    );
  });

  it('the Worker manifest marks it too', async () => {
    const worker = defineWorkerBridge<WorkerEnv>({ destinations: () => ({ inbox: { name: 'Inbox', mode: 'all', onEntry: () => {} } }) });
    const env = { BRIDGE_KV: new MemoryKV(), YOINK_SECRET: SECRET };
    const res = await worker.fetch(await signedRequest(ping(), { url: `${ORIGIN}/` }), env, ctx);
    expect(describeBridge(await res.text())).toContain('mode:        all (gets every new entry – switch it on in yoink)');
  });
});

describe('ignore()', () => {
  it('answers 200 {"ignored":true}, cached for retries', async () => {
    const onEntry = vi.fn(() => ignore());
    const bridge = createBridge({ secret: SECRET, destinations: { bugs: { name: 'Bugs', mode: 'all', onEntry } } });
    const id = newId();
    for (let i = 0; i < 2; i++) {
      const res = await bridge.fetch(await signedRequest(sendAuto(), { id }));
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('{"ignored":true}');
    }
    expect(onEntry).toHaveBeenCalledOnce();
  });

  it('drops any other fields and is frozen', async () => {
    const bridge = createBridge({
      secret: SECRET,
      onUndo: () => {},
      destinations: { bugs: { name: 'Bugs', mode: 'all', onEntry: () => ({ ...ignore(), label: 'X' }) as never } },
    });
    expect(await (await bridge.fetch(await signedRequest(sendAuto()))).text()).toBe('{"ignored":true}');
    expect(Object.isFrozen(ignore())).toBe(true);
    expect(ignore()).toEqual({ ignored: true });
  });
});

describe('presets as building blocks', () => {
  const fakeFetch = () => vi.fn(async (_url: string, _init: RequestInit) => new Response(null, { status: 204 }));
  const body = (f: ReturnType<typeof fakeFetch>, i = 0) => JSON.parse(f.mock.calls[i]![1].body as string);

  it('slack(...).post(text) and discord(...).post(text)', async () => {
    const sf = fakeFetch();
    const chat = slack({ webhookUrl: 'https://hooks.slack.com/services/x', fetch: sf });
    await chat.post('*Hi* there');
    expect(body(sf)).toEqual({ text: '*Hi* there' });
    await chat(sendAuto()); // still an onEntry
    expect(sf).toHaveBeenCalledTimes(2);

    const df = fakeFetch();
    const room = discord({ webhookUrl: 'https://discord.com/api/webhooks/1/x', fetch: df });
    await room.post('x'.repeat(2100));
    expect(body(df).content).toHaveLength(2000);
    expect(body(df).allowed_mentions).toEqual({ parse: [] });

    const missing = slack({ webhookUrl: undefined });
    await expect(missing.post('x')).rejects.toMatchObject({ status: 503 });
  });

  const TEAM_ID = '11111111-2222-4333-8444-555555555555';
  function fakeLinear() {
    const calls: { query: string; variables: Record<string, unknown> }[] = [];
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const call = JSON.parse(init.body as string);
      calls.push(call);
      if (call.query.includes('issueLabels')) {
        const names = call.variables.names as string[];
        return Response.json({
          data: { issueLabels: { nodes: names.filter((n) => n !== 'Nope').map((n) => ({ id: `id-${n}`, name: n, team: null })) } },
        });
      }
      if (call.query.includes('issueCreate')) {
        return Response.json({ data: { issueCreate: { success: true, issue: { id: 'iss', identifier: 'ABC-7', url: 'https://linear.app/x/issue/ABC-7' } } } });
      }
      if (call.query.includes('issueArchive')) return Response.json({ data: { issueArchive: { success: true } } });
      throw new Error(call.query);
    });
    return { fetch, calls };
  }

  it('linear(...).createIssue(event, overrides) with title, description, priority and labels', async () => {
    const { fetch, calls } = fakeLinear();
    const lin = linear({ apiKey: 'k', team: TEAM_ID, labels: ['Default'], fetch });
    expect(
      await lin.createIssue(sendAuto(), {
        title: '  Crash when sharing videos  ',
        description: 'AI summary',
        priority: 2,
        labelNames: ['Bug', 'iOS'],
        labelIds: ['aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'],
      }),
    ).toEqual({ url: 'https://linear.app/x/issue/ABC-7', label: 'ABC-7', external_id: 'iss' });
    const create = calls.find((c) => c.query.includes('issueCreate'))!;
    expect(create.variables.input).toEqual({
      teamId: TEAM_ID,
      title: 'Crash when sharing videos',
      description: 'AI summary',
      priority: 2,
      labelIds: ['aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', 'id-Bug', 'id-iOS'],
    });

    // Label names are cached: only the new one is looked up.
    await lin.createIssue(sendAuto(), { labelNames: ['Bug', 'Android'] });
    const lookups = calls.filter((c) => c.query.includes('issueLabels')).map((c) => c.variables.names);
    expect(lookups).toEqual([['Bug', 'iOS'], ['Android']]);

    // Without overrides the configured labels apply.
    await lin.createIssue(sendAuto());
    expect((calls.at(-1)!.variables.input as { labelIds: string[] }).labelIds).toEqual(['id-Default']);

    await lin.archiveIssue('iss');
    expect(calls.at(-1)!.variables).toEqual({ id: 'iss' });
  });

  it('createIssue rejects a priority outside 0–4 and unknown labels with 422', async () => {
    const { fetch } = fakeLinear();
    const lin = linear({ apiKey: 'k', team: TEAM_ID, fetch });
    for (const priority of [-1, 5, 1.5]) {
      await expect(lin.createIssue(sendAuto(), { priority })).rejects.toMatchObject({ status: 422 });
    }
    const error = await lin.createIssue(sendAuto(), { labelNames: ['Nope'] }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BridgeError);
    expect((error as BridgeError).message).toBe('Linear label "Nope" not found in this team or workspace');
  });

  it('spreading linear() copies only the handlers', () => {
    const lin = linear({ apiKey: 'k', team: TEAM_ID });
    expect(Object.keys({ ...lin }).sort()).toEqual(['onEntry', 'onUndo', 'onUpdate']);
    expect(typeof lin.createIssue).toBe('function');
    expect(typeof lin.archiveIssue).toBe('function');
    expect(typeof lin.commentOnIssue).toBe('function');
  });
});

describe('async destinations', () => {
  interface Env extends WorkerEnv {
    YOINK_SECRET: string;
  }
  const env = (): Env => ({ BRIDGE_KV: new MemoryKV(), YOINK_SECRET: SECRET });
  const pingIds = async (worker: { fetch: (r: Request, e: Env, c: typeof ctx) => Promise<Response> }, e: Env) =>
    parseManifest(await (await worker.fetch(await signedRequest(ping(), { url: `${ORIGIN}/` }), e, ctx)).text()).destinations.map(
      (d) => d.id,
    );

  it('loads destinations asynchronously (e.g. from KV) and refreshes them after refreshSeconds', async () => {
    vi.useFakeTimers({ now: 1_000_000, toFake: ['Date'] });
    const e = env();
    await e.BRIDGE_KV.put('routes', JSON.stringify(['a']));
    const factory = vi.fn(async (current: Env) => {
      const ids = JSON.parse((await current.BRIDGE_KV.get('routes')) ?? '[]') as string[];
      return Object.fromEntries(ids.map((id) => [id, { name: id.toUpperCase(), onEntry: () => ({ label: id }) }]));
    });
    const worker = defineWorkerBridge<Env>({ destinations: factory, refreshSeconds: 30 });
    expect(await pingIds(worker, e)).toEqual(['a']);
    await e.BRIDGE_KV.put('routes', JSON.stringify(['a', 'b']));
    expect(await pingIds(worker, e)).toEqual(['a']); // cached
    vi.setSystemTime(1_000_000 + 30_001);
    expect(await pingIds(worker, e)).toEqual(['a', 'b']);
    expect(factory).toHaveBeenCalledTimes(2);

    const sent = await worker.fetch(await signedRequest(to(sendAuto(), 'b'), { url: `${ORIGIN}/` }), e, ctx);
    expect(await sent.json()).toEqual({ label: 'b' });
  });

  it('concurrent requests share one build; a failed refresh keeps the last good bridge', async () => {
    vi.useFakeTimers({ now: 2_000_000, toFake: ['Date'] });
    const e = env();
    let fail = false;
    const factory = vi.fn(async () => {
      await Promise.resolve();
      if (fail) throw new Error('KV unreachable');
      return { inbox: { name: 'Inbox', mode: 'all' as const, onEntry: () => ignore() } };
    });
    const worker = defineWorkerBridge<Env>({ destinations: factory, refreshSeconds: 1 });
    const results = await Promise.all([pingIds(worker, e), pingIds(worker, e), pingIds(worker, e)]);
    expect(results).toEqual([['inbox'], ['inbox'], ['inbox']]);
    expect(factory).toHaveBeenCalledOnce();

    fail = true;
    vi.setSystemTime(2_000_000 + 1_001);
    expect(await pingIds(worker, e)).toEqual(['inbox']);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('KV unreachable'));
  });

  it('a first failing async build answers 500 and is retried after 10 s', async () => {
    vi.useFakeTimers({ now: 3_000_000, toFake: ['Date'] });
    const e = env();
    let fail = true;
    const worker = defineWorkerBridge<Env>({
      destinations: async () => {
        if (fail) throw new Error('not yet');
        return { a: { name: 'A', onEntry: () => {} } };
      },
    });
    expect((await worker.fetch(await signedRequest(ping(), { url: `${ORIGIN}/` }), e, ctx)).status).toBe(500);
    fail = false;
    expect((await worker.fetch(await signedRequest(ping(), { url: `${ORIGIN}/` }), e, ctx)).status).toBe(500);
    vi.setSystemTime(3_000_000 + 10_001);
    expect((await worker.fetch(await signedRequest(ping(), { url: `${ORIGIN}/` }), e, ctx)).status).toBe(200);
  });
});

describe('send to a mode "all" destination', () => {
  it('sends like yoink (trigger auto, no fit) and reports an ignored answer', async () => {
    const received: EntrySendEvent[] = [];
    const bridge = createBridge({
      secret: SECRET,
      destinations: {
        inbox: {
          name: 'Inbox',
          mode: 'all',
          onEntry: (event) => {
            received.push(event);
            return ignore();
          },
        },
      },
    });
    let out = '';
    const io: CliIO = {
      stdout: (t) => void (out += t),
      stderr: () => {},
      isTTY: false,
      env: { YOINK_SECRET: SECRET },
      fetch: (url, init) => bridge.fetch(new Request(url, init)),
    };
    expect(await runCli(['send', '--url', 'http://localhost:8787', '--destination', 'inbox'], io)).toBe(0);
    expect(out).toMatch(/trigger auto\) → 200\nIgnored by the bridge \(yoink shows nothing\)\.\n$/);
    expect(received[0]!.data).toMatchObject({ trigger: 'auto', fit: null, destination: { id: 'inbox', name: 'Inbox' } });
  });
});
