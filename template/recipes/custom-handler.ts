/**
 * Recipe: a destination with your own code. This one forwards each entry as
 * plain JSON to an address of your choice: your own server, an n8n, Make or
 * Zapier webhook, a Google Apps Script, … Copy it into bridge.ts and change
 * it, or use it as is:
 *
 *   import { forwardDestination } from './recipes/custom-handler.ts';
 *   …
 *   destinations: (env) => ({
 *     …,
 *     notes: forwardDestination(env, {
 *       name: 'Notizen',
 *       description: 'Längere Gedanken und Notizen zu Büchern. Keine Aufgaben, keine Einkäufe.',
 *     }),
 *   }),
 *
 * and add FORWARD_URL (and, if your endpoint wants one, FORWARD_TOKEN) to
 * bridge.ts's Env and as Worker settings. Until FORWARD_URL exists, yoink
 * shows the destination as waiting for it.
 *
 * What a handler can answer:
 * - `{ url, label, external_id }` (all optional): yoink shows the label and
 *   link on the entry; an `external_id` turns on "Zurückziehen" (onUndo),
 * - nothing: "sent", without a receipt,
 * - `ignore()`: taken, but nothing to show (for mode 'all'),
 * - `throw new BridgeError(status, message)`: 4xx is final, 5xx makes yoink
 *   try again later (with the same delivery id, deduplicated by the bridge).
 */
import type { WorkerDestination, WorkerEnv } from 'yoink-bridge/cloudflare';
import { BridgeError, type DestinationMode, type EntrySendEvent } from 'yoink-bridge';

export interface ForwardEnv extends WorkerEnv {
  /** Where entries are POSTed (https://). */
  FORWARD_URL?: string;
  /** Optional: sent as `Authorization: Bearer …`. */
  FORWARD_TOKEN?: string;
}

export interface ForwardOptions {
  name: string;
  description: string;
  mode?: DestinationMode;
  /** Shown on the entry when the endpoint answers no `label` of its own. Default: "Weitergeleitet". */
  label?: string;
  /** Custom `fetch`, e.g. for tests. */
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
}

/** The JSON your endpoint receives: the entry, flattened. */
export function forwardBody(event: EntrySendEvent) {
  const { entry, destination, trigger } = event.data;
  return {
    id: entry.id,
    title: entry.title,
    text: entry.text,
    project: entry.project,
    due: entry.due?.at ?? entry.due?.date ?? null,
    link: entry.source_url,
    created_at: entry.created_at,
    destination: destination.id,
    trigger,
  };
}

export function forwardDestination<Env extends ForwardEnv>(env: Env, options: ForwardOptions): WorkerDestination<Env> {
  const doFetch = options.fetch ?? ((input: string, init: RequestInit) => fetch(input, init));
  return {
    name: options.name,
    description: options.description,
    mode: options.mode,
    requires: ['FORWARD_URL'] as Extract<keyof Env, string>[],
    async onEntry(event) {
      let res: Response;
      try {
        res = await doFetch(env.FORWARD_URL!.trim(), {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(env.FORWARD_TOKEN ? { authorization: `Bearer ${env.FORWARD_TOKEN.trim()}` } : {}),
          },
          body: JSON.stringify(forwardBody(event)),
          signal: AbortSignal.timeout(10_000), // yoink waits 15 s for the bridge
        });
      } catch (error) {
        throw new BridgeError(502, 'FORWARD_URL unreachable', { cause: error }); // yoink tries again later
      }
      if (res.status >= 500 || res.status === 408 || res.status === 429) {
        throw new BridgeError(502, `FORWARD_URL answered ${res.status}`);
      }
      if (!res.ok) throw new BridgeError(422, `FORWARD_URL answered ${res.status}`); // final: yoink shows "Retry"

      // The endpoint may answer its own { url, label } for the receipt.
      const answer = (await res.json().catch(() => ({}))) as { url?: unknown; label?: unknown };
      return {
        label: typeof answer.label === 'string' ? answer.label : (options.label ?? 'Weitergeleitet'),
        url: typeof answer.url === 'string' ? answer.url : undefined,
      };
    },
  };
}
