import { MemoryDedupeStore, type DedupeStore, type StoredResponse } from './dedupe.ts';
import { DESTINATION_ID_PATTERN, GROUP_PATTERN, MANIFEST_LIMITS, SETTING_NAME_PATTERN, textLength } from './manifest.ts';
import {
  DEFAULT_TOLERANCE_SECONDS,
  importSecretKey,
  readHeader,
  verifyWithKey,
  decodeSecret,
  type VerifyFailureReason,
} from './signature.ts';
import type {
  DestinationMode,
  EntrySendEvent,
  EntryUndoEvent,
  EntryUpdateEvent,
  Ignored,
  Manifest,
  ManifestDestination,
  ManifestWaiting,
  PingEvent,
  Receipt,
} from './types.ts';
import { SDK_VERSION } from './version.ts';

/** Per-delivery context handed to every handler. */
export interface BridgeContext {
  /** `webhook-id`: identical across retries of the same delivery. */
  id: string;
  /** `webhook-timestamp` of this attempt, Unix seconds. */
  timestamp: number;
  /** The original request (its body has already been read). */
  request: Request;
}

type MaybePromise<T> = T | Promise<T>;

/**
 * Handles `entry.send`. Return a `Receipt` to answer 200 with exactly those
 * fields, `ignore()` to answer `{"ignored":true}` (taken and dropped; yoink
 * shows nothing), or nothing to answer 204.
 */
export type EntryHandler = (event: EntrySendEvent, ctx: BridgeContext) => MaybePromise<Receipt | Ignored | void>;

const IGNORED: Ignored = Object.freeze({ ignored: true as const });

/**
 * Answer for an entry your code takes but drops (typical in `mode: 'all'`):
 * the bridge answers 200 `{"ignored":true}` and yoink shows no receipt and no
 * hint. `return ignore();`
 */
export function ignore(): Ignored {
  return IGNORED;
}
/** Handles `entry.undo`; answers 204. */
export type UndoHandler = (event: EntryUndoEvent, ctx: BridgeContext) => MaybePromise<void>;
/**
 * Handles `entry.update` (the entry was edited in yoink after it was sent
 * here); answers 204. Throw a `BridgeError` with 4xx to drop this change, 5xx
 * to have yoink try again; 501 means "no updates for this delivery".
 */
export type UpdateHandler = (event: EntryUpdateEvent, ctx: BridgeContext) => MaybePromise<void>;

/**
 * A destination: where matching entries go, and in plain words what belongs
 * there. yoink checks every new entry against the description.
 */
export interface DestinationConfig {
  /** Display name in yoink, max. 60 characters. */
  name: string;
  /**
   * What belongs here (and what doesn't), max. 500 characters. This is the
   * whole configuration: yoink's decision model reads it for every new
   * entry. Without one, nothing is sent automatically.
   */
  description?: string;
  /** Only entries of these yoink projects qualify (case-insensitive). Omit for every entry. */
  projects?: string[];
  /**
   * Default: `auto` with a description, `manual` without. `all`: every new
   * entry comes here unchecked and your code decides (no description needed;
   * the user switches it on in yoink).
   */
  mode?: DestinationMode;
  /**
   * Destinations with the same group are alternatives: an entry goes to at
   * most one of them (yoink asks "A, B or neither?"). Without a group a
   * destination is checked on its own. Same pattern as ids:
   * `[a-z0-9][a-z0-9_-]{0,39}`.
   */
  group?: string;
  onEntry: EntryHandler;
  /** Handles `entry.undo` for this destination; falls back to the top-level `onUndo`. */
  onUndo?: UndoHandler;
  /**
   * Handles `entry.update` for this destination; falls back to the top-level
   * `onUpdate`. Without one the bridge answers 501 and yoink sends no more
   * updates for that delivery.
   */
  onUpdate?: UpdateHandler;
}

/** The secret, or a function that returns it (called per request; it may throw a `BridgeError`). */
export type SecretSource = string | (() => string | Promise<string>);

