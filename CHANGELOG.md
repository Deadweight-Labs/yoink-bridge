# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
uses [Semantic Versioning](https://semver.org/).

## [0.8.0] - unreleased

First public release. The project was developed unpublished as
`yoink-relay` (0.1.0 to 0.7.0, never released); it is now **yoink-bridge**,
with a fresh history. It implements the yoink webhook format v1
([PROTOCOL.md](PROTOCOL.md)); the wire format is unchanged by the rename.

### Changed
- **Renamed from `yoink-relay` to `yoink-bridge`**, the concept "relay" to
  "bridge" throughout the API and the docs:
  - `createRelay` → `createBridge`, `Relay` → `Bridge`, `RelayOptions` →
    `BridgeOptions`, `RelayContext` → `BridgeContext`, `RelayError` →
    `BridgeError`, `describeRelay` → `describeBridge`,
    `ParsedManifest.relayName` → `bridgeName`.
  - `defineWorkerRelay` → `defineWorkerBridge` (returns `WorkerBridge`, was
    `WorkerRelay`), `WorkerRelayConfig` →
    `WorkerBridgeConfig`; the KV binding `RELAY_KV` → `BRIDGE_KV`; the Worker
    name `yoink-bridge` (`https://yoink-bridge.<you>.workers.dev`).
  - The manifest reports `relay.sdk` as `yoink-bridge/<version>`. The
    manifest field itself keeps its protocol name `relay`.
  - The key setting `YOINK_SECRET` → `KEY_FROM_YOINK_APP`: Cloudflare's
    deploy form showed only the name for this secret, not its `package.json`
    description (kept in case it ever shows up), so the name says where the
    key comes from.
  - The base Worker's file is `bridge.ts` (was `relay.ts`), its default name
    "Meine Bridge"; in yoink the setup is called "Bridge einrichten".

### Added
- **npm package `yoink-bridge`**, compiled to `dist/` with declarations.
  Exports: `yoink-bridge` (core), `yoink-bridge/cloudflare`,
  `yoink-bridge/node`, `yoink-bridge/presets/<github|linear|slack|discord|shared>`;
  the binary `yoink-bridge` (`npx yoink-bridge check --url …`). Zero runtime
  dependencies, Node ≥ 22; Web-standard APIs, so it runs on Workers, Deno,
  Bun and Node.
- **`template/`, the base Worker for "Deploy to Cloudflare".** Cloudflare
  copies only this folder into the user's new repository: `bridge.ts` with
  Linear and GitHub Issues built in, the recipes, a test, `wrangler.jsonc`
  and a `package.json` that depends on `yoink-bridge` from npm. SDK updates
  arrive as Dependabot PRs; no more `git pull upstream`. Building on the SDK
  without the base is just as supported.

### Features
What the SDK does as of this release:

- **Signature verification**, [Standard Webhooks](https://www.standardwebhooks.com/)
  v1 (HMAC-SHA256 with Web Crypto): constant-time comparison, several
  signatures, ±300 s tolerance, raw-body verification, 1 MiB body limit.
  `verifyWebhook`, `signWebhook`, `generateSecret`, `secretProblem`. One key
  per bridge, created by yoink.
- **Dedupe** by `webhook-id` (yoink delivers at-least-once): stored final
  answers, 503 while a delivery is in flight, ids kept 48 h.
  `MemoryDedupeStore`, `KVDedupeStore` (separate keys per state, within KV's
  one write per second per key), or your own `DedupeStore`.
- **Manifest and destinations:** `ping` answers the bridge's destinations
  with their descriptions, `projects`, `mode` (`auto`, `suggest`, `manual`,
  `all`) and `group` (alternatives: an entry goes to at most one of them);
  `waiting[]` for destinations whose settings are missing and
  `relay.settings_url` for where to add them. Everything yoink would skip,
  cut or read differently throws at startup ("the code is the config").
  `parseManifest` reads a manifest exactly like yoink; `describeBridge`
  renders it as text.
- **Events:** `entry.send` (`onEntry`, answering a receipt `{ url, label,
  external_id }`, nothing, or `ignore()`), `entry.undo` (`onUndo`) and
  `entry.update` (`onUpdate`, edits after sending; 501 without a handler
  stops updates for that entry). `BridgeError(status, message)` picks the
  answer; status codes follow what yoink understands. `received()` for a
  first test. Typed events with open enumerations.
- **Presets:** Linear (`linear`: create, archive on undo, comment on
  update) and GitHub Issues (`github`: create, close as "not planned" on
  undo, comment on update), Slack and Discord (post), each with its
  lower-level calls (`createIssue`, `commentOnIssue`, `post`, …) and
  `updateComment` for the "In yoink geändert" text. German texts like
  yoink. Permanent upstream errors → 422, temporary ones → 502 (retried).
- **Cloudflare adapter** (`defineWorkerBridge`): routing, `KEY_FROM_YOINK_APP`
  (503 with the reason while it is missing or invalid), dedupe in
  `BRIDGE_KV`, destinations that wait for their `requires`, sync or async
  `destinations(env)`, your own `routes`, and a start page with an
  "In yoink öffnen" button and QR code (never the key; strict CSP, German or
  English).
- **Node adapter** (`toNodeHandler`) for `node:http` and Express-style
  servers.
- **CLI:** `check` (a signed `ping` like yoink, prints what yoink will
  read), `send` (a signed test `entry.send`, with `--update` an
  `entry.update` after it) and `keygen` (a key for local development).
- Tested against the canonical test vectors of the yoink app
  (`test/fixtures/webhook-vectors.json`).
