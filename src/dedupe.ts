/**
 * Deduplication by `webhook-id`. yoink delivers at-least-once: after a timeout
 * it cannot know whether the bridge already did the work, so it sends the same
 * `webhook-id` again. The bridge must not run the handler twice.
 */

/** A response as the bridge stores it for replay. `body` is JSON or `null`. */
export interface StoredResponse {
  status: number;
  body: string | null;
}

export type DedupeRecord =
  | { state: 'pending' }
  | { state: 'done'; response: StoredResponse };

/**
 * Storage for delivery state, keyed by `webhook-id`. Implement this to back
 * dedupe with KV, Redis, a database, … All methods may be async.
 */
export interface DedupeStore {
  /**
   * Claims `id` for processing. If there is no live record for `id`, stores
   * `{ state: 'pending' }` (with a short lease, so a crashed handler does not
   * block the id forever) and returns `null`. Otherwise returns the existing
   * record and stores nothing.
   *
   * Make this atomic where the backend allows it (e.g. Redis `SET NX EX`);
   * a non-atomic store can let two concurrent duplicates through.
   */
  begin(id: string): Promise<DedupeRecord | null>;
  /** Replaces the record with the final response, kept for the dedupe window. */
  complete(id: string, response: StoredResponse): Promise<void>;
  /** Drops the record so that a retry runs the handler again. */
  release(id: string): Promise<void>;
}

export interface MemoryDedupeStoreOptions {
  /**
   * How long completed deliveries are remembered. Default: 48 hours, the
   * protocol minimum (a retry chain ends at most 48 h after its first attempt).
   */
  ttlSeconds?: number;
  /** Lease of an in-flight delivery. Default: 300 seconds. */
  pendingTtlSeconds?: number;
  /** Upper bound on remembered ids; the oldest are evicted first. Default: 10 000. */
  maxEntries?: number;
  /** Clock in milliseconds, for tests. */
  now?: () => number;
}

interface Slot {
  record: DedupeRecord;
  expiresAt: number;
}

/**
 * In-memory `DedupeStore`. Correct for a single long-lived process (Node,
 * Bun, Deno). On serverless platforms memory is per instance and may be
 * dropped at any time, so dedupe there is best-effort; plug in a shared store
 * for stronger guarantees.
 */
export class MemoryDedupeStore implements DedupeStore {
  readonly #slots = new Map<string, Slot>();
  readonly #ttlMs: number;
  readonly #pendingTtlMs: number;
  readonly #maxEntries: number;
  readonly #now: () => number;

  constructor(options: MemoryDedupeStoreOptions = {}) {
    this.#ttlMs = (options.ttlSeconds ?? 48 * 60 * 60) * 1000;
    this.#pendingTtlMs = (options.pendingTtlSeconds ?? 300) * 1000;
    this.#maxEntries = Math.max(1, options.maxEntries ?? 10_000);
    this.#now = options.now ?? Date.now;
  }

  /** Number of remembered ids (including expired ones not yet swept). */
  get size(): number {
    return this.#slots.size;
  }

  async begin(id: string): Promise<DedupeRecord | null> {
    const now = this.#now();
    const slot = this.#slots.get(id);
    if (slot && slot.expiresAt > now) return slot.record;
    this.#put(id, { state: 'pending' }, now + this.#pendingTtlMs, now);
    return null;
  }

  async complete(id: string, response: StoredResponse): Promise<void> {
    const now = this.#now();
    this.#put(id, { state: 'done', response }, now + this.#ttlMs, now);
  }

  async release(id: string): Promise<void> {
    this.#slots.delete(id);
  }

  #put(id: string, record: DedupeRecord, expiresAt: number, now: number): void {
    // Re-inserting moves the id to the end of the Map's insertion order.
    this.#slots.delete(id);
    if (this.#slots.size >= this.#maxEntries) {
      for (const [key, slot] of this.#slots) {
        if (slot.expiresAt <= now) this.#slots.delete(key);
      }
      for (const key of this.#slots.keys()) {
        if (this.#slots.size < this.#maxEntries) break;
        this.#slots.delete(key);
      }
    }
    this.#slots.set(id, { record, expiresAt });
  }
}
