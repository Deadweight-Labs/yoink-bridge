/**
 * Checks bridge.ts, the Worker you deploy, the way yoink sees it: a signed
 * ping must answer a manifest that yoink reads completely (nothing skipped or
 * cut). `npm run build` runs this before every deploy, so a broken bridge
 * never goes live. Change the expectations when you change bridge.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import worker from '../bridge.ts';
import { MemoryKV } from 'yoink-bridge/cloudflare';
import { describeBridge, generateSecret, parseManifest, signWebhook } from 'yoink-bridge';

const ctx = { waitUntil() {} };
const secret = generateSecret();
const ORIGIN = 'https://yoink-bridge.example.workers.dev';

/** A fake env. Values are placeholders: nothing is sent anywhere in these tests. */
function env(extra: Record<string, string | undefined> = {}) {
  return { BRIDGE_KV: new MemoryKV(), YOINK_SECRET: secret, ...extra };
}

const allKeys = {
  LINEAR_API_KEY: 'lin_api_placeholder',
  LINEAR_TEAM: 'ABC',
  GITHUB_TOKEN: 'github_pat_placeholder',
  GITHUB_REPO: 'octo/app',
};

async function ping(fakeEnv: ReturnType<typeof env>) {
  const id = `msg_bridge_ts_${Math.random().toString(16).slice(2)}`;
  const timestamp = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({
    version: 1,
    type: 'ping',
    timestamp: new Date().toISOString(),
    data: { app: { name: 'yoink', build: 'test' }, connection: { id: 'test', name: 'test' } },
  });
  const request = new Request(`${ORIGIN}/`, {
    method: 'POST',
    headers: {
      'webhook-id': id,
      'webhook-timestamp': String(timestamp),
      'webhook-signature': await signWebhook({ secret, id, timestamp, body }),
    },
    body,
  });
  return worker.fetch(request, fakeEnv, ctx);
}

