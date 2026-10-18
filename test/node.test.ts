import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntrySendEvent } from '../src/index.ts';
import { toNodeHandler } from '../src/node.ts';
import { bugsBridge, newId, sendAuto, signedHeaders } from './helpers.ts';

let server: Server | undefined;

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  server = createServer(handler);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/yoink`;
}

describe('toNodeHandler', () => {
  it('round-trips a signed delivery through a real http server', async () => {
    const received: EntrySendEvent[] = [];
    const bridge = bugsBridge((event, ctx) => {
      received.push(event);
      expect(new URL(ctx.request.url).pathname).toBe('/yoink');
      return { label: 'ABC-12', external_id: 'ext_1' };
    });
    const url = await listen(toNodeHandler(bridge));

    const body = JSON.stringify(sendAuto());
    const id = newId();
    const res = await fetch(url, { method: 'POST', headers: await signedHeaders(body, { id }), body });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    expect(await res.json()).toEqual({ label: 'ABC-12', external_id: 'ext_1' });
    expect(received).toEqual([sendAuto()]);

    // Retry with the same id: replayed, handler not called again.
    const retry = await fetch(url, { method: 'POST', headers: await signedHeaders(body, { id }), body });
    expect(await retry.json()).toEqual({ label: 'ABC-12', external_id: 'ext_1' });
    expect(received).toHaveLength(1);
  });

  it('verifies the raw bytes (umlauts, emoji) exactly as sent', async () => {
    const bridge = bugsBridge(() => {});
    const url = await listen(toNodeHandler(bridge));
    // Unusual but valid JSON spacing: re-serializing would break the signature.
    const body = JSON.stringify(sendAuto(), null, 3);
    const res = await fetch(url, { method: 'POST', headers: await signedHeaders(body), body });
    expect(res.status).toBe(204);

    const bad = await fetch(url, { method: 'POST', headers: await signedHeaders(body), body: body.replace('ü', 'u') });
    expect(bad.status).toBe(401);
  });

  it('answers 405 for GET and 413 above the limit', async () => {
    const bridge = bugsBridge(() => {});
    const url = await listen(toNodeHandler(bridge, { maxBodyBytes: 64 }));
    const get = await fetch(url);
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');

    const body = JSON.stringify(sendAuto());
    const big = await fetch(url, { method: 'POST', headers: await signedHeaders(body), body });
    expect(big.status).toBe(413);
  });

  it('413 for a chunked body without content-length', async () => {
    const bridge = bugsBridge(() => {});
    const url = new URL(await listen(toNodeHandler(bridge, { maxBodyBytes: 64 })));
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(url, { method: 'POST', headers: { 'transfer-encoding': 'chunked' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.write('x'.repeat(50));
      req.write('x'.repeat(50));
      req.end();
    });
    expect(status).toBe(413);
  });

  it('uses a raw Buffer body left by express.raw()', async () => {
    const onEntry = vi.fn();
    const bridge = bugsBridge(onEntry);
    const handler = toNodeHandler(bridge);
    const url = await listen((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        (req as IncomingMessage & { body?: Buffer }).body = Buffer.concat(chunks);
        void handler(req, res);
      });
    });
    const body = JSON.stringify(sendAuto());
    const res = await fetch(url, { method: 'POST', headers: await signedHeaders(body), body });
    expect(res.status).toBe(204);
    expect(onEntry).toHaveBeenCalledOnce();
  });

  it('500 with an explanation when a body parser already consumed the stream', async () => {
    const bridge = bugsBridge(() => {});
    const handler = toNodeHandler(bridge);
    const url = await listen((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        (req as IncomingMessage & { body?: unknown }).body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        void handler(req, res);
      });
    });
    const body = JSON.stringify(sendAuto());
    const res = await fetch(url, { method: 'POST', headers: await signedHeaders(body), body });
    expect(res.status).toBe(500);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('already consumed'));
  });
});
