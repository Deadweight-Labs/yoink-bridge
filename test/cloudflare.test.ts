import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  defineWorkerBridge,
  KVDedupeStore,
  MemoryKV,
  received,
  type WorkerEnv,
  type WorkerBridgeConfig,
} from '../src/cloudflare/index.ts';
import { dashboardLink, pickLanguage } from '../src/cloudflare/pages.ts';
import { createBridge, generateSecret, parseManifest, BridgeError, signWebhook } from '../src/index.ts';
import { encodeQr, renderQrSvg } from '../src/qr.ts';
import { newId, ping, sendAuto, signedRequest, SECRET, update } from './helpers.ts';

const ORIGIN = 'https://yoink-bridge.example.workers.dev';
const ctx = { waitUntil() {} };

interface Env extends WorkerEnv {
  SLACK_WEBHOOK_URL?: string;
  LINEAR_API_KEY?: string;
  LINEAR_TEAM?: string;
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

function makeEnv(extra: Partial<Env> = {}): Env & { BRIDGE_KV: MemoryKV } {
  return { KEY_FROM_YOINK_APP: SECRET, ...extra, BRIDGE_KV: new MemoryKV() };
}

function makeWorker(extra: Partial<WorkerBridgeConfig<Env>> = {}) {
  return defineWorkerBridge<Env>({
    name: 'Meine Bridge',
    destinations: () => ({
      test: { name: 'Test', description: 'Entries meant as a test.', onEntry: received() },
      bugs: {
        name: 'Linear · Bugs',
        description: 'Concrete bugs in the yoink app.',
        requires: ['LINEAR_API_KEY', 'LINEAR_TEAM'],
        onEntry: () => ({ label: 'ABC-1' }),
      },
    }),
    ...extra,
  });
}

async function signedPing(secret: string, origin = ORIGIN) {
  const body = JSON.stringify(ping());
  const id = newId();
  const timestamp = Math.floor(Date.now() / 1000);
  return new Request(`${origin}/`, {
    method: 'POST',
    headers: {
      'webhook-id': id,
      'webhook-timestamp': String(timestamp),
      'webhook-signature': await signWebhook({ secret, id, timestamp, body }),
    },
    body,
  });
}

const get = (path: string, headers: Record<string, string> = {}) => new Request(`${ORIGIN}${path}`, { headers });
const toTest = () => ({ ...sendAuto(), data: { ...sendAuto().data, destination: { id: 'test', name: 'Test' } } });

describe('landing page', () => {
  it('shows the bridge name and a link + QR code with the URL only, never a key', async () => {
    const worker = makeWorker();
    const env = makeEnv();
    const res = await worker.fetch(get('/', { 'accept-language': 'de-DE,de;q=0.9' }), env, ctx);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<h1>Meine Bridge</h1>');
    expect(html).toContain('Diese yoink-Bridge läuft.');
    expect(html).toContain(
      '<a class="button" href="yoink://ausgang?v=1&#38;url=https%3A%2F%2Fyoink-bridge.example.workers.dev%2F&#38;name=Meine%20Bridge">In yoink öffnen</a>',
    );
    expect(html).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
    expect(html).toContain('Diese Seite zeigt den Schlüssel nie.');
    expect(html).not.toContain('role="alert"');
    expect(html).not.toMatch(/whsec_|secret=|<form|<script|<input/);
    expect(html).not.toContain(SECRET.slice(6, 20));
  });

  it('says when the key is missing or invalid, and where to add it', async () => {
    const worker = makeWorker();
    const missing = await (await worker.fetch(get('/'), makeEnv({ KEY_FROM_YOINK_APP: '  ' }), ctx)).text();
    expect(missing).toContain('<div class="warn" role="alert"><p><strong>The key is missing: KEY_FROM_YOINK_APP is not set');
    expect(missing).toContain('Settings › Variables and Secrets › Add, type “Secret”, name KEY_FROM_YOINK_APP');
    expect(missing).toContain(
      '<a href="https://dash.cloudflare.com/?to=/:account/workers/services/view/yoink-bridge/production/settings">',
    );
    expect(missing).toContain('Open in yoink'); // the link stays, for after the key is added

    const invalid = await (
      await worker.fetch(get('/', { 'accept-language': 'de' }), makeEnv({ KEY_FROM_YOINK_APP: 'whsec_tooShort' }), ctx)
    ).text();
    expect(invalid).toContain('KEY_FROM_YOINK_APP ist kein gültiger Schlüssel.');
    expect(invalid).toContain('Einstellungen › Ausgänge › Bridge einrichten › Schlüssel kopieren');
    expect(invalid).not.toContain('tooShort');

    const custom = await (await worker.fetch(new Request('https://bridge.example.com/'), makeEnv({ KEY_FROM_YOINK_APP: undefined }), ctx)).text();
    expect(custom).toContain('role="alert"');
    expect(custom).not.toContain('dash.cloudflare.com');
  });

  it('sends strict headers; English by default', async () => {
    const res = await makeWorker().fetch(get('/'), makeEnv(), ctx);
    const csp = res.headers.get('content-security-policy')!;
    const nonce = /style-src 'nonce-([^']+)'/.exec(csp)![1]!;
    expect(csp).toBe(`default-src 'none'; style-src 'nonce-${nonce}'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    const html = await res.text();
    expect(html).toContain('This yoink bridge is running.');
    expect(html).toContain('This page never shows the key.');
    expect(html).toContain(`<style nonce="${nonce}">`);
  });

  it('needs no KV binding and leaves out the name when none is set', async () => {
    const worker = defineWorkerBridge<Env>({ destinations: () => ({ test: { name: 'T', onEntry: received() } }) });
    const res = await worker.fetch(get('/'), {} as Env, ctx);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('href="yoink://ausgang?v=1&#38;url=https%3A%2F%2Fyoink-bridge.example.workers.dev%2F"');
  });
});

describe('routing', () => {
  it('unknown paths 404; /setup and /log no longer exist; user routes work', async () => {
    const health = vi.fn((_req: Request, env: Env, _ctx: unknown) => new Response(`ok ${Boolean(env.BRIDGE_KV)}`));
    const worker = makeWorker({ routes: { 'GET /health': health } });
    const env = makeEnv();
    for (const path of ['/nope', '/setup', '/log']) expect((await worker.fetch(get(path), env, ctx)).status).toBe(404);
    expect(await (await worker.fetch(get('/health'), env, ctx)).text()).toBe('ok true');
    expect(health.mock.calls[0]![2]).toBe(ctx);
    expect(() => makeWorker({ routes: { 'GET /': () => new Response() } as never })).toThrow(/is reserved/);
    expect(() => makeWorker({ routes: { 'PUT /x': () => new Response() } as never })).toThrow(/must look like/);
    expect((await worker.fetch(new Request(`${ORIGIN}/`, { method: 'PUT' }), env, ctx)).status).toBe(405);
  });

  it('verifies every request against KEY_FROM_YOINK_APP (trimmed), and nothing else', async () => {
    const worker = makeWorker();
    const res = await worker.fetch(await signedPing(SECRET), makeEnv({ KEY_FROM_YOINK_APP: `  ${SECRET}\n` }), ctx);
    expect(res.status).toBe(200);
    expect(parseManifest(await res.text()).bridgeName).toBe('Meine Bridge');
    expect((await worker.fetch(await signedPing(generateSecret()), makeEnv(), ctx)).status).toBe(401);

    const sent = await worker.fetch(await signedRequest(toTest(), { url: `${ORIGIN}/` }), makeEnv(), ctx);
    expect(await sent.json()).toEqual({ label: 'Angekommen ✓' });
  });

  it('503 with the reason while KEY_FROM_YOINK_APP is missing or not a valid key; it never appears in the answer', async () => {
    const worker = makeWorker();
    for (const [value, reason] of [
      [undefined, /^KEY_FROM_YOINK_APP is not set on this bridge: add the key from yoink/],
      ['', /^KEY_FROM_YOINK_APP is not set/],
      ['whsec_c2hvcnQ=', /^KEY_FROM_YOINK_APP is not a valid key \(expected whsec_ \+ base64 of 32 bytes/],
      [SECRET.slice(6), /^KEY_FROM_YOINK_APP is not a valid key/],
    ] as const) {
      const res = await worker.fetch(await signedPing(SECRET), makeEnv({ KEY_FROM_YOINK_APP: value }), ctx);
      expect(res.status, String(value)).toBe(503);
      const text = await res.text();
      expect(JSON.parse(text).error).toMatch(reason);
      if (value) expect(text).not.toContain(value);
    }
    // Setting the key makes the same Worker answer right away.
    const env = makeEnv({ KEY_FROM_YOINK_APP: undefined });
    expect((await worker.fetch(await signedPing(SECRET), env, ctx)).status).toBe(503);
    env.KEY_FROM_YOINK_APP = SECRET;
    expect((await worker.fetch(await signedPing(SECRET), env, ctx)).status).toBe(200);
  });

  it('a retired connection.pair from an old app does not verify (401); signed with the key it is ignored (204)', async () => {
    const worker = makeWorker();
    const env = makeEnv();
    const body = JSON.stringify({
      version: 1,
      type: 'connection.pair',
      timestamp: '2026-10-16T08:00:00Z',
      data: { app: { name: 'yoink', build: 't' }, connection: { id: 'iphone', name: 'Meine Bridge' }, secret: generateSecret() },
    });
    const id = newId();
    const timestamp = Math.floor(Date.now() / 1000);
    const request = (secret: string) =>
      signWebhook({ secret, id, timestamp, body }).then(
        (signature) =>
          new Request(`${ORIGIN}/`, {
            method: 'POST',
            headers: { 'webhook-id': id, 'webhook-timestamp': String(timestamp), 'webhook-signature': signature },
            body,
          }),
      );
    expect((await worker.fetch(await request(generateSecret()), env, ctx)).status).toBe(401);
    const ignored = await worker.fetch(await request(SECRET), env, ctx);
    expect(ignored.status).toBe(204);
    expect(env.BRIDGE_KV.keys()).toEqual([]);
  });

  it('configuration errors answer 500', async () => {
    const env = makeEnv();
    const bad = defineWorkerBridge<Env>({ destinations: () => ({ Bad: { name: 'x', onEntry: () => {} } }) });
    expect((await bad.fetch(await signedPing(SECRET), env, ctx)).status).toBe(500);
    const noKv = makeWorker();
    expect((await noKv.fetch(await signedPing(SECRET), { KEY_FROM_YOINK_APP: SECRET } as unknown as Env, ctx)).status).toBe(500);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('BRIDGE_KV is missing'));
  });
});

describe('waiting destinations and settings_url', () => {
  it('lists destinations with missing keys in waiting[] (names only) and links the Worker settings', async () => {
    const worker = makeWorker();
    const env = makeEnv({ LINEAR_API_KEY: 'lin_api_SUPERSECRET' });
    const text = await (await worker.fetch(await signedPing(SECRET), env, ctx)).text();
    expect(text).not.toContain('SUPERSECRET');
    const manifest = parseManifest(text);
    expect(manifest.waiting).toEqual([{ id: 'bugs', name: 'Linear · Bugs', missing: ['LINEAR_TEAM'] }]);
    expect(manifest.settingsUrl).toBe(
      'https://dash.cloudflare.com/?to=/:account/workers/services/view/yoink-bridge/production/settings',
    );
    // An entry, undo or update for a waiting destination is retried later (503), never refused for good.
    for (const event of [sendAuto(), update()]) {
      const res = await worker.fetch(await signedRequest(event, { url: `${ORIGIN}/` }), env, ctx);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'destination "bugs" is waiting for LINEAR_TEAM' });
    }

    const ready = makeEnv({ LINEAR_API_KEY: 'k', LINEAR_TEAM: 'ABC' });
    const readyManifest = parseManifest(await (await worker.fetch(await signedPing(SECRET), ready, ctx)).text());
    expect(readyManifest.destinations.map((d) => d.id)).toEqual(['test', 'bugs']);
    expect(readyManifest.waiting).toEqual([]);
  });

  it('no settings_url on a custom domain', async () => {
    const worker = makeWorker();
    const res = await worker.fetch(await signedPing(SECRET, 'https://bridge.example.com'), makeEnv(), ctx);
    const manifest = parseManifest(await res.text());
    expect(manifest.settingsUrl).toBeNull();
    expect(manifest.waiting.map((w) => w.id)).toEqual(['bugs']);
  });

  it('a bridge whose destinations all wait still answers', async () => {
    const worker = defineWorkerBridge<Env>({
      destinations: () => ({ bugs: { name: 'Bugs', requires: ['LINEAR_API_KEY'], onEntry: () => {} } }),
    });
    const res = await worker.fetch(await signedPing(SECRET), makeEnv(), ctx);
    expect(res.status).toBe(200);
    expect(parseManifest(await res.text())).toMatchObject({ destinations: [], waiting: [{ id: 'bugs', missing: ['LINEAR_API_KEY'] }] });
  });

  it('passes group through to the manifest', async () => {
    const worker = defineWorkerBridge<Env>({
      destinations: () => ({
        linear: { name: 'Linear', description: 'Aufgaben.', group: 'tracker', onEntry: () => {} },
        github: { name: 'GitHub', description: 'Aufgaben.', group: 'tracker', requires: ['LINEAR_TEAM'], onEntry: () => {} },
      }),
    });
    const text = await (await worker.fetch(await signedPing(SECRET), makeEnv(), ctx)).text();
    expect(JSON.parse(text).destinations).toEqual([{ id: 'linear', name: 'Linear', description: 'Aufgaben.', group: 'tracker' }]);
    expect(JSON.parse(text).waiting).toEqual([{ id: 'github', name: 'GitHub', missing: ['LINEAR_TEAM'] }]);
  });

  it('requires names must be setting names yoink shows', async () => {
    const worker = defineWorkerBridge<Env>({
      destinations: () => ({ a: { name: 'A', requires: ['lower_case' as never], onEntry: () => {} } }),
    });
    expect((await worker.fetch(await signedPing(SECRET), makeEnv(), ctx)).status).toBe(500);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('requires must list up to 10 env key names'));
  });

  it('dashboardLink and pickLanguage', () => {
    expect(dashboardLink('yoink-bridge.alice.workers.dev')).toBe(
      'https://dash.cloudflare.com/?to=/:account/workers/services/view/yoink-bridge/production/settings',
    );
    expect(dashboardLink('bridge.example.com')).toBeUndefined();
    expect(pickLanguage('en-US,en;q=0.9,de;q=0.8')).toBe('en');
    expect(pickLanguage('fr-FR,de;q=0.5')).toBe('de');
    expect(pickLanguage(null)).toBe('en');
  });
});

/**
 * MemoryKV with Workers KV's write limit: a second write (put or delete) to
 * the same key within 1 s fails, as KV answers 429 then.
 */
class RateLimitedKV extends MemoryKV {
  readonly #lastWrite = new Map<string, number>();
  readonly #clock: () => number;

  constructor(clock: () => number) {
    super({ now: clock });
    this.#clock = clock;
  }

  #write(key: string): void {
    const last = this.#lastWrite.get(key);
    if (last !== undefined && this.#clock() - last < 1000) {
      throw new Error(`KV PUT failed: 429 Too Many Requests (${key})`);
    }
    this.#lastWrite.set(key, this.#clock());
  }

  override async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    this.#write(key);
    return super.put(key, value, options);
  }

  override async delete(key: string): Promise<void> {
    this.#write(key);
    return super.delete(key);
  }
}

describe('KVDedupeStore', () => {
  it('stores the lease and the response under separate keys, with TTLs', async () => {
    let now = 0;
    const kv = new MemoryKV({ now: () => now });
    const put = vi.spyOn(kv, 'put');
    const store = new KVDedupeStore(kv);
    expect(await store.begin('msg_1')).toBeNull();
    expect(put).toHaveBeenLastCalledWith('dedupe:pending:msg_1', expect.stringMatching(/^\{"state":"pending","lease":"[0-9a-f-]{36}"\}$/), {
      expirationTtl: 300,
    });
    expect(await store.begin('msg_1')).toEqual({ state: 'pending' });
    await store.complete('msg_1', { status: 200, body: '{"label":"L"}' });
    expect(put).toHaveBeenLastCalledWith('dedupe:done:msg_1', '{"state":"done","response":{"status":200,"body":"{\\"label\\":\\"L\\"}"}}', {
      expirationTtl: 172800,
    });
    expect(put).toHaveBeenCalledTimes(2);
    // The response wins over the lease, which is left to expire.
    expect(await store.begin('msg_1')).toEqual({ state: 'done', response: { status: 200, body: '{"label":"L"}' } });
    now = 47 * 3600 * 1000;
    expect(await store.begin('msg_1')).toEqual({ state: 'done', response: { status: 200, body: '{"label":"L"}' } });
    now = 48 * 3600 * 1000;
    expect(await store.begin('msg_1')).toBeNull();
  });

  it('release frees the lease without writing it again; another lease stays taken', async () => {
    let now = 0;
    const kv = new RateLimitedKV(() => now);
    const store = new KVDedupeStore(kv);
    expect(await store.begin('msg_2')).toBeNull();
    await store.release('msg_2'); // same instant: a different key
    now += 60_000; // yoink's first retry, a minute later
    expect(await store.begin('msg_2')).toBeNull();
    // A second instance (another isolate) sees the new lease as taken, and can release it.
    const other = new KVDedupeStore(kv);
    expect(await other.begin('msg_2')).toEqual({ state: 'pending' });
    now += 60_000;
    await other.release('msg_2');
    expect(await other.begin('msg_2')).toBeNull();
    // Nothing to release: no write.
    const put = vi.spyOn(kv, 'put');
    await new KVDedupeStore(new MemoryKV()).release('msg_none');
    expect(put).not.toHaveBeenCalled();
  });

  it('unreadable records count as absent', async () => {
    const kv = new MemoryKV();
    await kv.put('dedupe:done:x', 'not json');
    await kv.put('dedupe:pending:x', '{"state":"pending"}');
    expect(await new KVDedupeStore(kv).begin('x')).toBeNull();
  });

  it('with KV allowing one write per key per second, begin → complete → retry replays the stored response', async () => {
    let now = Date.now();
    const kv = new RateLimitedKV(() => now);
    let n = 0;
    const onEntry = vi.fn(() => ({ label: `ABC-${++n}`, external_id: `issue-${n}` }));
    const bridge = createBridge({
      secret: SECRET,
      dedupe: new KVDedupeStore(kv),
      destinations: { bugs: { name: 'Bugs', description: 'Bugs.', onEntry } },
    });
    const id = newId();
    const first = await bridge.fetch(await signedRequest(sendAuto(), { id }));
    expect(await first.json()).toEqual({ label: 'ABC-1', external_id: 'issue-1' });
    expect(console.error).not.toHaveBeenCalled(); // complete did not hit the write limit

    // A retry right away (within KV's 1 s) and one a minute later; the 48 h TTL is tested above.
    for (const later of [200, 60_000]) {
      now += later;
      const retry = await bridge.fetch(await signedRequest(sendAuto(), { id, timestamp: Math.floor(now / 1000) }));
      expect(retry.status).toBe(200);
      expect(await retry.json()).toEqual({ label: 'ABC-1', external_id: 'issue-1' });
    }
    expect(onEntry).toHaveBeenCalledOnce();
  });

  it('with the write limit, a retryable failure is released and the retry runs again', async () => {
    let now = Date.now();
    const kv = new RateLimitedKV(() => now);
    let fail = true;
    const onEntry = vi.fn(() => {
      if (fail) throw new BridgeError(502, 'Linear answered 503');
      return { label: 'ABC-1' };
    });
    const bridge = createBridge({
      secret: SECRET,
      dedupe: new KVDedupeStore(kv),
      destinations: { bugs: { name: 'Bugs', description: 'Bugs.', onEntry } },
    });
    const id = newId();
    expect((await bridge.fetch(await signedRequest(sendAuto(), { id }))).status).toBe(502);
    fail = false;
    now += 60_000;
    const retry = await bridge.fetch(await signedRequest(sendAuto(), { id, timestamp: Math.floor(now / 1000) }));
    expect(await retry.json()).toEqual({ label: 'ABC-1' });
    expect(onEntry).toHaveBeenCalledTimes(2);
    // Only the 502 was logged, never the store.
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it('never uses a TTL below the KV minimum of 60 s', async () => {
    const kv = new MemoryKV();
    const store = new KVDedupeStore(kv, { pendingTtlSeconds: 5, ttlSeconds: 10 });
    await expect(store.begin('x')).resolves.toBeNull();
    await expect(store.complete('x', { status: 204, body: null })).resolves.toBeUndefined();
  });

  it('dedupes deliveries through the worker', async () => {
    const onEntry = vi.fn(() => ({ label: 'once' }));
    const worker = defineWorkerBridge<Env>({ destinations: () => ({ bugs: { name: 'Bugs', description: 'Bugs.', onEntry } }) });
    const env = makeEnv();
    const id = newId();
    const a = await worker.fetch(await signedRequest(sendAuto(), { id, url: `${ORIGIN}/` }), env, ctx);
    const b = await worker.fetch(await signedRequest(sendAuto(), { id, url: `${ORIGIN}/` }), env, ctx);
    expect(await a.json()).toEqual({ label: 'once' });
    expect(await b.json()).toEqual({ label: 'once' });
    expect(onEntry).toHaveBeenCalledOnce();
    expect(env.BRIDGE_KV.keys()).toContain(`dedupe:done:${id}`);
  });
});

describe('entry.update through the worker', () => {
  it("the destination's onUpdate, else the config's onUpdate, else 501", async () => {
    const own = vi.fn();
    const fallback = vi.fn();
    const env = makeEnv();
    const toId = (id: string) => ({ ...update(), data: { ...update().data, destination: { id, name: id } } });
    const worker = defineWorkerBridge<Env>({
      onUpdate: fallback,
      destinations: () => ({
        bugs: { name: 'Bugs', description: 'Bugs.', onEntry: received(), onUpdate: own },
        test: { name: 'Test', description: 'Tests.', onEntry: received() },
      }),
    });
    const send = async (event: unknown) => (await worker.fetch(await signedRequest(event, { url: `${ORIGIN}/` }), env, ctx)).status;
    expect(await send(update())).toBe(204);
    expect(await send(toId('test'))).toBe(204);
    expect(own).toHaveBeenCalledOnce();
    expect(fallback).toHaveBeenCalledOnce();
    expect(await (await makeWorker().fetch(await signedRequest(toId('test'), { url: `${ORIGIN}/` }), env, ctx)).status).toBe(501);
  });
});

describe('createBridge with a secret function', () => {
  it('resolves per request, follows changes and passes a BridgeError through', async () => {
    let current: string | undefined;
    const bridge = createBridge({
      secret: () => {
        if (!current) throw new BridgeError(503, 'not set up yet');
        return current;
      },
      onEntry: () => {},
    });
    const res = await bridge.fetch(await signedRequest(ping()));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'not set up yet' });

    current = SECRET;
    expect((await bridge.fetch(await signedRequest(ping()))).status).toBe(200);
    current = 'whsec_//79/Pv6+fj39vX08/Lx8O/u7ezr6uno5+bl5OPi4eA=';
    expect((await bridge.fetch(await signedRequest(ping()))).status).toBe(401);
    expect((await bridge.fetch(await signedRequest(ping(), { secret: current }))).status).toBe(200);
  });

  it('answers 500 for an async secret that is malformed or throws, without logging it', async () => {
    const bridge = createBridge({ secret: async () => 'whsec_SECRET-not-base64', onEntry: () => {} });
    expect((await bridge.fetch(await signedRequest(ping()))).status).toBe(500);
    expect(JSON.stringify((console.error as unknown as ReturnType<typeof vi.fn>).mock.calls)).not.toContain('SECRET-not');
    expect(() => createBridge({ secret: 42 as never, onEntry: () => {} })).toThrow(/string or a function/);
  });
});

describe('renderQrSvg', () => {
  it('draws exactly the dark modules, with a white quiet zone', () => {
    const qr = encodeQr('yoink://ausgang?v=1&url=https%3A%2F%2Fx.example%2F&name=Meine%20Bridge');
    const svg = renderQrSvg(qr, { title: 'QR <code>' });
    const dim = qr.size + 8;
    expect(svg).toContain(`viewBox="0 0 ${dim} ${dim}"`);
    expect(svg).toContain('<title>QR &lt;code></title>');
    const grid = Array.from({ length: qr.size }, () => new Array<boolean>(qr.size).fill(false));
    const path = /<path d="([^"]+)"/.exec(svg)![1]!;
    for (const [, x, y, run] of path.matchAll(/M(\d+) (\d+)h(\d+)v1h-\3z/g)) {
      for (let i = 0; i < Number(run); i++) grid[Number(y) - 4]![Number(x) - 4 + i] = true;
    }
    expect(grid).toEqual(qr.modules);
  });
});
