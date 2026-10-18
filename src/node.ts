import type { IncomingMessage, ServerResponse } from 'node:http';
import { webcrypto } from 'node:crypto';
import { DEFAULT_MAX_BODY_BYTES, type Bridge } from './bridge.ts';

// Node 18 has no global `crypto`; the bridge needs `crypto.subtle`.
if (!globalThis.crypto) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true, writable: true });
}

export interface NodeHandlerOptions {
  /**
   * Largest body the adapter buffers before answering 413. Keep it in sync
   * with `maxBodyBytes` of `createBridge`. Default: 1 MiB.
   */
  maxBodyBytes?: number;
}

export type NodeHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

/**
 * Adapts a bridge to Node's `http`/`https` servers (and Express/Connect/Fastify
 * middleware that hands out the raw `req`/`res`).
 *
 * The body must reach the bridge unparsed. Mount the handler before any JSON
 * body parser, or use `express.raw({ type: '*\/*' })`, which leaves a Buffer
 * in `req.body` that this adapter picks up.
 */
export function toNodeHandler(bridge: Bridge, options: NodeHandlerOptions = {}): NodeHandler {
  const limit = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  return async (req, res) => {
    try {
      const method = req.method ?? 'GET';
      let body: Uint8Array<ArrayBuffer> | null = null;
      if (method !== 'GET' && method !== 'HEAD') {
        const read = await readRawBody(req, limit);
        if (read === 'too-large') return send(res, 413, '{"error":"payload too large"}');
        if (read === 'consumed') {
          console.error(
            '[yoink-bridge] the request body was already consumed by another middleware; ' +
              'mount the bridge before body parsers or use express.raw()',
          );
          return send(res, 500, '{"error":"raw body unavailable"}');
        }
        body = read;
      }

      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) for (const v of value) headers.append(name, v);
        else headers.set(name, value);
      }
      const protocol = (req.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http';
      const url = new URL(req.url ?? '/', `${protocol}://${req.headers.host ?? 'localhost'}`);
      const request = new Request(url, { method, headers, body });

      const response = await bridge.fetch(request);
      res.statusCode = response.status;
      response.headers.forEach((value, name) => res.setHeader(name, value));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      console.error('[yoink-bridge] node adapter failed', error);
      if (!res.headersSent) send(res, 500, '{"error":"internal error"}');
      else res.end();
    }
  };
}

function send(res: ServerResponse, status: number, json: string): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(json);
}

type BodyResult = Uint8Array<ArrayBuffer> | 'too-large' | 'consumed';

async function readRawBody(req: IncomingMessage, limit: number): Promise<BodyResult> {
  // Already buffered by express.raw()/express.text() or similar.
  const preRead = (req as IncomingMessage & { body?: unknown }).body;
  if (Buffer.isBuffer(preRead)) return preRead.length > limit ? 'too-large' : new Uint8Array(preRead);
  if (typeof preRead === 'string') {
    const bytes = new TextEncoder().encode(preRead);
    return bytes.length > limit ? 'too-large' : bytes;
  }
  // Someone else (e.g. express.json()) has read the stream: the raw bytes are gone.
  if (req.readableEnded) return 'consumed';

  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) {
    req.resume(); // drain and discard
    return 'too-large';
  }

  return new Promise<BodyResult>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    req.on('data', (chunk: Buffer) => {
      if (done) return;
      total += chunk.length;
      if (total > limit) {
        done = true;
        chunks.length = 0;
        resolve('too-large'); // keep draining in the background
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!done) resolve(new Uint8Array(Buffer.concat(chunks, total)));
    });
    req.on('error', (error) => {
      if (!done) reject(error);
    });
  });
}
