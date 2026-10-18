import { readFileSync } from 'node:fs';
import { createBridge, signWebhook } from '../src/index.ts';
import type { EntryHandler, EntrySendEvent, EntryUndoEvent, EntryUpdateEvent, PingEvent } from '../src/index.ts';

export const SECRET = 'whsec_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';

const vectors = JSON.parse(
  readFileSync(new URL('./fixtures/webhook-vectors.json', import.meta.url), 'utf8'),
) as { payloads: { name: string; json: unknown }[] };

function payload<T>(name: string): T {
  const found = vectors.payloads.find((p) => p.name === name);
  if (!found) throw new Error(`no payload vector named ${name}`);
  return structuredClone(found.json) as T;
}

/** A bridge with the `bugs` destination that "entry.send auto" is addressed to. */
export function bugsBridge(onEntry: EntryHandler) {
  return createBridge({
    secret: SECRET,
    destinations: { bugs: { name: 'Linear · Bugs', description: 'Concrete bugs in the yoink app.', onEntry } },
  });
}

export const sendAuto = () => payload<EntrySendEvent>('entry.send auto');
export const sendManual = () => payload<EntrySendEvent>('entry.send manual');
export const undo = () => payload<EntryUndoEvent>('entry.undo');
export const update = () => payload<EntryUpdateEvent>('entry.update');
export const ping = () => payload<PingEvent>('ping');

let counter = 0;
export const newId = () => `msg_test_${Date.now()}_${++counter}`;

export interface SignedInit {
  id?: string;
  timestamp?: number;
  secret?: string;
  url?: string;
}

/** Signed headers for `body`, as yoink would send them. */
export async function signedHeaders(body: string, init: SignedInit = {}): Promise<Record<string, string>> {
  const id = init.id ?? newId();
  const timestamp = init.timestamp ?? Math.floor(Date.now() / 1000);
  const signature = await signWebhook({ secret: init.secret ?? SECRET, id, timestamp, body });
  return {
    'content-type': 'application/json; charset=utf-8',
    'user-agent': 'yoink/1.4 (Webhook v1)',
    'webhook-id': id,
    'webhook-timestamp': String(timestamp),
    'webhook-signature': signature,
  };
}

/** A signed POST request carrying `event` (or a raw string body). */
export async function signedRequest(event: unknown, init: SignedInit = {}): Promise<Request> {
  const body = typeof event === 'string' ? event : JSON.stringify(event);
  return new Request(init.url ?? 'https://bridge.example/yoink', {
    method: 'POST',
    headers: await signedHeaders(body, init),
    body,
  });
}

export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
