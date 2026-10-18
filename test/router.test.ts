/**
 * The router recipe (recipes/router.ts) with a fake Anthropic API: a real
 * SDK client whose fetch answers locally, so no network and no key needed.
 */
import Anthropic from '@anthropic-ai/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claudeClassifier, createRouter, MODEL, routerDestinations, type Classification } from '../template/recipes/router.ts';
import { defineWorkerBridge, MemoryKV } from '../src/cloudflare/index.ts';
import { generateSecret, parseManifest, BridgeError, signWebhook, type EntrySendEvent } from '../src/index.ts';

const event: EntrySendEvent = {
  version: 1,
  type: 'entry.send',
  timestamp: '2026-10-16T09:00:00Z',
  data: {
    app: { name: 'yoink', build: 'test' },
    connection: { id: 'c', name: 'Meine Bridge' },
    destination: { id: 'inbox', name: 'Inbox · KI-Router' },
    trigger: 'auto',
    entry: {
      id: '3c9e8f20-6b1a-4d2e-8f3a-5b6c7d8e9f01',
      title: null,
      text: 'App stürzt ab, wenn ich ein Video über 1 Minute teile',
      project: 'yoink',
      type: 'todo',
      due: null,
      created_at: '2026-10-16T08:59:30Z',
      source_url: null,
      attachments: [{ kind: 'image', name: 'screenshot-0.jpg' }],
    },
    fit: null,
  },
};

const ctx = { id: 'msg_1', timestamp: 1, request: new Request('https://bridge.example/') };

type Reply = { status?: number; body: unknown };

/** A real Anthropic client talking to a fake API. */
function fakeClaude(reply: Reply) {
  const requests: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
  const client = new Anthropic({
    apiKey: 'test-key',
    baseURL: 'https://api.anthropic.com', // independent of ANTHROPIC_BASE_URL in the test environment
    maxRetries: 0,
    fetch: (async (url: string, init: RequestInit) => {
      requests.push({ url: String(url), headers: new Headers(init.headers), body: JSON.parse(init.body as string) });
      return new Response(JSON.stringify(reply.body), {
        status: reply.status ?? 200,
        headers: { 'content-type': 'application/json', 'request-id': 'req_test' },
      });
    }) as never,
  });
  return { client, requests };
}

const message = (classification: Classification | null, stop_reason = 'end_turn') => ({
  id: 'msg_test',
  type: 'message',
  role: 'assistant',
  model: MODEL,
  content: classification ? [{ type: 'text', text: JSON.stringify(classification) }] : [],
  stop_reason,
  stop_sequence: null,
  ...(stop_reason === 'refusal' ? { stop_details: { type: 'refusal', category: 'cyber', explanation: 'test' } } : {}),
  usage: { input_tokens: 100, output_tokens: 50 },
});

