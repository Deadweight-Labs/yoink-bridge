# My yoink bridge

Your own bridge for [yoink](https://github.com/Deadweight-Labs/yoink-bridge#what-is-this),
on Cloudflare Workers. You describe your destinations in plain words
("concrete bugs in my app, no ideas"); yoink checks every new entry against
those descriptions and sends matches here, where they become a Linear or
GitHub issue, or whatever your code does.

This repository was created by **Deploy to Cloudflare** from the base in
[Deadweight-Labs/yoink-bridge](https://github.com/Deadweight-Labs/yoink-bridge).
It is yours: your destinations and your own code live in
[`bridge.ts`](bridge.ts); the SDK comes from npm as the dependency
`yoink-bridge`.

- SDK reference: [yoink-bridge README › Reference](https://github.com/Deadweight-Labs/yoink-bridge#reference)
- Wire format: [PROTOCOL.md](https://github.com/Deadweight-Labs/yoink-bridge/blob/main/PROTOCOL.md)
- What changed: [CHANGELOG.md](https://github.com/Deadweight-Labs/yoink-bridge/blob/main/CHANGELOG.md)

## Set up in 3 steps

1. **Get the key from yoink.** In yoink: **Einstellungen › Ausgänge › Bridge
   einrichten › Schlüssel kopieren**. yoink creates the key (it starts with
   `whsec_`) and copies it.
2. **Deploy.** Click **Deploy to Cloudflare** in the
   [yoink-bridge README](https://github.com/Deadweight-Labs/yoink-bridge#yoink-bridge)
   and paste the key you just copied into the field **`YOINK_SECRET`**: that
   is the key from the yoink app, never one you make up, and the only field
   you have to fill. Cloudflare copies
   this base into a new repository in your GitHub account (choose a private
   repository if your descriptions are personal), creates the KV namespace
   and deploys. If you are reading this in your own copy, this step is done.
3. **Open your bridge in yoink.** Open the Worker's URL
   (`https://yoink-bridge.<you>.workers.dev`) on your iPhone and tap **In
   yoink öffnen**, or scan its QR code. yoink connects with its key and shows
   your destinations.

That's it. Linear and GitHub show up greyed out, "wartet auf …", until you
add their keys (next section).

**Deutsch, kurz:** In yoink unter Einstellungen › Ausgänge › Bridge
einrichten den Schlüssel kopieren, beim Deploy als `YOINK_SECRET` einfügen,
danach die Worker-URL auf dem iPhone öffnen und „In yoink öffnen“ tippen.

The start page never shows the key, and the link carries none:
`yoink://ausgang?v=1&url=<your bridge>&name=<name>`. If `YOINK_SECRET` is
missing or mistyped, the page says so and links to the Worker's settings;
signed requests then answer 503 with the reason.

## Turn on Linear and GitHub

[`bridge.ts`](bridge.ts) declares two destinations. Each becomes active once
its settings exist:

| Destination | Settings | Where to get them |
|---|---|---|
| `linear` (Linear) | `LINEAR_API_KEY` | Linear → Settings → Security & access → Personal API keys → New key |
| | `LINEAR_TEAM` | the team key, i.e. the issue prefix (`ABC` for `ABC-12`) |
| `github` (GitHub · Issues) | `GITHUB_TOKEN` | GitHub → Settings → Developer settings → [Fine-grained tokens](https://github.com/settings/personal-access-tokens/new): only your repository, permission **Issues: Read and write** |
| | `GITHUB_REPO` | `owner/name`, e.g. `octocat/hello-world` (the repository URL works too) |

Add them in the Cloudflare dashboard: **Workers & Pages → your Worker →
Settings → Variables and Secrets → Add**, type **Secret**, then Deploy. Or in
a terminal: `npx wrangler secret put GITHUB_TOKEN`. Values can't be read back,
and they never go through yoink: the manifest only names the missing ones.
Then tap **Ziele aktualisieren** in yoink.

The deploy form asks only for `YOINK_SECRET`: Cloudflare's form treats every
secret it asks for as required, so the optional ones are added afterwards.

Both destinations start in `mode: 'suggest'`: yoink only suggests, you
confirm with one tap. Switch to `'auto'` once the description fits your work.

### Edits after sending

If you change an entry's title, text or due date in yoink after it went to
Linear or GitHub, yoink sends the change once you have stopped editing for
**2 minutes** (`entry.update`). The bridge adds it as a **comment** on the
issue, with only what changed:

```
**In yoink geändert**

Neuer Text:

> Absturz beim Teilen von Videos 🎬
> Passiert bei Clips über 1 Minute und bei Live-Fotos …

Fällig: 16.10.2026 → 20.10.2026

— via yoink
```

The issue's title and description are never overwritten, so nothing you or
others wrote in Linear or GitHub gets lost. A destination without `onUpdate`
answers 501, and yoink stops sending it updates for that entry; to turn
updates off for Linear or GitHub, add `onUpdate: undefined` after
`...linear({ … })`.

## Groups: one of several

Linear and GitHub are both in the group `tracker`:

```ts
linear: { name: 'Linear', description: '…', group: 'tracker', … },
github: { name: 'GitHub · Issues', description: '…', group: 'tracker', … },
```

Destinations with the same `group` are **alternatives**: an entry goes to at
most one of them (yoink asks its model "Linear, GitHub or neither?", and
once an entry went to one of them, the others are no longer offered for it).
A destination without a group is checked on its own, so an entry can go to
it *in addition* (say, a Slack channel next to the trackers). Groups apply
to destinations yoink checks; for `manual` and `all` they have no effect.

If both trackers are active, **make their descriptions say which work belongs
where**, e.g. "only the iOS app" for Linear and "only the website" for
GitHub. With identical descriptions the model has no basis to choose.

A group is an id like a destination id: `[a-z0-9][a-z0-9_-]{0,39}`, exact.
yoink ignores anything else (the destination then has no group; it is never
skipped), so the SDK refuses such a value at startup.

## Writing good descriptions

The description is the whole configuration: yoink's model reads it, and only
it, to decide whether an entry goes to a destination. Write it the way you
would brief a colleague who sorts your inbox, in the language you capture in.

- **Say what belongs *and* what doesn't.** "Bugs in the app. No ideas, no
  feature requests" separates far better than "Bugs".
- **Describe the content, not the tool.** The model knows your entries, not
  your Linear workspace. "Concrete bugs that can be reproduced" works;
  "everything for Linear" does not.
- **Think of images.** The model sees up to 5 images of an entry.
  "Screenshots only if they show an error" is a valid rule.
- **Keep `auto` narrow.** In `mode: 'auto'` confident matches go out by
  themselves; unsure ones become a suggestion. Start with `'suggest'`.
- **Scope with `projects`** when a destination belongs to one yoink project
  only. That is exact and saves checks.
- **Overlap:** destinations without a group are checked independently, and
  one entry can go to two of them. Put alternatives into one group.

| | Description |
|---|---|
| Bad | `Bugs` |
| Good | `Concrete bugs in the yoink app that someone can reproduce and fix: crashes, wrong behaviour, broken layouts. No feature ideas, no general notes.` |
| Bad | `Everything for the website repo` (names the tool, not the content) |
| Good | `Small, concrete tasks for our website: a broken link, a typo, an outdated price. Not redesign ideas or new pages.` |
| Bad | `Shopping` in `mode: 'auto'` (every "should get a new bike someday" gets posted) |
| Good | `Things that need to be bought soon: groceries, household items, gifts with a date. Not wish lists or product research.` in `mode: 'suggest'` |

Limits: name 60 characters, description 500, 20 projects, 20 destinations.
The SDK throws at startup if you exceed one instead of letting yoink cut or
skip it silently; `npm test` runs your `bridge.ts` and fails on it.

Good to know: the **id** (`linear`) is the stable key, renaming it creates a
new destination. New destinations only apply to entries created after yoink
first sees them. The only setting in the app is pausing a destination.

## Your own destination

A destination is a name, a description and an `onEntry` function. In
[`bridge.ts`](bridge.ts), next to Linear and GitHub (a commented-out version
of this is already at the end of the file):

```ts
import { BridgeError } from 'yoink-bridge';

interface Env extends WorkerEnv {
  // …
  NOTES_TOKEN?: string;
}

// inside destinations: (env) => ({ … })
notes: {
  name: 'Notizen',
  description: 'Längere Gedanken und Notizen zu Büchern. Keine Aufgaben, keine Einkäufe.',
  requires: ['NOTES_TOKEN'], // greyed out in yoink until the setting exists
  async onEntry(event) {
    const { entry } = event.data;
    const res = await fetch('https://notes.example/api/pages', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.NOTES_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ title: entry.title ?? entry.text.split('\n')[0], body: entry.text }),
    });
    if (!res.ok) throw new BridgeError(502, `notes answered ${res.status}`); // 5xx: yoink retries
    const page = (await res.json()) as { id: string; url: string };
    return { url: page.url, label: 'Notiz', external_id: page.id };
  },
  async onUndo(event) {
    // "Zurückziehen" in yoink; only offered when onEntry answered an external_id
    await fetch(`https://notes.example/api/pages/${event.data.external_id}`, { method: 'DELETE' });
  },
  async onUpdate(event) {
    // Edited in yoink after sending (optional; without it the bridge answers 501)
    const { external_id, entry, previous, changes } = event.data; // changes ⊆ ['title', 'text', 'due']
    // …
  },
},
```

What `onEntry` can answer:

- `{ url, label, external_id }` (all optional): yoink shows the label and
  link on the entry; `url` must be `https://`; `external_id` enables
  "Zurückziehen", which calls `onUndo`,
- nothing: sent, without a receipt,
- `ignore()` (from `yoink-bridge`): taken but dropped, yoink shows nothing
  (for `mode: 'all'`),
- `throw new BridgeError(status, message)`: 4xx is final (yoink shows
  "Retry" on the entry), 5xx makes yoink try again later (1 min, 10 min,
  1 h, 6 h, 24 h, at most 48 h). Avoid 404/410: yoink reads those as "bridge
  gone".

`onUpdate` gets `external_id` (what `onEntry` answered, or `null`), the
whole current `entry`, `previous` (`title`, `text`, `due` as last sent) and
`changes`. It answers nothing (204); a `BridgeError` with 4xx drops this
change, 5xx makes yoink try again, 501 stops updates for that entry.

yoink waits 15 s per attempt, so give slow calls a timeout below that.
Retries carry the same `webhook-id` (`ctx.id`, the second argument of every
handler) and are deduplicated by the bridge; pass `ctx.id` on as an
idempotency key where your downstream supports it.

The presets are building blocks for such code:
`linear(…).createIssue(event, { title, description, priority, labelNames })`,
`github(…).createIssue(event, { title, body, labels })`,
`linear(…).commentOnIssue(id, markdown)`,
`github(…).commentOnIssue('owner/name#12', markdown)`, `slack(…).post(text)`
(`yoink-bridge/presets/slack`), `discord(…).post(text)`
(`yoink-bridge/presets/discord`), and `updateComment(event)` from
`yoink-bridge/presets/shared` (the "In yoink geändert" text, `null` when
nothing it shows changed). All of it is in the
[SDK reference](https://github.com/Deadweight-Labs/yoink-bridge#reference).

## Recipes

[`recipes/`](recipes) holds copyable examples (their tests live in the
upstream repository):

- **[`router.ts`](recipes/router.ts): your own routing with Claude.** An
  `inbox` destination in `mode: 'all'` gets every new entry unchecked. Claude
  (`claude-opus-5-5`, structured outputs, with your `ANTHROPIC_API_KEY`)
  returns `{ kind, title, summary, priority, labels }`; `bug` and `task`
  become a Linear issue, `shopping` goes to Slack, the rest is `ignore()`d.
  To turn it on: add `ANTHROPIC_API_KEY` to `Env` in `bridge.ts` and as a
  Worker secret, uncomment `...routerDestinations(env)` and its import, then
  switch the new Inbox on in yoink (Einstellungen › Ausgänge): an `all`
  destination always starts switched off there.
- **[`custom-handler.ts`](recipes/custom-handler.ts): forward as JSON.** A
  destination that POSTs each entry to `FORWARD_URL` (your server, an n8n,
  Make or Zapier webhook, an Apps Script), with the answers and errors a
  handler should give.

**Privacy:** in `mode: 'all'` every new entry reaches your bridge and, from
there, whatever your code calls, with your keys. yoink makes you switch such
a destination on explicitly.

## Local development

Needs Node 22 or later.

```sh
npm install
cp .dev.vars.example .dev.vars
npm run keygen      # writes a development key into .dev.vars
npm run dev         # wrangler dev on http://localhost:8787
```

In a second terminal:

```sh
npm run check                                          # what yoink will read
npm run send -- --destination github --text "Login-Button reagiert nicht"
npm run send -- --destination github --text "Login" --update "Login-Button reagiert nicht"   # then edit it
```

Add `GITHUB_TOKEN`/`GITHUB_REPO` (or the Linear keys) to `.dev.vars` to try a
destination for real. `npm test` checks your `bridge.ts` the way yoink reads
it ([`test/bridge.test.ts`](test/bridge.test.ts); change its expectations
when you change your destinations), `npm run typecheck` checks the types,
and `npm run build` runs both. Workers Builds runs `npm run build` before
every deploy, so a broken bridge never goes live.

The `keygen` key is **for local development only.** Your deployed bridge uses
the key yoink created.

### CLI

`npm run cli -- …` runs the `yoink-bridge` binary from the SDK:

```
npm run cli -- check  --url <bridge-url> [--env-file <path> | --secret <whsec_…>]
npm run cli -- send   --url <bridge-url> [--env-file <path> | --secret <whsec_…>] [--text <text>]
                      [--title <title>] [--project <name>] [--destination <id>] [--trigger manual|suggestion|auto]
                      [--update <new text>]
npm run cli -- keygen [--env-file <path>]
```

(`npm run check` and `npm run send` add `--url http://localhost:8787
--env-file .dev.vars`, `npm run keygen` adds `--env-file .dev.vars`;
`npx yoink-bridge …` works too.)

- **`check`** sends a signed `ping` exactly like yoink and prints the
  destinations yoink will read (groups, waiting destinations, the settings
  link), or why the bridge refused (wrong key, redirect, unreachable).
- **`send`** posts a signed test `entry.send` (text "Test für meine Bridge"
  unless `--text`) and prints the receipt. `--destination` may be left out
  when the bridge has only one. With `--update <new text>` it then edits the
  entry: an `entry.update` for that delivery with the new text, as yoink
  sends after an edit, and says what yoink would make of the answer (501: no
  more updates).
- **`keygen`** prints `YOINK_SECRET=whsec_…` for local development, or with
  `--env-file` writes it into that file (filling an empty `YOINK_SECRET=`
  line, refusing to replace an existing key).

The key comes from `--secret`, else `YOINK_SECRET` in `--env-file` or the
environment, else the CLI asks for it without echoing. `--secret` ends up in
your shell history, so for your deployed bridge prefer the prompt:
`npm run cli -- check --url https://yoink-bridge.<you>.workers.dev`.
`http://` is allowed for localhost only.

## Updates

**You own your copy.** Nothing changes it behind your back; updates arrive as
pull requests you merge.

- **The SDK** is the npm dependency `yoink-bridge` in `package.json`. Your
  code stays in `bridge.ts` (and your own files), so there is nothing to
  merge: a new SDK version is a version bump.
- **Dependabot** (`.github/dependabot.yml`) opens weekly PRs for
  `yoink-bridge`, wrangler, the recipes' dependencies and the dev tools.
- **Every deploy is checked:** Workers Builds runs `npm run build`
  (typecheck + tests) before it deploys, so a PR that breaks your bridge
  fails instead of going live. Merging a green PR redeploys.
- Before 1.0, a new minor version of `yoink-bridge` (0.8 → 0.9) may change
  the API. Read the
  [CHANGELOG](https://github.com/Deadweight-Labs/yoink-bridge/blob/main/CHANGELOG.md)
  before merging such a PR.

## Files

| Path | |
|---|---|
| `bridge.ts` | **Your bridge**: destinations and your own code. The Worker's entry point (`main` in `wrangler.jsonc`). |
| `recipes/` | Copyable examples (AI router, forward as JSON). |
| `test/bridge.test.ts` | Checks `bridge.ts` the way yoink reads it. |
| `wrangler.jsonc` | Worker config: name, KV namespace `BRIDGE_KV`. |
| `package.json` | Scripts, the `yoink-bridge` dependency, and the deploy form's descriptions. |
| `.dev.vars.example` | Template for `.dev.vars` (local settings, git-ignored). |