interface CommonBridgeOptions {
  /**
   * The `whsec_…` key every request is signed with: the one yoink created
   * when the user set up the bridge. Or a function returning it per request
   * (e.g. from the environment); it may throw a `BridgeError` to answer with
   * its status and message, say 503 while the key is not configured.
   */
  secret: SecretSource;
  /**
   * `relay.settings_url`: where the user adds the bridge's keys (`https://`
   * only). A function is evaluated per `ping`.
   */
  settingsUrl?: string | ((request: Request) => string | undefined);
  /** `waiting[]`: destinations in code that still miss settings (names only, never values). */
  waiting?: ManifestWaiting[];
  /** Display name of the bridge in yoink, max. 60 characters. */
  name?: string;
  /** Handles `entry.undo` for destinations without their own `onUndo`. Without any, undo answers 501. */
  onUndo?: UndoHandler;
  /** Handles `entry.update` for destinations without their own `onUpdate`. Without any, updates answer 501. */
  onUpdate?: UpdateHandler;
  /**
   * Runs on `ping`. Return an object to add fields to the manifest (it can't
   * replace `bridge` or `destinations`). Throw a `BridgeError` to make the
   * connection test fail.
   */
  onPing?: (event: PingEvent, ctx: BridgeContext) => MaybePromise<Record<string, unknown> | void>;
  /** Where delivery state lives. Default: a `MemoryDedupeStore`. */
  dedupe?: DedupeStore;
  /** Allowed clock skew in seconds. Default: 300. */
  toleranceSeconds?: number;
  /** Largest accepted body. Default: 1 MiB. */
  maxBodyBytes?: number;
}

export type BridgeOptions = CommonBridgeOptions &
  (
    | {
        /** Your destinations, keyed by a stable id (`[a-z0-9][a-z0-9_-]{0,39}`). Max. 20. */
        destinations: Record<string, DestinationConfig>;
        onEntry?: never;
      }
    | {
        /**
         * Short form: one destination `default` named after the bridge, in
         * `manual` mode (only "Send to …" by hand). Use `destinations` to have
         * yoink route entries automatically.
         */
        onEntry: EntryHandler;
        destinations?: never;
      }
  );

export interface Bridge {
  /** Fetch-style handler; safe to pass around unbound (`Deno.serve(bridge.fetch)`). */
  fetch(request: Request): Promise<Response>;
  /** The manifest this bridge answers to `ping` (without a per-request `settings_url`). */
  readonly manifest: Manifest;
}

/**
 * A handler that only confirms receipt: answers `{ label }` (default
 * "Angekommen ✓"), which yoink shows on the entry. Ideal for a first test.
 */
export function received(label = 'Angekommen ✓'): EntryHandler {
  return () => ({ label });
}

/**
 * Throw from a handler to answer with a specific status, e.g.
 * `new BridgeError(422, 'no route for this project')` for a permanent failure.
 * For `entry.send` and `entry.update`, yoink retries 408, 429 and 5xx; other
 * 4xx are final. `entry.undo` and `ping` are never retried.
 */
export class BridgeError extends Error {
  readonly status: number;

  constructor(status: number, message: string, options?: { cause?: unknown }) {
    super(message, options);
    if (!Number.isInteger(status) || status < 400 || status > 599) {
      throw new RangeError(`BridgeError: status must be 400–599, got ${status}`);
    }
    this.name = 'BridgeError';
    this.status = status;
  }
}

export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

