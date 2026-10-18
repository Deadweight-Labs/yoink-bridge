/**
 * `yoink-bridge/cloudflare`: everything a Cloudflare Worker needs around the
 * bridge, so your bridge file only contains your destinations: routing, the
 * one key from yoink (`YOINK_SECRET`), dedupe in KV, `waiting[]` for
 * destinations that miss keys, and a small landing page. The bridge has no
 * website with secrets.
 */
import { buildSetupLink, secretProblem } from '../link.ts';
import { SETTING_NAME_PATTERN } from '../manifest.ts';
import { encodeQr, renderQrSvg } from '../qr.ts';
import {
  createBridge,
  BridgeError,
  type DestinationConfig,
  type Bridge,
  type UndoHandler,
  type UpdateHandler,
} from '../bridge.ts';
import { bytesToBase64 } from '../signature.ts';
import type { ManifestWaiting } from '../types.ts';
import { KVDedupeStore, type KVNamespaceLike } from './kv.ts';
import { dashboardLink, pageHeaders, pickLanguage, renderLanding, strings } from './pages.ts';

export { KVDedupeStore, MemoryKV, KV_KEYS } from './kv.ts';
export type { KVNamespaceLike, KVDedupeStoreOptions } from './kv.ts';
export { received } from '../bridge.ts';

/** Bindings `defineWorkerBridge` uses. Extend it with your own (`interface Env extends WorkerEnv { … }`). */
export interface WorkerEnv {
  /** KV namespace for dedupe (recent `webhook-id`s, kept 48 h). */
  BRIDGE_KV: KVNamespaceLike;
  /**
   * The key yoink created in "Bridge einrichten" (`whsec_` + base64 of 32
   * bytes), added as a Worker secret. Every request must be signed with it.
   */
  YOINK_SECRET?: string;
}

/** The Workers `ExecutionContext` (only what is used here). */
export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

/**
 * A destination in `defineWorkerBridge`: a `DestinationConfig` that can name
 * the env keys (secrets, vars) it needs. While one of them is missing or
 * blank, the destination is listed in the manifest's `waiting[]` with the
 * missing key names (never values), so yoink shows "waiting for …" and sends
 * nothing there.
 */
export type WorkerDestination<Env> = DestinationConfig & {
  requires?: readonly Extract<keyof Env, string>[];
};

export type RouteKey = `GET /${string}` | `POST /${string}`;
export type RouteHandler<Env> = (request: Request, env: Env, ctx: ExecutionContextLike) => Response | Promise<Response>;
type MaybePromise<T> = T | Promise<T>;

export interface WorkerBridgeConfig<Env extends WorkerEnv> {
  /** Display name of the bridge in yoink, max. 60 characters. */
  name?: string;
  /**
   * Your destinations, built from the Worker's env (may be async, e.g. to
   * load them from KV). A destination that is `undefined`, `null` or `false`
   * is left out.
   */
  destinations: (env: Env) => MaybePromise<Record<string, WorkerDestination<Env> | undefined | null | false | ''>>;
  /** How often an async `destinations` runs again, in seconds. Default: 60. A sync one runs once per env. */
  refreshSeconds?: number;
  /** Handles `entry.undo` for destinations without their own `onUndo`. */
  onUndo?: UndoHandler;
  /** Handles `entry.update` for destinations without their own `onUpdate`. */
  onUpdate?: UpdateHandler;
  /** Your own routes, e.g. `{ 'GET /health': () => new Response('ok') }`. `/` is taken. */
  routes?: Partial<Record<RouteKey, RouteHandler<Env>>>;
}

/** A module Worker: `export default defineWorkerBridge({ … })`. */
export interface WorkerBridge<Env> {
  fetch(request: Request, env: Env, ctx: ExecutionContextLike): Promise<Response>;
}

interface State {
  bridge?: Bridge;
  error?: string;
}

interface Slot {
  state?: State;
  pending?: Promise<State>;
  expiresAt: number;
}

/**
 * Defines the Worker. Routes: `POST /` webhook · your `routes` · `GET /` a
 * landing page whose QR code and link open yoink with the bridge URL filled
 * in · else 404.
 *
 * Every request is verified against `YOINK_SECRET`; while it is missing or
 * not a valid key, signed requests answer 503 with the reason and the landing
 * page says what to do. `BRIDGE_KV` holds recent `webhook-id`s for dedupe.
 * Destinations are built and validated once per env (isolate).
 */