describe('bridge.ts', () => {
  it('answers a manifest that yoink reads completely', async () => {
    const res = await ping(env(allKeys));
    expect(res.status).toBe(200);
    const text = await res.text();
    const declared = (JSON.parse(text) as { destinations: unknown[] }).destinations;
    const parsed = parseManifest(text);
    expect(parsed.destinations).toHaveLength(declared.length);
    expect(parsed.destinations.length).toBeGreaterThan(0);
    expect(describeBridge(text)).toContain('yoink reads');
  });

  it('Linear and GitHub: alternatives in group "tracker", suggestions only, with a description', async () => {
    const parsed = parseManifest(await (await ping(env(allKeys))).text());
    expect(parsed.bridgeName).toBe('Meine Bridge');
    expect(parsed.settingsUrl).toBe('https://dash.cloudflare.com/?to=/:account/workers/services/view/yoink-bridge/production/settings');
    expect(parsed.destinations.map(({ id, name, mode, group }) => ({ id, name, mode, group }))).toEqual([
      { id: 'linear', name: 'Linear', mode: 'suggest', group: 'tracker' },
      { id: 'github', name: 'GitHub · Issues', mode: 'suggest', group: 'tracker' },
    ]);
    for (const d of parsed.destinations) expect(d.description).toMatch(/^Konkrete Aufgaben und Fehler/);
  });

  it('a fresh deploy (only YOINK_SECRET) answers with both waiting for their settings, names only', async () => {
    const fresh = parseManifest(await (await ping(env())).text());
    expect(fresh.destinations).toEqual([]);
    expect(fresh.waiting).toEqual([
      { id: 'linear', name: 'Linear', missing: ['LINEAR_API_KEY', 'LINEAR_TEAM'] },
      { id: 'github', name: 'GitHub · Issues', missing: ['GITHUB_TOKEN', 'GITHUB_REPO'] },
    ]);
    const half = await (await ping(env({ GITHUB_TOKEN: 'github_pat_VALUE', LINEAR_API_KEY: 'lin_api_VALUE', LINEAR_TEAM: 'ABC' }))).text();
    expect(parseManifest(half).destinations.map((d) => d.id)).toEqual(['linear']);
    expect(parseManifest(half).waiting).toEqual([{ id: 'github', name: 'GitHub · Issues', missing: ['GITHUB_REPO'] }]);
    expect(half).not.toMatch(/github_pat_VALUE|lin_api_VALUE/);
  });

  it('sends an entry to GitHub with the configured repository', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      Response.json({ number: 7, html_url: 'https://github.com/octo/app/issues/7' }, { status: 201 }),
    );
    try {
      const body = JSON.stringify({
        version: 1,
        type: 'entry.send',
        timestamp: new Date().toISOString(),
        data: {
          app: { name: 'yoink', build: 'test' },
          connection: { id: 'test', name: 'test' },
          destination: { id: 'github', name: 'GitHub · Issues' },
          trigger: 'suggestion',
          entry: {
            id: 'e1', title: null, text: 'Login-Button reagiert nicht', project: null, type: 'todo', due: null,
            created_at: new Date().toISOString(), source_url: null, attachments: [],
          },
          fit: { probability: 0.7 },
        },
      });
      const id = 'msg_bridge_ts_send';
      const timestamp = Math.floor(Date.now() / 1000);
      const res = await worker.fetch(
        new Request(`${ORIGIN}/`, {
          method: 'POST',
          headers: { 'webhook-id': id, 'webhook-timestamp': String(timestamp), 'webhook-signature': await signWebhook({ secret, id, timestamp, body }) },
          body,
        }),
        env(allKeys),
        ctx,
      );
      expect(await res.json()).toEqual({ url: 'https://github.com/octo/app/issues/7', label: '#7', external_id: 'octo/app#7' });
      expect(fetch.mock.calls[0]![0]).toBe('https://api.github.com/repos/octo/app/issues');
    } finally {
      fetch.mockRestore();
    }
  });

  it('an edit after sending becomes a comment on the GitHub issue, nothing is overwritten', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ id: 1 }, { status: 201 }));
    try {
      const body = JSON.stringify({
        version: 1,
        type: 'entry.update',
        timestamp: new Date().toISOString(),
        data: {
          app: { name: 'yoink', build: 'test' },
          connection: { id: 'test', name: 'test' },
          destination: { id: 'github', name: 'GitHub · Issues' },
          delivery_id: 'msg_bridge_ts_send',
          external_id: 'octo/app#7',
          entry: {
            id: 'e1', title: 'Login', text: 'Login-Button reagiert nicht', project: null, type: 'todo', due: null,
            created_at: new Date().toISOString(), source_url: null, attachments: [],
          },
          previous: { title: null, text: 'Login-Button reagiert nicht', due: null },
          changes: ['title'],
        },
      });
      const id = 'msg_bridge_ts_update';
      const timestamp = Math.floor(Date.now() / 1000);
      const res = await worker.fetch(
        new Request(`${ORIGIN}/`, {
          method: 'POST',
          headers: { 'webhook-id': id, 'webhook-timestamp': String(timestamp), 'webhook-signature': await signWebhook({ secret, id, timestamp, body }) },
          body,
        }),
        env(allKeys),
        ctx,
      );
      expect(res.status).toBe(204);
      expect(fetch).toHaveBeenCalledOnce();
      const [url, init] = fetch.mock.calls[0]!;
      expect(url).toBe('https://api.github.com/repos/octo/app/issues/7/comments');
      expect(init!.method).toBe('POST');
      expect(JSON.parse(init!.body as string)).toEqual({
        body: '**In yoink geändert**\n\nTitel: — → Login\n\n— via yoink',
      });
    } finally {
      fetch.mockRestore();
    }
  });

  it('without YOINK_SECRET: 503 with the reason, and the start page says what to do', async () => {
    const noKey = env({ YOINK_SECRET: undefined });
    const res = await ping(noKey);
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/^YOINK_SECRET is not set/);
    const html = await (await worker.fetch(new Request(`${ORIGIN}/`), noKey, ctx)).text();
    expect(html).toContain('The key is missing');
  });

  it('serves the start page: a link with the URL, never a key', async () => {
    const res = await worker.fetch(new Request(`${ORIGIN}/`), env(), ctx);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('yoink://ausgang?v=1&#38;url=https%3A%2F%2Fyoink-bridge.example.workers.dev%2F&#38;name=Meine%20Bridge');
    expect(html).not.toMatch(/whsec_|secret=/);
    expect(html).not.toContain('role="alert"');
  });
});