const KNOWN_TYPES = new Set(['entry.send', 'entry.undo', 'entry.update', 'ping']);
const RECEIPT_FIELDS = ['url', 'label', 'external_id'] as const;
const VERIFY_MESSAGES: Record<VerifyFailureReason, string> = {
  headers: 'missing or malformed webhook headers',
  timestamp: 'webhook-timestamp outside the allowed tolerance',
  signature: 'invalid signature',
};
const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** Creates a bridge: verify → parse → dedupe → the destination's handler. */
export function createBridge(options: BridgeOptions): Bridge {
  const { table, manifest } = compile(options);
  const currentKey = secretKey(options.secret);
  const dedupe = options.dedupe ?? new MemoryDedupeStore();
  const toleranceSeconds = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const anyUndo = options.onUndo !== undefined || [...table.values()].some((d) => d.onUndo);
  const anyUpdate = options.onUpdate !== undefined || [...table.values()].some((d) => d.onUpdate);
  const waiting = new Map((manifest.waiting ?? []).map((w) => [w.id, w.missing]));
  const warned = new Set<string>();

  async function handle(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return json(405, { error: 'method not allowed' }, { allow: 'POST' });
    }
    const body = await readLimited(request, maxBodyBytes);
    if (body === null) return json(413, { error: 'payload too large' });

    let key: CryptoKey;
    try {
      key = await currentKey();
    } catch (error) {
      if (error instanceof BridgeError) return json(error.status, { error: error.message });
      console.error('[yoink-bridge] could not resolve the secret', error);
      return json(500, { error: 'internal error' });
    }
    const verdict = await verifyWithKey(key, { headers: request.headers, body, toleranceSeconds });
    if (!verdict.ok) return json(401, { error: VERIFY_MESSAGES[verdict.reason] });

    let payload: unknown;
    try {
      payload = JSON.parse(decoder.decode(body));
    } catch {
      return json(400, { error: 'body is not valid JSON' });
    }
    if (!isRecord(payload)) return json(400, { error: 'body is not a JSON object' });
    if (payload.version !== 1) {
      return json(400, { error: `unsupported version: ${JSON.stringify(payload.version) ?? 'missing'}` });
    }
    if (typeof payload.type !== 'string') return json(400, { error: 'missing type' });
    // New event types are additive: acknowledge and ignore what we don't know.
    if (!KNOWN_TYPES.has(payload.type)) return new Response(null, { status: 204 });
    if (!isRecord(payload.data)) return json(400, { error: 'missing data' });

    const ctx: BridgeContext = {
      id: readHeader(request.headers, 'webhook-id')!,
      timestamp: Number(readHeader(request.headers, 'webhook-timestamp')),
      request,
    };

    // A connection test has no side effects and must reflect the current state.
    if (payload.type === 'ping') return toResponse(await ping(payload as unknown as PingEvent, ctx));

    const destinationId = isRecord(payload.data.destination) ? payload.data.destination.id : undefined;
    const destination = typeof destinationId === 'string' ? table.get(destinationId) : undefined;
    const missing = destination === undefined && typeof destinationId === 'string' ? waiting.get(destinationId) : undefined;
    if (missing !== undefined) {
      // Declared in code, only its settings are missing (for now): retryable for
      // every event, never 422 (unknown) or 501 (no updates), which yoink keeps.
      const what = missing.length > 0 ? missing.join(', ') : 'its settings';
      return json(503, { error: `destination "${destinationId}" is waiting for ${what}` });
    }
    let work: () => Promise<StoredResponse>;
    if (payload.type === 'entry.send') {
      // Permanent: yoink fails the entry and fetches the manifest again.
      if (!destination) return json(422, { error: 'unknown_destination' });
      work = () => send(destination, payload as unknown as EntrySendEvent, ctx);
    } else if (payload.type === 'entry.undo') {
      const onUndo = destination?.onUndo ?? options.onUndo;
      if (!onUndo) {
        return destination || !anyUndo
          ? json(501, { error: 'this bridge does not support entry.undo' })
          : json(422, { error: 'unknown_destination' });
      }
      work = () => guard('entry.undo', ctx, async () => {
        await onUndo(payload as unknown as EntryUndoEvent, ctx);
        return { status: 204, body: null };
      });
    } else {
      // 501: yoink sends no more updates for this delivery. 422: this change is dropped.
      const onUpdate = destination?.onUpdate ?? options.onUpdate;
      if (!onUpdate) {
        return destination || !anyUpdate
          ? json(501, { error: 'this bridge does not support entry.update' })
          : json(422, { error: 'unknown_destination' });
      }
      work = () => guard('entry.update', ctx, async () => {
        await onUpdate(payload as unknown as EntryUpdateEvent, ctx);
        return { status: 204, body: null };
      });
    }

    const existing = await dedupe.begin(ctx.id);
    if (existing?.state === 'done') return toResponse(existing.response);
    if (existing?.state === 'pending') {
      return json(503, { error: 'this delivery is still being processed' }, { 'retry-after': '60' });
    }

    const result = await work();
    try {
      if (isRetryable(result.status)) await dedupe.release(ctx.id);
      else await dedupe.complete(ctx.id, result);
    } catch (error) {
      // The handler already ran; answer its result anyway.
      console.error('[yoink-bridge] dedupe store failed', error);
    }
    return toResponse(result);
  }

  function send(destination: CompiledDestination, event: EntrySendEvent, ctx: BridgeContext) {
    return guard('entry.send', ctx, async () => {
      const receipt = await destination.onEntry(event, ctx);
      if (
        (receipt as Receipt | undefined)?.external_id !== undefined &&
        (receipt as Partial<Ignored> | undefined)?.ignored !== true &&
        !destination.onUndo &&
        !options.onUndo &&
        !warned.has(destination.id)
      ) {
        warned.add(destination.id);
        console.warn(
          `[yoink-bridge] destination "${destination.id}" returned an external_id, which enables ` +
            '"withdraw" in yoink, but no onUndo is configured: withdrawing will fail with 501.',
        );
      }
      return receiptResponse(receipt);
    });
  }

  /** The manifest as JSON: bridge (with a per-request `settings_url`), destinations, waiting, then `extra`. */
  async function manifestAnswer(ctx: BridgeContext, extra?: Record<string, unknown> | void): Promise<StoredResponse> {
    const bridge: Record<string, unknown> = { ...manifest.relay };
    if (typeof options.settingsUrl === 'function') {
      const url = options.settingsUrl(ctx.request);
      if (url !== undefined && isHttpsUrl(url)) bridge.settings_url = url;
    }
    const answer: Record<string, unknown> = { relay: bridge, destinations: manifest.destinations };
    if (manifest.waiting) answer.waiting = manifest.waiting;
    for (const [key, value] of Object.entries(extra ?? {})) {
      if (key === 'relay' || key === 'destinations' || key === 'waiting') {
        if (!warned.has(`ping:${key}`)) {
          warned.add(`ping:${key}`);
          console.warn(`[yoink-bridge] onPing returned "${key}", which is reserved for the manifest; ignored.`);
        }
        continue;
      }
      answer[key] = value;
    }
    const body = JSON.stringify(answer);
    if (encoder.encode(body).length > MANIFEST_LIMITS.bytes) {
      console.error(`[yoink-bridge] the manifest answer is over ${MANIFEST_LIMITS.bytes} bytes; yoink could not read it`);
      return { status: 500, body: JSON.stringify({ error: 'manifest too large' }) };
    }
    return { status: 200, body };
  }

  function ping(event: PingEvent, ctx: BridgeContext) {
    return guard('ping', ctx, async () => {
      const extra = options.onPing ? await options.onPing(event, ctx) : undefined;
      return manifestAnswer(ctx, extra);
    });
  }

  /** Runs a handler and maps throws to responses. */
  async function guard(
    type: string,
    ctx: BridgeContext,
    fn: () => Promise<StoredResponse>,
  ): Promise<StoredResponse> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof BridgeError) {
        if (error.status >= 500) {
          console.error(`[yoink-bridge] ${type} → ${error.status} (${ctx.id}): ${error.message}`);
        }
        return { status: error.status, body: JSON.stringify({ error: error.message }) };
      }
      console.error(`[yoink-bridge] ${type} handler failed (${ctx.id})`, error);
      return { status: 500, body: JSON.stringify({ error: 'internal error' }) };
    }
  }

  return {
    manifest,
    async fetch(request: Request): Promise<Response> {
      try {
        return await handle(request);
      } catch (error) {
        console.error('[yoink-bridge] request failed', error);
        return json(500, { error: 'internal error' });
      }
    },
  };
}

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * The HMAC key for the current secret (surrounding whitespace removed). A
 * fixed secret is validated right away; a function is called per request and
 * its key cached until the secret changes.
 */
