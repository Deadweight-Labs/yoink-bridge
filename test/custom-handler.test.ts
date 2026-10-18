/** The custom-handler recipe (recipes/custom-handler.ts), with a fake endpoint. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forwardDestination } from '../template/recipes/custom-handler.ts';
import { defineWorkerBridge, MemoryKV, type WorkerEnv } from '../src/cloudflare/index.ts';
import { parseManifest, BridgeError } from '../src/index.ts';
import { SECRET, ping, sendManual, signedRequest } from './helpers.ts';

const ctx = { id: 'msg_1', timestamp: 1, request: new Request('https://bridge.example/') };
const options = { name: 'Notizen', description: 'Längere Gedanken zu Büchern.' };

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('custom-handler recipe', () => {
  it('posts the entry as JSON, with the token, and answers the receipt', async () => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ url: 'https://notes.example/p/1', label: 'Notiz' }));
    const destination = forwardDestination({ BRIDGE_KV: new MemoryKV(), FORWARD_URL: ' https://hook.example/in ', FORWARD_TOKEN: 'tok' }, { ...options, fetch });
    expect(await destination.onEntry(sendManual(), ctx)).toEqual({ label: 'Notiz', url: 'https://notes.example/p/1' });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://hook.example/in');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer tok');
    expect(JSON.parse(init.body as string)).toEqual({
      id: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
      title: null,
      text: 'Zahnarzt anrufen',
      project: null,
      due: '2026-10-16T13:00:00Z',
      link: 'https://example.com/praxis',
      created_at: '2026-10-15T18:01:50Z',
      destination: 'einkauf',
      trigger: 'manual',
    });
  });

  it('a plain 200 gets the default label; 5xx is retried, 4xx is final', async () => {
    const answer = (status: number, body = '') => forwardDestination({ BRIDGE_KV: new MemoryKV(), FORWARD_URL: 'https://hook.example/' }, { ...options, fetch: async () => new Response(body, { status }) });
    expect(await answer(200, 'ok').onEntry(sendManual(), ctx)).toEqual({ label: 'Weitergeleitet', url: undefined });
    for (const [status, expected] of [[500, 502], [429, 502], [404, 422]] as const) {
      const error = await Promise.resolve(answer(status).onEntry(sendManual(), ctx)).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BridgeError);
      expect((error as BridgeError).status).toBe(expected);
    }
  });

  it('waits for FORWARD_URL in the manifest', async () => {
    const worker = defineWorkerBridge<WorkerEnv & { FORWARD_URL?: string }>({ destinations: (env) => ({ notes: forwardDestination(env, options) }) });
    const res = await worker.fetch(await signedRequest(ping(), { url: 'https://r.example.workers.dev/' }), { BRIDGE_KV: new MemoryKV(), YOINK_SECRET: SECRET }, { waitUntil() {} });
    expect(parseManifest(await res.text()).waiting).toEqual([{ id: 'notes', name: 'Notizen', missing: ['FORWARD_URL'] }]);
  });
});
