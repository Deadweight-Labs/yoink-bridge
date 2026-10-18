/** A minimal key-value store, shaped like Workers KV, for webhook-id dedupe. */

/**
 * The part of a Workers `KVNamespace` this package uses. `env.BRIDGE_KV` fits
 * it as is; `MemoryKV` implements it in memory.
 */
export interface KVNamespaceLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

/** KV does not accept TTLs below 60 seconds. */
export const MIN_TTL = 60;

/**
 * In-memory `KVNamespaceLike` for tests and local experiments. Honours
 * `expirationTtl`; `now` (milliseconds) can be injected.
 */
export class MemoryKV implements KVNamespaceLike {
  readonly #data = new Map<string, { value: string; expiresAt: number }>();
  readonly #now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.#now = options.now ?? Date.now;
  }

  async get(key: string): Promise<string | null> {
    const slot = this.#data.get(key);
    if (!slot) return null;
    if (slot.expiresAt <= this.#now()) {
      this.#data.delete(key);
      return null;
    }
    return slot.value;
  }

  async put(key: string, value: string, options: { expirationTtl?: number } = {}): Promise<void> {
    if (options.expirationTtl !== undefined && options.expirationTtl < MIN_TTL) {
      throw new Error(`KV put failed: expirationTtl must be at least ${MIN_TTL} seconds`);
    }
    const expiresAt = options.expirationTtl === undefined ? Infinity : this.#now() + options.expirationTtl * 1000;
    this.#data.set(key, { value: String(value), expiresAt });
  }

  async delete(key: string): Promise<void> {
    this.#data.delete(key);
  }

  /** Current keys (for tests). */
  keys(): string[] {
    return [...this.#data.keys()].filter((key) => this.#data.get(key)!.expiresAt > this.#now());
  }
}