const bug: Classification = {
  kind: 'bug',
  title: 'Absturz beim Teilen langer Videos',
  summary: 'Die App stürzt ab, wenn ein Video **über 1 Minute** geteilt wird.',
  priority: 2,
  labels: ['Bug', 'Erfunden'],
};

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('router recipe', () => {
  it('asks Claude Opus 5.5 with structured outputs, effort and server-side fallbacks', async () => {
    const { client, requests } = fakeClaude({ body: message(bug) });
    expect(await claudeClassifier(client, { labels: ['Bug'] })(event)).toEqual(bug);
    const [request] = requests;
    expect(request!.url).toBe('https://api.anthropic.com/v1/messages?beta=true');
    expect(request!.headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01');
    expect(request!.headers.get('x-api-key')).toBe('test-key');
    const body = request!.body as Record<string, any>;
    expect(body.model).toBe('claude-opus-5-5');
    expect(body.fallbacks).toBe('default');
    expect(body.output_config.effort).toBe('medium');
    expect(body.output_config.format.type).toBe('json_schema');
    expect(body).not.toHaveProperty('thinking');
    expect(body).not.toHaveProperty('betas');
    expect(body.system).toContain('pick only from ["Bug"]');
    const prompt = body.messages[0].content as string;
    expect(prompt).toContain('App stürzt ab');
    expect(prompt).toContain('"project": "yoink"');
    expect(prompt).toContain('image: screenshot-0.jpg');
  });

  it('bug → Linear issue with the fields Claude filled in (only allowed labels)', async () => {
    const createIssue = vi.fn(async () => ({ url: 'https://linear.app/x/issue/ABC-1', label: 'ABC-1', external_id: 'iss' }));
    const post = vi.fn();
    const { client } = fakeClaude({ body: message(bug) });
    const router = createRouter({ classify: claudeClassifier(client), linear: { createIssue }, chat: { post }, labels: ['Bug'] });
    expect(await router(event, ctx)).toEqual({ url: 'https://linear.app/x/issue/ABC-1', label: 'ABC-1', external_id: 'iss' });
    expect(createIssue).toHaveBeenCalledWith(event, {
      title: 'Absturz beim Teilen langer Videos',
      description: expect.stringMatching(/^Die App stürzt ab.*\n\n---\n\nApp stürzt ab, wenn ich ein Video.*\n\n— via yoink · bug$/s),
      priority: 2,
      labelNames: ['Bug'],
    });
    expect(post).not.toHaveBeenCalled();
  });

  it('shopping → Slack; other → ignored; bug without Linear → ignored', async () => {
    const post = vi.fn(async () => {});
    const shopping = createRouter({
      classify: claudeClassifier(fakeClaude({ body: message({ ...bug, kind: 'shopping', title: 'Milch & <Eier>' }) }).client),
      chat: { post },
    });
    expect(await shopping(event, ctx)).toEqual({ label: 'Slack' });
    expect(post).toHaveBeenCalledWith('🛒 Milch &amp; &lt;Eier&gt;');

    const other = createRouter({ classify: claudeClassifier(fakeClaude({ body: message({ ...bug, kind: 'other' }) }).client) });
    expect(await other(event, ctx)).toEqual({ ignored: true });

    const noLinear = createRouter({ classify: claudeClassifier(fakeClaude({ body: message(bug) }).client) });
    expect(await noLinear(event, ctx)).toEqual({ ignored: true });
  });

  it('a refusal is checked before the content and ignored with a log line', async () => {
    const createIssue = vi.fn();
    const router = createRouter({
      classify: claudeClassifier(fakeClaude({ body: message(null, 'refusal') }).client),
      linear: { createIssue },
    });
    expect(await router(event, ctx)).toEqual({ ignored: true });
    expect(createIssue).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Claude declined'));
  });

  it('API errors: outages are retryable (502), a rejected key is permanent (422)', async () => {
    const status = async (reply: Reply) => {
      const error = await claudeClassifier(fakeClaude(reply).client)(event).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BridgeError);
      return (error as BridgeError).status;
    };
    const apiError = (type: string, message = 'x') => ({ type: 'error', error: { type, message } });
    expect(await status({ status: 500, body: apiError('api_error') })).toBe(502);
    expect(await status({ status: 529, body: apiError('overloaded_error') })).toBe(502);
    expect(await status({ status: 429, body: apiError('rate_limit_error') })).toBe(502);
    expect(await status({ status: 401, body: apiError('authentication_error') })).toBe(422);
    expect(await status({ status: 400, body: apiError('invalid_request_error') })).toBe(422);
    expect(await status({ body: { ...message(null), content: [{ type: 'text', text: 'not json' }] } })).toBe(502);
  });

  it('inbox appears in mode "all" only with ANTHROPIC_API_KEY; until then it waits', async () => {
    const secret = generateSecret();
    const worker = defineWorkerBridge({ destinations: (env) => routerDestinations(env) });
    const manifest = async (env: Record<string, unknown>) => {
      const body = JSON.stringify({ version: 1, type: 'ping', timestamp: '2026-10-16T09:00:00Z', data: { app: { name: 'yoink', build: 't' }, connection: { id: 'c', name: 'c' } } });
      const timestamp = Math.floor(Date.now() / 1000);
      const request = new Request('https://bridge.example/', {
        method: 'POST',
        headers: { 'webhook-id': 'msg_t', 'webhook-timestamp': String(timestamp), 'webhook-signature': await signWebhook({ secret, id: 'msg_t', timestamp, body }) },
        body,
      });
      const res = await worker.fetch(request, { BRIDGE_KV: new MemoryKV(), YOINK_SECRET: secret, ...env }, { waitUntil() {} });
      return res.status === 200 ? parseManifest(await res.text()) : res.status;
    };
    const waiting = async (env: Record<string, unknown>) => {
      const result = await manifest(env);
      return typeof result === 'number' ? result : result.waiting;
    };
    const ping = async (env: Record<string, unknown>) => {
      const result = await manifest(env);
      return typeof result === 'number' ? result : result.destinations;
    };
    expect(await ping({ SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/x' })).toEqual([]);
    expect(await waiting({})).toEqual([{ id: 'inbox', name: 'Inbox · KI-Router', missing: ['ANTHROPIC_API_KEY'] }]);
    expect(await ping({ ANTHROPIC_API_KEY: 'sk-ant-test' })).toEqual([
      expect.objectContaining({ id: 'inbox', mode: 'all' }),
    ]);
  });
});
