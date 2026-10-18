# yoink-bridge

Your own bridge from [yoink](#what-is-this) to Linear, GitHub Issues or your
own code. You describe your destinations in plain words ("concrete bugs in my
app, no ideas"); yoink checks every new entry against those descriptions and
sends matches to your bridge, which turns them into a Linear or GitHub issue,
or whatever your code does.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Deadweight-Labs/yoink-bridge/tree/main/template)

**Setup, step by step:**

1. **Copy the key in yoink.** On your iPhone: **Einstellungen › Ausgänge ›
   Bridge einrichten › Schlüssel kopieren**. yoink creates the key (it starts
   with `whsec_`).
2. **Click Deploy to Cloudflare** (above) and fill in the form:
   - **Git account:** your GitHub account. Keep "Create private Git
     repository" checked if your descriptions are personal.
   - **`YOINK_SECRET`:** paste the key from step 1. It is always the key from
     the yoink app, never one you make up.
   - Leave everything else as it is and click **Deploy**.
3. **Connect yoink.** When the deploy is done, open the Worker's URL
   (`https://yoink-bridge.<you>.workers.dev`) on your iPhone and tap **In
   yoink öffnen**, or scan the QR code on that page.
4. **Turn on Linear or GitHub** (optional): add their keys in Cloudflare
   under Workers & Pages › your Worker › Settings › Variables and Secrets ›
   Add (type **Secret**), deploy, then tap **Ziele aktualisieren** in yoink. Which keys:
   [template/README.md › Turn on Linear and GitHub](template/README.md#turn-on-linear-and-github).

**Deutsch, kurz:** In yoink unter Einstellungen › Ausgänge › Bridge
einrichten den Schlüssel kopieren, auf „Deploy to Cloudflare“ klicken, den
Schlüssel ins Feld `YOINK_SECRET` einfügen und deployen. Danach die
Worker-URL auf dem iPhone öffnen und „In yoink öffnen“ tippen.

- **Deploy in one click:** the base Worker in [`template/`](template) comes
  with Linear and GitHub Issues ready to switch on; your own logic goes into
  one file, `bridge.ts`.
- **Or build your own:** `npm install yoink-bridge` gives you the SDK for
  Cloudflare Workers, Node, Deno and Bun. Zero runtime dependencies.
- **One key, created by yoink:** you paste it once into your bridge. No
  password, and no web page or link ever shows it.
- Signatures are **[Standard Webhooks](https://www.standardwebhooks.com/) v1**;
  mandatory dedupe is built in.
- **Destination groups:** "Linear or GitHub, not both".
- TypeScript, Web-standard APIs only (`Request`/`Response`, Web Crypto).

## What is this?

yoink is an iOS app for throwing thoughts in and finding them later. You
connect it once to a small HTTPS server you own, the **bridge**. The bridge
tells yoink which **destinations** it has and, in your words, what belongs in
each. Nothing else is configured in the app.

1. yoink fetches the bridge's **manifest**: its destinations and their
   descriptions.
2. For every new entry, yoink's decision model estimates how well it fits
   each description.
3. Matches are sent to the bridge as a signed `entry.send`; the bridge calls
   that destination's `onEntry`. Unsure ones show up as a suggestion on the
   entry.
4. Your return value becomes a receipt on the entry ("ABC-12 ↗").

Requests go straight from the iPhone to your bridge; no yoink server sees the
content. The wire format is in [PROTOCOL.md](PROTOCOL.md).

## Two ways to use it

1. **Deploy the base.** Click **Deploy to Cloudflare** above. Cloudflare
   copies the [`template/`](template) folder into a new repository in your
   GitHub account and deploys it as a Worker. That copy is small: your
   `bridge.ts`, a few recipes and a test; the SDK comes from npm as the
   dependency `yoink-bridge`, and Dependabot brings its updates as PRs.
   Step by step, including Linear, GitHub, groups and good descriptions:
   **[template/README.md](template/README.md)**.
2. **Build your own.** `npm install yoink-bridge` in any project and write
   the bridge yourself: on Workers with `defineWorkerBridge`, anywhere else
   with `createBridge` (Node via `yoink-bridge/node`, Deno, Bun). Everything
   the base does is SDK API; the base is just one `bridge.ts` on top of it.

## Install

```sh
npm install yoink-bridge
```

Node 22 or later for the CLI and the Node adapter; the core runs on any
runtime with Web-standard `fetch` APIs and Web Crypto (Workers, Deno, Bun,
Node).

| Import | |
|---|---|
| `yoink-bridge` | The core: `createBridge`, `BridgeError`, `ignore`, `received`, `verifyWebhook`/`signWebhook`, `parseManifest`/`describeBridge`, `generateSecret`/`secretProblem`, `MemoryDedupeStore`, `MemoryKV`, the event and manifest types. |
| `yoink-bridge/cloudflare` | `defineWorkerBridge`, `WorkerEnv`, `WorkerDestination`, `KVDedupeStore`, `MemoryKV`, `KV_KEYS`, `received`. |
| `yoink-bridge/node` | `toNodeHandler` for `node:http` and Express-style servers. |
| `yoink-bridge/presets/linear`, `…/github`, `…/slack`, `…/discord` | Ready-made destinations. |
| `yoink-bridge/presets/shared` | Helpers the presets share, e.g. `updateComment`, `formatDue`. |

The package also has a binary: `npx yoink-bridge check --url https://…`
(see [CLI](#cli)).

### On Cloudflare Workers

```ts
// bridge.ts
import { defineWorkerBridge, received, type WorkerEnv } from 'yoink-bridge/cloudflare';
import { linear } from 'yoink-bridge/presets/linear';

interface Env extends WorkerEnv {
  LINEAR_API_KEY?: string;
  LINEAR_TEAM?: string;
}

export default defineWorkerBridge<Env>({
  name: 'Meine Bridge',
  destinations: (env) => ({
    bugs: {
      name: 'Linear · Bugs',
      description: 'Konkrete Fehler in der App, die man reproduzieren kann. Keine Ideen.',
      mode: 'suggest',
      requires: ['LINEAR_API_KEY', 'LINEAR_TEAM'], // greyed out in yoink until both exist
      ...linear({ apiKey: env.LINEAR_API_KEY, team: env.LINEAR_TEAM }),
    },
    test: { name: 'Test', onEntry: received() }, // manual: only "Send to …" by hand
  }),
});
```

```jsonc
// wrangler.jsonc
{
  "name": "yoink-bridge",
  "main": "bridge.ts",
  "compatibility_date": "2025-10-01",
  "kv_namespaces": [{ "binding": "BRIDGE_KV" }]
}
```

Add the key from yoink as the secret `YOINK_SECRET`
(`npx wrangler secret put YOINK_SECRET`), deploy, open the Worker's URL on
your iPhone and tap **In yoink öffnen**.

### Anywhere else

```ts
import { createBridge, BridgeError } from 'yoink-bridge';

const bridge = createBridge({
  secret: process.env.YOINK_SECRET!, // the key from yoink, `whsec_…`
  name: 'Meine Bridge',
  destinations: {
    notes: {
      name: 'Notizen',
      description: 'Längere Gedanken und Notizen zu Büchern. Keine Aufgaben, keine Einkäufe.',
      async onEntry(event, ctx) {
        const { entry } = event.data;
        const res = await fetch('https://notes.example/api/pages', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': ctx.id },
          body: JSON.stringify({ title: entry.title ?? entry.text.split('\n')[0], body: entry.text }),
        });
        if (!res.ok) throw new BridgeError(502, `notes answered ${res.status}`); // 5xx: yoink retries
        const page = (await res.json()) as { id: string; url: string };
        return { url: page.url, label: 'Notiz', external_id: page.id };
      },
    },
  },
});

Deno.serve(bridge.fetch);            // Deno
// Bun.serve({ fetch: bridge.fetch }); // Bun
// Node: see "Node, Deno, Bun" below
```

`createBridge` keeps delivery ids in memory by default, which is exact for
one long-lived process. On serverless platforms pass a persistent `dedupe`
store (see [Dedupe](#dedupe)).

## Reference

### `defineWorkerBridge<Env>(config)` (`yoink-bridge/cloudflare`)

Returns the module Worker (`export default`).

| Config | |
|---|---|
| `name` | Display name of the bridge in yoink (≤ 60 characters). |
| `destinations(env)` | Returns (or resolves to) `{ [id]: WorkerDestination }`. A sync function runs once per env (isolate); an async one (e.g. loading routes from KV) again after `refreshSeconds` (default 60), and a failed refresh keeps the last good set. `undefined`/`null`/`false` entries are left out. |
| `destinations[id].requires` | Env keys the destination needs (up to 10, `[A-Z0-9_]{1,64}`). While one is missing or blank, the destination is listed in `waiting[]` instead (names only, never values). |
| `onUndo` | Fallback `entry.undo` handler. |
| `onUpdate` | Fallback `entry.update` handler. |
| `routes` | `{ 'GET /path' \| 'POST /path': (request, env, ctx) => Response }`, exact paths; `/` is taken. |

Routes: `POST /` webhook · your `routes` · `GET /` the start page · else 404.

| Binding (`WorkerEnv`) | |
|---|---|
| `YOINK_SECRET` | The key from yoink, `whsec_` + base64 of 32 bytes (surrounding whitespace is ignored). Every request is verified against it. Missing or invalid → signed requests answer 503 with the reason, and the start page says what to do. |
| `BRIDGE_KV` | KV namespace for dedupe, per `webhook-id`: the stored response (`dedupe:done:<id>`, kept 48 h) and a short lease while it runs (`dedupe:pending:<id>`, `dedupe:released:<id>`, 5 min). Separate keys, because KV allows one write per second to the same key. |

On a `*.workers.dev` host the manifest carries `relay.settings_url` (the
protocol's field name), a link to the Worker's settings in the Cloudflare
dashboard, which yoink shows next to waiting destinations; on other hosts it
is left out.

**The start page** (`GET /`) shows the bridge name, a button and QR code that
open `yoink://ausgang?v=1&url=<origin>/&name=<name>` (never a key), and a
warning while `YOINK_SECRET` is missing or invalid. No forms, no scripts,
`Cache-Control: no-store`, `X-Robots-Tag: noindex`, a strict CSP; German or
English by `Accept-Language`.

Also exported: `received()`, `KVDedupeStore` (best-effort: KV is eventually
consistent and has no atomic "set if absent"; yoink's retries are minutes
apart; use a Durable Object for strict once-only handling), `MemoryKV` for
tests, `KV_KEYS`. KV writes: about two per delivery; the free Workers plan
allows 1 000 a day.

### `createBridge(options) → { fetch(request), manifest }` (`yoink-bridge`)

The platform-independent core; `defineWorkerBridge` is built on it.

| Option | Default | |
|---|---|---|
| `secret` | required | The `whsec_…` key (validated immediately, trimmed), or a function returning it per request; it may throw a `BridgeError`, e.g. 503 while the key is not configured. |
| `destinations` | required* | `{ [id]: DestinationConfig }`, at most 20. |
| `onEntry(event, ctx)` | | *Short form instead of `destinations`: one destination `default` in `manual` mode. |
| `waiting` | none | `[{ id, name, missing }]`: destinations in code that still miss settings. |
| `settingsUrl` | none | `relay.settings_url` (`https://` only); a function is evaluated per `ping`. |
| `name` | none | Display name of the bridge in yoink (≤ 60 characters). |
| `onUndo(event, ctx)` | none | `entry.undo` for destinations without their own `onUndo`. |
| `onUpdate(event, ctx)` | none | `entry.update` for destinations without their own `onUpdate`. |
| `onPing(event, ctx)` | none | Return an object to add fields to the manifest; throw a `BridgeError` to fail the connection test. |
| `dedupe` | `new MemoryDedupeStore()` | Where delivery state lives, see [Dedupe](#dedupe). |
| `toleranceSeconds` | `300` | Allowed clock skew for `webhook-timestamp`. |
| `maxBodyBytes` | 1 MiB | Larger bodies get 413. |

Each destination (`DestinationConfig`):

| Field | | |
|---|---|---|
| key | required | The id: `[a-z0-9][a-z0-9_-]{0,39}`. Stable; don't rename. |
| `name` | required | Display name in yoink, ≤ 60 characters. |
| `description` | optional | What belongs here and what doesn't, ≤ 500 characters, trimmed. Without it, nothing is sent automatically. |
| `projects` | optional | Only entries of these yoink projects (case-insensitive), ≤ 20 names. |
| `mode` | `auto` with a description, else `manual` | `auto`, `suggest`, `manual`, or `all` (every new entry, your code decides; no description needed; switched on in yoink). |
| `group` | none | Alternatives share a group: an entry goes to at most one of them. `[a-z0-9][a-z0-9_-]{0,39}`. |
| `onEntry(event, ctx)` | required | Handles `entry.send`. |
| `onUndo(event, ctx)` | optional | Handles `entry.undo` → 204. |
| `onUpdate(event, ctx)` | optional | Handles `entry.update` → 204. Without it (and without a top-level one): 501. |

**The code is the config:** `createBridge` throws a `TypeError` at startup for
anything yoink would skip, cut or read differently (an invalid id or group, a
missing or too long name, a description over 500 characters, too many
destinations or projects, an unknown `mode`, `auto`/`suggest` without a
description, a manifest over 64 KB).

`ctx` (`BridgeContext`) is `{ id, timestamp, request }`: the `webhook-id`
(stable across retries), the attempt's `webhook-timestamp` and the original
`Request`.

What `onEntry` can answer:

- `{ url, label, external_id }` (all optional): yoink shows the label and
  link on the entry; `url` must be `https://`; `external_id` enables
  "Zurückziehen", which calls `onUndo`,
- nothing: sent, without a receipt,
- `ignore()`: taken but dropped, yoink shows nothing (for `mode: 'all'`),
- `throw new BridgeError(status, message)`: 4xx is final (yoink shows
  "Retry" on the entry), 5xx makes yoink try again later (1 min, 10 min,
  1 h, 6 h, 24 h, at most 48 h). Avoid 404/410: yoink reads those as "bridge
  gone".

`onUpdate` gets `external_id` (what `onEntry` answered, or `null`), the
whole current `entry`, `previous` (`title`, `text`, `due` as last sent) and
`changes` (a subset of `title`, `text`, `due`). It answers nothing (204); a
`BridgeError` with 4xx drops this change, 5xx makes yoink try again, 501
stops updates for that entry.

yoink waits 15 s per attempt, so give slow calls a timeout below that.
Retries carry the same `webhook-id` (`ctx.id`) and are deduplicated by the
bridge; pass `ctx.id` on as an idempotency key where your downstream supports
it.

What the bridge answers, in order:

| Situation | Status | yoink (`entry.send`) |
|---|---|---|
| Not a POST | 405 | failed |
| Body over `maxBodyBytes` | 413 | failed |
| The key is not available (`secret` function threw a `BridgeError`) | its status, e.g. 503 | retried |
| Missing/malformed headers, timestamp outside tolerance, bad signature | 401 | "check connection", no retry |
| Body not a JSON object, `version` ≠ 1, no `data` | 400 | failed |
| Unknown `type` (new event types are additive) | 204 | nothing happens |
| `ping` | 200 + manifest | reads the destinations |
| Any event for a destination in `waiting[]` (declared, settings missing) | 503 `{"error":"destination \"bugs\" is waiting for LINEAR_TEAM"}` | retried (undo: not withdrawn, try again later) |
| `entry.send` to an id the bridge doesn't declare | 422 `{"error":"unknown_destination"}` | failed, fetches the manifest again |
| `entry.undo` without a matching `onUndo` | 501 (422 for an unknown destination if only some support undo) | not withdrawn |
| `entry.update` without a matching `onUpdate` | 501 (422 for an unknown destination if only some support updates) | 501: no more updates for that entry; 422: this change dropped |
| Same `webhook-id` already handled / still in flight | the cached response / 503 + `Retry-After` | as before / retried |
| Handler returned | 200 / 204 | sent |
| Handler threw `BridgeError(status, message)` | `status`, `{"error": message}` | depends on status |
| Handler threw anything else | 500 `{"error":"internal error"}` | retried |

`entry.undo` and `ping` get a single attempt; yoink never retries them.
`entry.update` is retried like `entry.send` (408, 429, 5xx; at most 5
attempts); other 4xx drop that change, and the next edit is sent again.

`received(label?)` is a ready-made `onEntry` that only confirms receipt
(`{ label: "Angekommen ✓" }`), handy for a first test.

### `parseManifest(body)` and `describeBridge(…)`

`parseManifest` reads a manifest exactly like yoink does (raw `ping` body or
parsed value) and returns `{ bridgeName, settingsUrl, destinations, waiting }`:
every destination comes back complete (`description: ''`, `projects: []`,
`group: null` when absent) with the effective `mode`; invalid or duplicate
destinations are skipped, texts trimmed and cut, a group kept only if it
matches the pattern exactly. It is tested against every `manifests` vector of
the app. `describeBridge(bridge | manifest | body)` renders the same as text
(what `check` prints). Also exported: `MANIFEST_LIMITS`,
`DESTINATION_ID_PATTERN`, `GROUP_PATTERN`, `SETTING_NAME_PATTERN`.

### `verifyWebhook` / `signWebhook`

```ts
import { verifyWebhook, signWebhook } from 'yoink-bridge';

const result = await verifyWebhook({ secret, headers: request.headers, body: rawBody });
// { ok: true } | { ok: false, reason: 'headers' | 'timestamp' | 'signature' }
const signature = await signWebhook({ secret, id, timestamp, body }); // "v1,<base64>"
```

Only `v1` entries of `webhook-signature` count; any of them may match.
Comparison happens inside `crypto.subtle.verify` (constant time). Always
verify the raw bytes, never re-serialized JSON.

`generateSecret()` makes a key in yoink's format; `secretProblem(value)` says
whether a value is one (`null`, `'missing'` or `'invalid'`).
`buildSetupLink({ url, name })` builds the `yoink://ausgang` link (never with
a key).

### Dedupe

yoink delivers **at-least-once**: after a timeout it re-sends the same
`webhook-id`. The bridge therefore remembers every delivery: the first runs
your handler and a 2xx or final 4xx is stored; a repeat gets the stored
response; a repeat while the first is still running gets 503; failures yoink
retries (5xx, 408, 429) are not stored. `ping` is never deduplicated. A retry
chain ends at most 48 h after its first attempt, so a store must keep ids at
least that long. `MemoryDedupeStore` (default for `createBridge`) is exact for
one long-lived process; `defineWorkerBridge` uses `KVDedupeStore`. Your own
store (`DedupeStore`) implements `begin(id)`, `complete(id, response)` and
`release(id)`.

### Presets (`yoink-bridge/presets/…`)

Each preset is a handler and exposes its lower-level call. A missing key
(`undefined` until the setting exists) fails at send time with 503, so a
destination can wait for it with `requires`. Upstream failures become a
`BridgeError`: permanent ones (rejected key, unknown team/repository, 4xx) →
422, temporary ones (rate limits, 408, 5xx, network errors, timeouts after
10 s) → 502, which yoink retries.

- **`linear({ apiKey, team, labels?, title?, description?, fetch? })`**
  (`yoink-bridge/presets/linear`): `onEntry` creates the issue (title: the
  entry title or first line; description: the text, then `- Projekt: …`,
  `- Fällig: 20.10.2026 (abends)`, `- Link: …`, `- Anhänge (nur in yoink):
  1 × Bild`, then "— via yoink"; German like yoink, and the same in the
  update comment and the Slack/Discord line), answers `{ url, label:
  "ABC-12", external_id }`; `onUndo` archives it; `onUpdate` comments on it
  (`commentCreate`, the `updateComment` text; no `external_id` → 501, so
  yoink sends no more updates for it). `createIssue(event, { title,
  description, priority, labelNames })`, `archiveIssue(id)`,
  `commentOnIssue(id, markdown)`. *Not yet tested against the live API.*
- **`github({ token, repo, labels?, title?, body?, fetch? })`**
  (`yoink-bridge/presets/github`): `onEntry` creates an issue in `repo`
  (`owner/name`, a repository URL works too; title ≤ 256 characters, the same
  body as Linear), answers `{ url: html_url, label: "#12", external_id:
  "owner/name#12" }`; `onUndo` closes that issue in that repository as "not
  planned", even if `GITHUB_REPO` changed since (a bare number means the
  current repository); `onUpdate` comments on that issue, in that repository
  too (the `updateComment` text; no `external_id` → 501). `labels` should
  exist in the repository (GitHub drops labels silently for tokens without
  push access). `createIssue(event, { title, body, labels })`,
  `closeIssue('owner/name#12' | number)`,
  `commentOnIssue('owner/name#12' | number, markdown)`. Sends the
  `User-Agent`, `Accept: application/vnd.github+json` and
  `X-GitHub-Api-Version: 2022-11-28` headers GitHub requires. *Not yet tested
  against the live API beyond a rejected token.*
- **`slack({ webhookUrl, format?, fetch? })`** (`yoink-bridge/presets/slack`):
  posts `{ text }` to an incoming webhook (control characters escaped);
  `post(text)`.
- **`discord({ webhookUrl, format?, fetch? })`**
  (`yoink-bridge/presets/discord`): posts `{ content }` with mentions
  disabled, cut to 2000 characters; `post(text)`.
- **`updateComment(event)`** (`yoink-bridge/presets/shared`): the comment
  text for an edit, "**In yoink geändert**", then only what changed
  (`Titel: alt → neu`, the whole new text quoted, `Fällig: alt → neu`), then
  "— via yoink"; `null` when none of title, text and due changed. Also
  `formatDue(due)`.

Slack and Discord are `onEntry` handlers only: a chat message is a one-off,
so edits are not posted (updates answer 501, and yoink stops after the
first). To post them anyway, with `const chat = discord({ … })`:
`{ onEntry: chat, onUpdate: async (e) => { const t = updateComment(e); if (t) await chat.post(t); } }`
(the text is Markdown, which Slack's mrkdwn renders differently).

`createIssue`/`archiveIssue`/`closeIssue`/`commentOnIssue` are not
enumerable, so `...linear({ … })` spreads only `onEntry`, `onUndo` and
`onUpdate` into a destination.

### Node, Deno, Bun

```ts
import { createServer } from 'node:http';
import { createBridge, describeBridge } from 'yoink-bridge';
import { toNodeHandler } from 'yoink-bridge/node';

const bridge = createBridge({ secret: process.env.YOINK_SECRET!, destinations: { … } });
console.log(describeBridge(bridge)); // what yoink will read
createServer(toNodeHandler(bridge)).listen(8787);
```

Run it behind HTTPS (yoink only delivers to `https://`), e.g. with Caddy, a
Cloudflare Tunnel or Tailscale Funnel. With a single key it needs no storage.
A runnable version is [`examples/node/server.ts`](examples/node/server.ts)
(in this repository: `node --env-file=.env examples/node/server.ts`; it
imports `src/` directly). With Express, mount it before `express.json()` or
use `express.raw({ type: '*/*' })`. Deno and Bun take the fetch handler
directly: `Deno.serve(bridge.fetch)`, `Bun.serve({ fetch: bridge.fetch })`.

### CLI

The package installs the binary `yoink-bridge`:

```
npx yoink-bridge check  --url <bridge-url> [--env-file <path> | --secret <whsec_…>]
npx yoink-bridge send   --url <bridge-url> [--env-file <path> | --secret <whsec_…>] [--text <text>]
                        [--title <title>] [--project <name>] [--destination <id>] [--trigger manual|suggestion|auto]
                        [--update <new text>]
npx yoink-bridge keygen [--env-file <path>]
```

- **`check`** sends a signed `ping` exactly like yoink and prints the
  destinations yoink will read (groups, waiting destinations, the settings
  link), or why the bridge refused (wrong key, redirect, unreachable).
- **`send`** posts a signed test `entry.send` (text "Test für meine Bridge"
  unless `--text`) and prints the receipt. `--destination` may be left out
  when the bridge has only one. With `--update <new text>` it then edits the
  entry: an `entry.update` for that delivery (its `webhook-id` and
  `external_id`) with the new text, as yoink sends after an edit, and says
  what yoink would make of the answer (501: no more updates).
- **`keygen`** prints `YOINK_SECRET=whsec_…` for local development, or with
  `--env-file` writes it into that file (filling an empty `YOINK_SECRET=`
  line, refusing to replace an existing key).

The key comes from `--secret`, else `YOINK_SECRET` in `--env-file` or the
environment, else the CLI asks for it without echoing. `--secret` ends up in
your shell history, so for a deployed bridge prefer the prompt:
`npx yoink-bridge check --url https://yoink-bridge.<you>.workers.dev`.
`http://` is allowed for localhost only. Both commands work with any bridge
that implements the protocol. `-h`/`--help` and `-v`/`--version` do what you
expect.

### Types

Events `EntrySendEvent`, `EntryUndoEvent`, `EntryUpdateEvent`, `PingEvent`
(union `YoinkEvent`) and their parts (`Entry`, `Due`, `Attachment`,
`PreviousEntry`, …), `Receipt`/`Ignored`, the manifest types (`Manifest`,
`ManifestDestination`, `ManifestWaiting`), `DestinationConfig`,
`BridgeOptions`, `BridgeContext` and `Bridge`. They mirror
[PROTOCOL.md](PROTOCOL.md); the payload vectors are checked against them
field by field. Enumerations are open (`Trigger`, `EntryType`, `DayPart`,
`AttachmentKind`, `UpdateChange` accept any string; the `Known*` unions list
the known values), so give your `switch` a `default`. `SDK_VERSION` is the
package version, reported as `relay.sdk` (`yoink-bridge/0.8.0`).

## Security

| What | Protected by |
|---|---|
| Every request to the bridge | the HMAC signature with the key (±300 s window, dedupe). yoink creates the key and keeps it in the device keychain; on the bridge it is configuration (on Cloudflare the Worker secret `YOINK_SECRET`). No web page, link or log shows it. |
| API keys (Linear, GitHub, …) | on Cloudflare, your Cloudflare login. Worker secrets are write-only and never go through yoink; the manifest only names missing ones. |
| Your code and descriptions | your GitHub login (for a deployed base). Keep the repository private if your descriptions are personal. |
| Destination names and descriptions | only signed pings get the manifest, although the bridge URL is public. |

- **Whoever has the key** can send entries to your bridge (say, create
  issues) and read your descriptions; they never receive your entries. If it
  leaked, create a new one in yoink (Bridge einrichten) and replace
  `YOINK_SECRET` on the bridge: the old key stops working right away.
- `keygen` keys are for local development; keep `.dev.vars` out of git (it is
  in `.gitignore`). Prefer the CLI's prompt over `--secret`.
- The bridge verifies the signature on the raw bytes before parsing, compares
  in constant time, enforces a 1 MiB body limit while streaming, and answers
  unexpected errors with a generic message (details go to `console.error`,
  never the key).

## Compatibility with Standard Webhooks libraries

yoink signs exactly like [Standard Webhooks](https://www.standardwebhooks.com/),
so any of its verifiers works, e.g.
[`standardwebhooks`](https://www.npmjs.com/package/standardwebhooks):
`new Webhook(secret).verify(rawBody, headers)`. Those libraries only cover
the signature; a bridge still has to answer `ping` with a manifest, route
`entry.send` by `data.destination.id` (422 for unknown ids), reject
`version` ≠ 1 with 400, answer unknown types with 2xx, and deduplicate by
`webhook-id`.

## Repository layout

| Path | |
|---|---|
| `src/` | The SDK, published to npm as `yoink-bridge`: signature check, dedupe, manifest, the Cloudflare adapter (`src/cloudflare/`), presets (`src/presets/`), the Node adapter (`src/node.ts`) and the CLI (`src/cli.ts`). |
| `template/` | The base Worker that **Deploy to Cloudflare** copies into a new repository: `bridge.ts` (Linear + GitHub Issues built in), `recipes/` (router with Claude, custom handler), `test/bridge.test.ts`, `wrangler.jsonc`, `package.json` (depends on `yoink-bridge` from npm; also holds the deploy form's descriptions), `tsconfig.json`, `.dev.vars.example`, `.github/dependabot.yml`. Its user-facing docs: [template/README.md](template/README.md). |
| `test/` | Tests for the SDK and the recipes (`test/router.test.ts`, `test/custom-handler.test.ts`); `test/fixtures/webhook-vectors.json` are the protocol's test vectors. |
| `examples/node/` | The SDK on a plain Node server. |
| `scripts/fix-dts.ts` | Part of `npm run build`: rewrites `.ts` imports in the emitted declarations. |
| `wrangler.dev.jsonc` | `npm run dev`: runs `template/bridge.ts` against `src/` (aliases instead of the npm package). |
| `vitest.config.ts`, `tsconfig.json`, `tsconfig.web.json`, `tsconfig.build.json` | Tests and type checks with `yoink-bridge` imports pointed at `src/`; the Web-only guard; the `dist/` build. |
| `PROTOCOL.md`, `CHANGELOG.md` | The wire format and the release notes (both ship in the npm package). |

The template imports the SDK by package name (`from 'yoink-bridge/cloudflare'`),
exactly as a deployed copy does; in this repository those imports resolve to
`src/` through aliases. Imports inside `src/` name the `.ts` files, so Node
runs the CLI from source and wrangler bundles it as is.

## Developing

Needs Node 22.18 or later (in this repository the CLI runs from TypeScript
source).

```sh
npm install
cp template/.dev.vars.example .dev.vars
npm run keygen      # writes a development key into .dev.vars
npm run dev         # template/bridge.ts against src/, on http://localhost:8787
```

In a second terminal:

```sh
npm run check                                          # what yoink will read
npm run send -- --destination github --text "Login-Button reagiert nicht"
npm run cli -- --help                                  # the CLI from source
```

`.dev.vars` lives at the repository root here (`wrangler.dev.jsonc` reads
it); add `GITHUB_TOKEN`/`GITHUB_REPO` (or the Linear keys) to try a
destination for real.

```sh
npm test            # vitest: SDK, recipes, template/test, protocol vectors
npm run typecheck   # everything, plus a guard that the Worker code needs no Node types
npm run build       # emits dist/ (JavaScript, declarations, source maps)
```

`test/fixtures/webhook-vectors.json` is vendored from the yoink app repo and
must not be edited by hand (see `test/fixtures/README.md`).

**Publishing** is manual by the maintainer: `npm login`, then `npm publish`.
`prepublishOnly` runs `typecheck`, `test` and `build` first. The package
ships `dist/`, `src/`, `PROTOCOL.md` and `CHANGELOG.md`. `SDK_VERSION` in
`src/version.ts` must match `package.json` (a test checks it); after a new
minor version, raise the `yoink-bridge` range in `template/package.json` too.
The Deploy button only works once the version the template depends on is on
npm, because the template installs it from there.

## Status

0.8.0, the first public release (formerly the unpublished `yoink-relay`).
Publishing to npm is still pending. See [CHANGELOG.md](CHANGELOG.md).

## License

MIT, see [LICENSE](LICENSE).