export function defineWorkerBridge<Env extends WorkerEnv>(config: WorkerBridgeConfig<Env>): WorkerBridge<Env> {
  if (typeof config?.destinations !== 'function') {
    throw new TypeError('defineWorkerBridge: destinations must be a function (env) => ({ … })');
  }
  const routes = new Map<string, RouteHandler<Env>>();
  for (const [key, handler] of Object.entries(config.routes ?? {})) {
    const match = /^(GET|POST) (\/\S*)$/.exec(key);
    if (!match) throw new TypeError(`defineWorkerBridge: route "${key}" must look like "GET /path" or "POST /path"`);
    if (match[2] === '/') throw new TypeError(`defineWorkerBridge: route "${key}": / is reserved`);
    if (typeof handler !== 'function') throw new TypeError(`defineWorkerBridge: route "${key}" must be a function`);
    routes.set(key, handler as RouteHandler<Env>);
  }
  const refreshMs = Math.max(1, config.refreshSeconds ?? 60) * 1000;
  const slots = new WeakMap<object, Slot>();

  /**
   * The bridge for this env. A sync `destinations` runs once per env; an async
   * one again after `refreshSeconds`. Each request awaits one snapshot, so its
   * manifest and dispatch always agree.
   */
  async function state(env: Env): Promise<State> {
    let slot = slots.get(env);
    if (!slot) {
      slot = { expiresAt: 0 };
      slots.set(env, slot);
    }
    if (slot.state && Date.now() < slot.expiresAt) return slot.state;
    if (!slot.pending) {
      const current = slot;
      current.pending = build(env).then(({ state: next, isAsync }) => {
        current.pending = undefined;
        if (next.bridge || !current.state?.bridge || !isAsync) {
          current.state = next;
          // Errors are retried after 10 s; a good bridge lasts `refreshSeconds` (async) or for good (sync).
          current.expiresAt = !next.bridge ? Date.now() + 10_000 : isAsync ? Date.now() + refreshMs : Infinity;
        } else {
          // A refresh failed (e.g. KV unreachable): keep the last good bridge, try again soon.
          current.expiresAt = Date.now() + 10_000;
        }
        return current.state!;
      });
    }
    return slot.pending!;
  }

  async function build(env: Env): Promise<{ state: State; isAsync: boolean }> {
    let isAsync = false;
    try {
      if (!env?.BRIDGE_KV) throw new Error('the KV binding BRIDGE_KV is missing (see wrangler.jsonc)');
      const result = config.destinations(env);
      isAsync = typeof (result as Promise<unknown> | undefined)?.then === 'function';
      const all = await result;
      const destinations: Record<string, DestinationConfig> = {};
      const waiting: ManifestWaiting[] = [];
      for (const [id, destination] of Object.entries(all ?? {})) {
        if (!destination) continue;
        const { requires, ...rest } = destination;
        if (requires !== undefined) {
          if (
            !Array.isArray(requires) ||
            requires.length > 10 ||
            requires.some((key) => typeof key !== 'string' || !SETTING_NAME_PATTERN.test(key))
          ) {
            throw new TypeError(
              `destination "${id}": requires must list up to 10 env key names matching ${SETTING_NAME_PATTERN.source}`,
            );
          }
          const missing = requires.filter((key) => isMissing((env as Record<string, unknown>)[key]));
          if (missing.length > 0) {
            waiting.push({ id, name: rest.name, missing: [...missing] });
            continue; // not a destination until its keys exist
          }
        }
        destinations[id] = rest;
      }
      const bridge = createBridge({
        secret: () => workerSecret(env),
        name: config.name,
        destinations,
        waiting,
        settingsUrl: (request) => dashboardLink(new URL(request.url).hostname),
        onUndo: config.onUndo,
        onUpdate: config.onUpdate,
        dedupe: new KVDedupeStore(env.BRIDGE_KV),
      });
      return { state: { bridge }, isAsync };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[yoink-bridge] configuration error: ${message}`);
      return { state: { error: message }, isAsync };
    }
  }

  return {
    async fetch(request: Request, env: Env, ctx: ExecutionContextLike): Promise<Response> {
      const url = new URL(request.url);
      const method = request.method;
      try {
        if (url.pathname === '/' && method !== 'GET' && method !== 'HEAD') {
          const { bridge } = await state(env);
          return bridge ? await bridge.fetch(request) : jsonResponse(500, { error: 'bridge configuration error' });
        }
        const route = routes.get(`${method === 'HEAD' ? 'GET' : method} ${url.pathname}`);
        if (route) return await route(request, env, ctx);
        if (url.pathname === '/') return landing(request, url, config.name, env);
        return new Response(`${strings(pickLanguage(request.headers.get('accept-language'))).notFound}\n`, {
          status: 404,
          headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
        });
      } catch (error) {
        console.error('[yoink-bridge] request failed', error);
        return jsonResponse(500, { error: 'internal error' });
      }
    },
  };
}

/** The landing page: bridge name, a link + QR code that open yoink with this URL (never a key), and key status. */
function landing(request: Request, url: URL, name: string | undefined, env: WorkerEnv | undefined): Response {
  const lang = pickLanguage(request.headers.get('accept-language'));
  const bridgeUrl = `${url.origin}/`;
  const link = buildSetupLink({ url: bridgeUrl, name });
  const nonce = bytesToBase64(crypto.getRandomValues(new Uint8Array(16)));
  const html = renderLanding(
    lang,
    {
      name,
      url: bridgeUrl,
      link,
      qrSvg: renderQrSvg(encodeQr(link), { title: strings(lang).qr }),
      keyProblem: secretProblem(env?.YOINK_SECRET) ?? undefined,
      settingsUrl: dashboardLink(url.hostname),
    },
    nonce,
  );
  return new Response(html, {
    status: 200,
    headers: { ...pageHeaders(nonce), 'content-language': lang, vary: 'Accept-Language' },
  });
}

/** `YOINK_SECRET`, trimmed; a 503 with the reason while it is missing or not a valid key. */
function workerSecret(env: WorkerEnv): string {
  const problem = secretProblem(env.YOINK_SECRET);
  if (problem === 'missing') {
    throw new BridgeError(
      503,
      'YOINK_SECRET is not set on this bridge: add the key from yoink (Einstellungen › Ausgänge › Bridge einrichten › ' +
        'Schlüssel kopieren) as a secret in the Worker settings',
    );
  }
  if (problem === 'invalid') {
    throw new BridgeError(
      503,
      'YOINK_SECRET is not a valid key (expected whsec_ + base64 of 32 bytes, as yoink copies it): ' +
        'paste it again in the Worker settings',
    );
  }
  return (env.YOINK_SECRET as string).trim();
}

/** An env key counts as missing when it is absent or a blank string. */
function isMissing(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

function jsonResponse(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}