function secretKey(source: SecretSource): () => Promise<CryptoKey> {
  if (typeof source === 'string') {
    const secret = source.trim();
    decodeSecret(secret); // fail fast on a missing or malformed secret
    const key = importSecretKey(secret);
    key.catch(() => {}); // surfaced per request instead
    return () => key;
  }
  if (typeof source !== 'function') throw new TypeError('createBridge: secret must be a string or a function');
  let cached: { secret: string; key: Promise<CryptoKey> } | undefined;
  return async () => {
    const value = await source();
    const secret = typeof value === 'string' ? value.trim() : value;
    if (cached?.secret !== secret) {
      decodeSecret(secret); // TypeError without the value, so the secret never reaches a log
      cached = { secret, key: importSecretKey(secret) };
    }
    return cached.key;
  };
}

// ---------------------------------------------------------------------------
// Configuration: the code is the config, so mistakes fail at startup instead
// of being silently cut or skipped by yoink.

interface CompiledDestination {
  id: string;
  onEntry: EntryHandler;
  onUndo: UndoHandler | undefined;
  onUpdate: UpdateHandler | undefined;
}

const MODES: ReadonlySet<string> = new Set<DestinationMode>(['auto', 'suggest', 'manual', 'all']);

function compile(options: BridgeOptions): { table: Map<string, CompiledDestination>; manifest: Manifest } {
  if (!isRecord(options)) throw new TypeError('createBridge: options are required');
  const fail = (message: string): never => {
    throw new TypeError(`createBridge: ${message}`);
  };
  const text = (value: unknown, what: string, max: number): string => {
    if (typeof value !== 'string') fail(`${what} must be a string`);
    const trimmed = (value as string).trim();
    if (!trimmed) fail(`${what} is empty`);
    const length = textLength(trimmed);
    if (length > max) fail(`${what} is ${length} characters long; the limit is ${max} (yoink would cut it)`);
    return trimmed;
  };
  const fn = <T>(value: unknown, what: string): T => {
    if (typeof value !== 'function') fail(`${what} must be a function`);
    return value as T;
  };
  const optionalFn = <T>(value: unknown, what: string): T | undefined =>
    value === undefined ? undefined : fn<T>(value, what);

  const bridgeName = options.name === undefined ? undefined : text(options.name, 'name', MANIFEST_LIMITS.name);
  optionalFn(options.onUndo, 'onUndo');
  optionalFn(options.onUpdate, 'onUpdate');
  if (options.secret === undefined) {
    fail('pass secret: the whsec_… key yoink created for this bridge (or a function that returns it)');
  }
  if (options.settingsUrl !== undefined && typeof options.settingsUrl !== 'function' && !isHttpsUrl(options.settingsUrl)) {
    fail('settingsUrl must be an https:// URL (or a function returning one)');
  }
  optionalFn(options.onPing, 'onPing');

  let configs: [string, DestinationConfig][];
  if (options.destinations !== undefined) {
    if (options.onEntry !== undefined) {
      fail('pass either destinations or onEntry, not both (give each destination its own onEntry)');
    }
    if (!isRecord(options.destinations)) fail('destinations must be an object keyed by destination id');
    configs = Object.entries(options.destinations);
    const waitingCount = Array.isArray(options.waiting) ? options.waiting.length : 0;
    if (configs.length === 0 && waitingCount === 0) fail('destinations is empty; declare at least one');
    if (configs.length > MANIFEST_LIMITS.destinations) {
      fail(`${configs.length} destinations; the limit is ${MANIFEST_LIMITS.destinations}`);
    }
  } else {
    if (options.onEntry === undefined) fail('pass destinations (or onEntry for a single manual destination)');
    configs = [['default', { name: bridgeName ?? 'Bridge', mode: 'manual', onEntry: options.onEntry! }]];
  }

  const table = new Map<string, CompiledDestination>();
  const destinations: ManifestDestination[] = [];
  for (const [id, config] of configs) {
    const where = `destination "${id}"`;
    if (!DESTINATION_ID_PATTERN.test(id)) {
      fail(`${where}: ids must match ${DESTINATION_ID_PATTERN.source} (lowercase letters, digits, _ and -)`);
    }
    if (!isRecord(config)) fail(`${where} must be an object`);
    const entry: ManifestDestination = { id, name: text(config.name, `${where}: name`, MANIFEST_LIMITS.name) };

    const hasDescription = typeof config.description === 'string' && config.description.trim() !== '';
    if (config.description !== undefined && (typeof config.description !== 'string' || hasDescription)) {
      entry.description = text(config.description, `${where}: description`, MANIFEST_LIMITS.description);
    }
    if (config.projects !== undefined) {
      if (!Array.isArray(config.projects)) fail(`${where}: projects must be an array of project names`);
      if (config.projects.length === 0) fail(`${where}: projects is empty; omit it to allow every entry`);
      if (config.projects.length > MANIFEST_LIMITS.projects) {
        fail(`${where}: ${config.projects.length} projects; the limit is ${MANIFEST_LIMITS.projects}`);
      }
      entry.projects = config.projects.map((p, i) => text(p, `${where}: projects[${i}]`, MANIFEST_LIMITS.name));
    }
    if (config.mode !== undefined) {
      if (!MODES.has(config.mode)) {
        fail(`${where}: unknown mode ${JSON.stringify(config.mode)} (auto, suggest, manual or all)`);
      }
      if ((config.mode === 'auto' || config.mode === 'suggest') && !hasDescription) {
        fail(`${where}: mode "${config.mode}" needs a description; yoink checks entries against it`);
      }
      entry.mode = config.mode;
    }
    if (config.group !== undefined) {
      if (typeof config.group !== 'string' || !GROUP_PATTERN.test(config.group)) {
        fail(
          `${where}: group must match ${GROUP_PATTERN.source} (lowercase letters, digits, _ and -), ` +
            `got ${JSON.stringify(config.group)}; yoink would ignore it`,
        );
      }
      entry.group = config.group;
    }
    table.set(id, {
      id,
      onEntry: fn<EntryHandler>(config.onEntry, `${where}: onEntry`),
      onUndo: optionalFn<UndoHandler>(config.onUndo, `${where}: onUndo`),
      onUpdate: optionalFn<UpdateHandler>(config.onUpdate, `${where}: onUpdate`),
    });
    destinations.push(entry);
  }

  const waiting: ManifestWaiting[] = [];
  if (options.waiting !== undefined) {
    if (!Array.isArray(options.waiting)) fail('waiting must be a list of { id, name, missing }');
    if (options.waiting.length > MANIFEST_LIMITS.waiting) {
      fail(`${options.waiting.length} waiting destinations; the limit is ${MANIFEST_LIMITS.waiting}`);
    }
    for (const entry of options.waiting) {
      const id = isRecord(entry) ? entry.id : undefined;
      const where = `waiting "${String(id)}"`;
      if (typeof id !== 'string' || !DESTINATION_ID_PATTERN.test(id)) fail(`${where}: ids must match ${DESTINATION_ID_PATTERN.source}`);
      if (table.has(id as string) || waiting.some((w) => w.id === id)) fail(`${where}: the id is already used`);
      const missing = (entry as ManifestWaiting).missing ?? [];
      if (!Array.isArray(missing) || missing.length > MANIFEST_LIMITS.missing || missing.some((m) => typeof m !== 'string' || !SETTING_NAME_PATTERN.test(m))) {
        fail(`${where}: missing must be up to ${MANIFEST_LIMITS.missing} setting names matching ${SETTING_NAME_PATTERN.source}`);
      }
      waiting.push({ id: id as string, name: text((entry as ManifestWaiting).name, `${where}: name`, MANIFEST_LIMITS.name), missing: [...missing] });
    }
  }

  const bridge: Manifest['relay'] = bridgeName === undefined ? {} : { name: bridgeName };
  bridge.sdk = `yoink-bridge/${SDK_VERSION}`;
  if (typeof options.settingsUrl === 'string') bridge.settings_url = options.settingsUrl;
  const manifest: Manifest = { relay: bridge, destinations };
  if (waiting.length > 0) manifest.waiting = waiting;
  const size = encoder.encode(JSON.stringify(manifest)).length;
  if (size > MANIFEST_LIMITS.bytes) {
    fail(`the manifest is ${size} bytes; yoink reads at most ${MANIFEST_LIMITS.bytes}`);
  }
  return { table, manifest: deepFreeze(manifest) };
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

/** yoink retries these, so they must not be replayed from the dedupe store. */
function isRetryable(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}

function receiptResponse(receipt: Receipt | Ignored | void): StoredResponse {
  if (receipt === undefined || receipt === null) return { status: 204, body: null };
  if ((receipt as Partial<Ignored>).ignored === true) return { status: 200, body: '{"ignored":true}' };
  const out: Receipt = {};
  for (const field of RECEIPT_FIELDS) {
    const value = (receipt as Record<string, unknown>)[field];
    if (value === undefined) continue;
    if (typeof value === 'string') out[field] = value;
    else console.warn(`[yoink-bridge] onEntry: ignoring non-string receipt field "${field}"`);
  }
  return { status: 200, body: JSON.stringify(out) };
}

function toResponse(stored: StoredResponse): Response {
  if (stored.body === null) return new Response(null, { status: stored.status });
  return new Response(stored.body, {
    status: stored.status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function json(status: number, value: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reads the body, giving up (→ `null`) as soon as it exceeds `limit` bytes. */
async function readLimited(request: Request, limit: number): Promise<Uint8Array | null> {
  const declared = request.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > limit) return null;
  if (request.body === null) return new Uint8Array(0);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  if (chunks.length === 1) return chunks[0]!;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
