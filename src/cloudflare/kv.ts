/** Workers KV helpers: the dedupe store. */
import type { DedupeRecord, DedupeStore, StoredResponse } from '../dedupe.ts';
import { MIN_TTL, type KVNamespaceLike } from '../kv.ts';

export { MemoryKV, type KVNamespaceLike } from '../kv.ts';

/** KV keys used by `yoink-bridge/cloudflare`. */
export const KV_KEYS = {
  /**
   * Prefix of the dedupe records. Per `webhook-id` there are up to three
   * keys after it: `done:<id>` (the stored response, 48 h), `pending:<id>`
   * (the lease of a delivery in flight) and `released:<id>` (a lease given
   * back after a retryable failure).
   */
  dedupe: 'dedupe:',
} as const;

export interface KVDedupeStoreOptions {
  /** How long completed deliveries are remembered. Default: 48 hours (the protocol minimum). */
  ttlSeconds?: number;
  /** Lease of an in-flight delivery. Default: 300 seconds. */
  pendingTtlSeconds?: number;
  /** Key prefix. Default: `dedupe:`. */
  prefix?: string;
}

/**
 * `DedupeStore` on Workers KV, shared by all isolates and locations.
 *
 * Workers KV allows one write per second to the same key, and `complete`
 * (or `release`) follows `begin` within the handler's run time. So each
 * step writes its own key, and no step writes a key another step of the
 * same delivery just wrote: `begin` writes the lease `pending:<id>` (a
 * random token), `complete` writes `done:<id>`, and `release` writes
 * `released:<id>` = that token, which frees the lease without touching it.
 * `begin` reads `done:` first, so a stored response always wins over a
 * lease that is still alive. About two writes per delivery.
 *
 * Best-effort: KV is eventually consistent (a write can take up to a minute
 * to show up in other locations) and has no atomic "set if absent", so two
 * copies of one delivery arriving at the same moment can both run. yoink's
 * retries are minutes apart, which KV handles well. If you need strict
 * once-only handling, implement `DedupeStore` on a Durable Object.
 */
export class KVDedupeStore implements DedupeStore {
  readonly #kv: KVNamespaceLike;
  readonly #ttl: number;
  readonly #pendingTtl: number;
  readonly #prefix: string;
  /** Leases this instance took and has not completed or released yet. */
  readonly #leases = new Map<string, string>();

  constructor(kv: KVNamespaceLike, options: KVDedupeStoreOptions = {}) {
    this.#kv = kv;
    this.#ttl = Math.max(MIN_TTL, options.ttlSeconds ?? 48 * 60 * 60);
    this.#pendingTtl = Math.max(MIN_TTL, options.pendingTtlSeconds ?? 300);
    this.#prefix = options.prefix ?? KV_KEYS.dedupe;
  }

  async begin(id: string): Promise<DedupeRecord | null> {
    const done = parseJson(await this.#kv.get(this.#key('done', id)));
    if (isRecord(done) && done.state === 'done' && isRecord(done.response)) return done as DedupeRecord;

    const lease = leaseOf(await this.#kv.get(this.#key('pending', id)));
    if (lease !== undefined && (await this.#kv.get(this.#key('released', id))) !== lease) {
      return { state: 'pending' };
    }
    const token = crypto.randomUUID();
    await this.#kv.put(this.#key('pending', id), JSON.stringify({ state: 'pending', lease: token }), {
      expirationTtl: this.#pendingTtl,
    });
    this.#leases.set(id, token);
    return null;
  }

  async complete(id: string, response: StoredResponse): Promise<void> {
    // The lease is left to expire: `done:` is read first, and touching
    // `pending:` again this soon would exceed KV's write rate for that key.
    this.#leases.delete(id);
    const record: DedupeRecord = { state: 'done', response };
    await this.#kv.put(this.#key('done', id), JSON.stringify(record), { expirationTtl: this.#ttl });
  }

  async release(id: string): Promise<void> {
    let lease = this.#leases.get(id);
    this.#leases.delete(id);
    lease ??= leaseOf(await this.#kv.get(this.#key('pending', id)));
    if (lease === undefined) return;
    await this.#kv.put(this.#key('released', id), lease, { expirationTtl: this.#pendingTtl });
  }

  #key(kind: 'done' | 'pending' | 'released', id: string): string {
    return `${this.#prefix}${kind}:${id}`;
  }
}

function parseJson(value: string | null): unknown {
  if (value === null) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null; // unreadable record: treated as absent
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The token of a lease record, or `undefined` for none (or an unreadable one). */
function leaseOf(value: string | null): string | undefined {
  const record = parseJson(value);
  return isRecord(record) && typeof record.lease === 'string' ? record.lease : undefined;
}
