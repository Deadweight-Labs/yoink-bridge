# yoink webhook format v1

**Status:** v1 (unreleased; stable from the release on, additive extensions
allowed) · English edition of the canonical spec in the yoink app repository
· Test vectors: [`test/fixtures/webhook-vectors.json`](test/fixtures/webhook-vectors.json)

yoink can send matching entries to a small server the user runs: the
**bridge**. The bridge tells yoink itself **which destinations it has and what
belongs in each**, in words the user writes in the bridge code ("Linear · Bugs:
concrete bugs in the yoink app, no ideas"). yoink fetches that list, checks
every new entry against it, and sends what fits to the right destination.
**Nothing is configured** in the app apart from the one-time connection:
yoink creates a key, the user gives it to the bridge, done.

yoink speaks exactly **one** fixed format. What the bridge makes of an entry (a
Linear issue, a Slack message, a row in a spreadsheet) is the user's code. The
reference bridge is this SDK, `yoink-bridge` (formerly `yoink-relay`); any
other program that implements this page works the same way.

Signatures and headers follow **[Standard Webhooks](https://www.standardwebhooks.com/)**
(v1). Existing verifier libraries for that spec check yoink webhooks without
changes.

## 0. The flow at a glance

```
Bridge code (user)             yoink (iPhone)                        decision model (via yoink's gateway)
──────────────────             ──────────────────────────            ────────────────────────────────────
destinations: {                1. "Bridge einrichten": new key, copied
  bugs: "bugs in the app"         → the user gives it to the bridge (KEY_FROM_YOINK_APP)
  shop: "things to buy"        2. open the bridge link, ping ─────► bridge
}                            ◄──────── destinations + descriptions
                               3. new entry (settled for 25 s)
                               4. "Does it fit bugs? shop?"  ──────► probability per destination
                               5. ≥ 0.80 → entry.send to "bugs" ──► bridge → onEntry → Linear
                               6. receipt "ABC-12 ↗" on the entry
```

## 1. Transport

- `POST <bridge URL>`, `https://` only. yoink follows **no** redirects (a 3xx
  counts as a failure, see §6): a redirect would carry body and signature to a
  different target.
- `Content-Type: application/json; charset=utf-8`
- `User-Agent: yoink/<version> (Webhook v1)`
- Timeout per attempt: 15 s.
- Requests are sent **directly from the iPhone** to the URL, not through the
  yoink gateway. yoink servers never see the content.

## 2. Headers (Standard Webhooks)

| Header | Content |
|---|---|
| `webhook-id` | Delivery ID, e.g. `msg_5d1e2f3a…`. **Identical across retries**: this is the idempotency key. |
| `webhook-timestamp` | Unix seconds of **this attempt** (every attempt is signed anew). |
| `webhook-signature` | `v1,<base64 signature>`; several signatures would be separated by spaces (key rotation). |

### Signature

```
key       = base64decode(secret without the prefix "whsec_")
content   = "<webhook-id>.<webhook-timestamp>.<raw body>"
signature = base64(HMAC-SHA256(key, content))
header    = "v1," + signature
```

The **bytes as sent** are signed; key order and whitespace of the JSON are not
normalized. A bridge therefore always verifies against the raw body before
parsing it.

The bridge **must**:
- compare signatures in constant time,
- reject requests with `|now − webhook-timestamp| > 300 s` (401),
- deduplicate by `webhook-id` (delivery is *at-least-once*, see §7),
- ignore unknown fields and reject an unknown `version` with 400.

The secret (the **key**) has the form `whsec_<base64(32 bytes)>`. **A bridge
has exactly one.** yoink creates it when the user sets up the bridge and
copies it once, for the user to give to the bridge (§9); afterwards it lives
in yoink's keychain only. Every device of the user that has this key is the
same connection. The bridge verifies every request against this one key and
needs no storage for it. On the bridge it is configuration (for
`yoink-bridge` on Cloudflare: the Worker secret `KEY_FROM_YOINK_APP`), never part of
a link, a web page or a log.

## 3. Destinations: what the bridge tells yoink about itself

The bridge answers every `ping` (§4.3) with its **manifest**: the list of its
destinations. yoink fetches it when connecting, on "Refresh destinations", and
on its own once the last sync is 6 hours old (at the app's next background
tick: never more often, but later while the app is closed).

```json
{
  "relay": { "name": "Meine Bridge", "sdk": "yoink-bridge/0.8.0" },
  "destinations": [
    {
      "id": "bugs",
      "name": "Linear · Bugs",
      "description": "Concrete bugs and small tasks in the yoink app: something that can be fixed or built. No ideas, no notes, no screenshots without a problem.",
      "projects": ["yoink"],
      "mode": "auto",
      "group": "tracker"
    },
    {
      "id": "shopping",
      "name": "Shopping list",
      "description": "Things that need to be bought.",
      "mode": "suggest"
    }
  ]
}
```

The manifest's top-level object keeps the name **`relay`** (`relay.name`,
`relay.sdk`, `relay.settings_url`) for compatibility: it predates the rename
of the SDK from `yoink-relay` to `yoink-bridge`, and yoink reads exactly
this field. It describes the bridge.

| Field | Meaning |
|---|---|
| `relay.name` | Display name of the bridge (optional, ≤ 60 characters). Otherwise the name from the connection link, or the host, is used. |
| `relay.sdk` | Optional: which software answers, e.g. `yoink-bridge/0.8.0`. |
| `destinations[].id` | Stable key, `[a-z0-9][a-z0-9_-]{0,39}`. Comes back in every `entry.send`. **Do not rename**: a new id is a new destination. |
| `destinations[].name` | Display name in yoink (required, ≤ 60 characters). |
| `destinations[].description` | **The explanation of what belongs here**, in the user's words, ≤ 500 characters. The decision model decides by it. Without a description nothing is sent automatically (only "Send to …" by hand). |
| `destinations[].projects` | Optional: only entries of these yoink projects qualify (names; case and accents don't matter). Without the field, or with an empty list or only blank names, every entry qualifies, including entries without a project. |
| `destinations[].mode` | `auto` (default when there is a description): confident matches go out by themselves, unsure ones are suggested. `suggest`: only suggestions on the entry. `manual`: never checked, only by hand. **`all`: every new entry (within `projects`) goes to the bridge unchecked, and the bridge decides itself** (§3.1); needs no description. Missing or `null` → `auto`; any other unknown value (also `"AUTO"` or a number) → `suggest`. Without a description always `manual`, except for `all`. |
| `destinations[].group` | Optional. **Destinations with the same group are alternatives: an entry goes to at most one of them.** yoink then asks the decision model once "A, B or neither?" instead of "does it fit?" per destination, and only the best one gets its delivery or suggestion. Without a group a destination is checked on its own and can get an entry in addition to others. Kept only if it is a string matching `[a-z0-9][a-z0-9_-]{0,39}` exactly (not trimmed, not lowercased); anything else (missing, not a string, empty, uppercase, leading space, too long) means no group. An invalid group never causes the destination to be skipped. Groups apply per bridge; for `manual` and `all` destinations a group has no effect. |

Two optional additions let yoink show what is still missing:

```json
{
  "relay": { "name": "Meine Bridge", "settings_url": "https://dash.cloudflare.com/…" },
  "destinations": [ … ],
  "waiting": [ { "id": "bugs", "name": "Linear · Bugs", "missing": ["LINEAR_API_KEY", "LINEAR_TEAM"] } ]
}
```

| Field | Meaning |
|---|---|
| `relay.settings_url` | Where the user adds the bridge's keys (trimmed; `https://` only, anything else is dropped). yoink shows it as "Add keys ↗". |
| `waiting[]` | Destinations that exist in the code but still miss keys: `id` and `name` as for `destinations` (trimmed and cut the same way; duplicate `id`s skipped), `missing` = the first 10 valid names of the missing settings (`[A-Z0-9_]{1,64}`, exact, not trimmed; never values). yoink shows them greyed out with "waiting for …" and sends nothing there. At most 20. A destination is either in `destinations` or in `waiting`, never in both. |

Rules yoink applies when reading (pinned down by the `manifests` test
vectors):
- A destination with an invalid or duplicate `id` or without a `name` is
  skipped, not the whole manifest; an invalid destination does not claim its
  `id`.
- At most 20 destinations: the first 20 **valid** ones; at most 20 project
  names: the first 20 non-blank ones.
- Texts are trimmed first, then cut. "Characters" means user-perceived
  characters (grapheme clusters, as Swift's `String.count`): a family emoji
  is one.
- An answer over 64 KB or without valid JSON means: no destinations.
- A manifest without a valid destination means "this bridge has no
  destinations".
- A `group` is read exactly as given or not at all (see the table); it does
  not affect whether a destination is read.

**What stays local in yoink:** each destination can be paused in the app,
nothing more. New destinations only apply to entries created **after** they
first appear (the old backlog is not sent). When a destination disappears from
the manifest, yoink stops sending there; existing receipts stay. A changed
description applies to new entries.

### 3.1 Your own routing: `mode: "all"`

Instead of letting yoink decide, a bridge can receive **everything** and
decide itself, with its own logic, its own AI keys and its own forms:
classify, add context, fill in fields, then send to Linear, Slack or anywhere.
It declares a destination with `mode: "all"` (say, `inbox`). Then:

- yoink sends every new entry within the project scope **without a fit
  check** (`trigger: "auto"`, `fit: null`), with no request to yoink's model.
- **Such a destination starts switched off in yoink.** Because every new
  entry then leaves the device, the user switches it on once (a toggle in
  Settings › Outputs). It applies to entries from that moment on. If an
  existing destination later changes to `all`, it is off again.
- What the bridge doesn't care about, it answers with `{ "ignored": true }`
  (§5): yoink then shows neither a receipt nor a hint. An `all` destination
  that answers without `label`/`url` stays quiet as well (no hint on every
  capture); the receipt is only in the detail view.
- Both can be mixed: destinations with a description (yoink checks) next to
  an `all` destination (the bridge checks).

### Writing good descriptions

The description is the whole configuration: it decides what goes out.

- **Say what belongs *and* what doesn't.** "Bugs in the app. No ideas, no
  feature requests" separates better than "Bugs".
- **Describe the content, not the tool.** "Concrete bugs that can be
  reproduced" rather than "everything for Linear".
- **Think of images:** the model sees up to 5 images of an entry.
  "Screenshots only if they show a bug" is a valid rule.
- **Narrow rather than wide** with `mode: "auto"`: unsure cases end up as a
  suggestion on the entry, not in the tool.
- **Scope with `projects`** when a destination belongs to one project only;
  that also saves checks.
- Destinations without a group are checked **independently**: an entry can
  fit two (say, Linear and Slack) and then goes to both. Alternatives (Linear
  *or* GitHub Issues) belong in one `group`, and their descriptions should
  then say which work goes where.
- **Within a group** the best-fitting destination wins. Once an entry went to
  one destination of the group (automatically or by hand), the others are
  no longer checked for it and their open suggestions disappear; "Send to …"
  by hand always stays possible.

## 4. Body

Envelope (as recommended by Standard Webhooks):

```json
{ "version": 1, "type": "<event>", "timestamp": "<ISO-8601 UTC>", "data": { … } }
```

`timestamp` is when yoink built this body (new on every retry). A body may
change between two attempts with the same `webhook-id` (the entry was edited
in between): the bridge processes the first delivery it accepts and
deduplicates the rest.

Every event carries `data.app` (`{ name: "yoink", build }`) and
`data.connection` (`{ id, name }`: this connection in yoink).

### 4.1 `entry.send`: an entry goes to a destination

```json
{
  "version": 1,
  "type": "entry.send",
  "timestamp": "2026-10-15T09:41:37Z",
  "data": {
    "app": { "name": "yoink", "build": "1.4 (212)" },
    "connection": { "id": "6f1c2a3e-…", "name": "Mein Relay" },
    "destination": { "id": "bugs", "name": "Linear · Bugs" },
    "trigger": "auto",
    "entry": {
      "id": "3c9e8f20-…",
      "title": "Absturz beim Teilen von Videos",
      "text": "Absturz beim Teilen von Videos 🎬\nPassiert nur bei Clips über 1 Minute …",
      "project": "yoink",
      "type": "todo",
      "due": { "date": "2026-10-16", "at": null, "day_part": null },
      "created_at": "2026-10-15T09:41:07Z",
      "source_url": null,
      "attachments": [ { "kind": "image", "name": "3c9e8f20-…-0.jpg" } ]
    },
    "fit": { "probability": 0.91 }
  }
}
```

| Field | Meaning |
|---|---|
| `destination` | The destination from the manifest (`id` + `name`) yoink sends this entry to. A bridge that does not (or no longer) know the `id` answers 422. |
| `trigger` | `auto` (check passed), `suggestion` (user confirmed a suggestion), `manual` ("Send to …"). |
| `entry.title` | Title or `null`. |
| `entry.text` | The text as the user sees it (without yoink's internal `#bild:`/`#themen:` lines). |
| `entry.project` | Project name or `null`. |
| `entry.type` | `todo` · `reminder` · `note` · `idea`: a coarse classification, not a routing signal. |
| `entry.due` | `null` or `{ date, at, day_part }`: `date` = the user's local day (`YYYY-MM-DD`); `at` = exact point in time in UTC, only when a time of day is known, else `null`; `day_part` = `morning` · `forenoon` · `noon` · `afternoon` · `evening` · `night` when the time came from a part of the day ("tonight"), else `null`. |
| `entry.created_at` | When the entry was captured (UTC). |
| `entry.source_url` | Shared link or `null`. |
| `entry.attachments` | Kind (`image` · `video` · `audio` · `file`) and file name only. **Image contents are not sent in v1.** |
| `fit` | `{ probability }` of the check against this destination's description (0…1; in a group, its share of the "A, B or neither" choice), or `null` if no check ran (sent by hand, or an `all` destination). |

### 4.2 `entry.undo`: withdraw

Sent when the user taps "Withdraw" ("Zurückziehen"). yoink only offers this
if the bridge answered an `external_id` when the entry was sent.

```json
{ "version": 1, "type": "entry.undo", "timestamp": "…",
  "data": { "app": {…}, "connection": {…},
            "destination": { "id": "bugs", "name": "Linear · Bugs" },
            "delivery_id": "msg_5d1e2f3a…", "external_id": "lin_issue_42",
            "entry": { "id": "3c9e8f20-…" } } }
```

`delivery_id` is the `webhook-id` of the original delivery. The undo has its
own `webhook-id`. yoink also offers "Withdraw" for a destination that has
since disappeared from the manifest; a bridge without a handler for it answers
422, and yoink says "Withdraw didn't work".

### 4.3 `ping`: connection test and manifest

Sent when connecting (§9), on "Refresh destinations", and on its own once
the last sync is 6 hours old (§3). Contains only `app` and `connection`. A
2xx confirms URL **and** key; the body is the manifest (§3). Never
deduplicated.

### 4.4 `entry.update`: edited after sending

When an entry is edited **after** it went to a destination (title, text or
due date), yoink sends the change to that destination, once per editing
burst: only when the entry has not changed for **2 minutes**. It is sent by
the device that sent the entry (also when the edit happened on another
device). Not for a mere change of project, not for withdrawn deliveries and
not after "ignored".

```json
{ "version": 1, "type": "entry.update", "timestamp": "…",
  "data": { "app": {…}, "connection": {…},
            "destination": { "id": "bugs", "name": "Linear · Bugs" },
            "delivery_id": "msg_5d1e2f3a…", "external_id": "lin_issue_42",
            "entry": { …as in entry.send, its state now… },
            "previous": { "title": "…", "text": "…", "due": { … } },
            "changes": ["text", "due"] } }
```

| Field | Meaning |
|---|---|
| `delivery_id` | `webhook-id` of the original delivery. |
| `external_id` | What the bridge answered when the entry was sent, or `null`. |
| `entry` | The whole entry as it is now (shape as in §4.1). |
| `previous` | What the destination got last: `title`, `text`, `due` (shapes as in `entry`). |
| `changes` | What changed, in this order: `title`, `text`, `due`. |

The reference bridge turns it into a **comment** ("In yoink geändert" with
what is new): the issue itself stays as it is, nothing in Linear or GitHub
is overwritten. A bridge without updates answers **501**: yoink then sends no
more updates for this delivery. Each editing round is one update with its
own `webhook-id`, which stays the same across its retries; like for
`entry.send`, the retries end at the latest 48 h after the first attempt. If
the user edits while a delivery is still being retried, the state of its
first attempt counts as "received", and the change follows as an update.
After an update is dropped (another 4xx, or its retries ran out), yoink
treats its state as what the destination last got: the next update's
`previous` starts from there, so a change that cannot be delivered is not
sent again and again.

## 5. Bridge response

- **`entry.send`, 2xx** = accepted. Optional JSON body (yoink reads at most 16 KB):
  ```json
  { "url": "https://linear.app/acme/issue/ABC-12", "label": "ABC-12", "external_id": "lin_issue_42" }
  ```
  - `url` (`https://` only, anything else is dropped) is shown in yoink as a back link.
  - `label` (max. 64 characters, longer is cut) is the chip text.
  - `external_id` (max. 256 characters) enables "Withdraw".
  - `ignored: true` means "taken, but nothing done with it": yoink shows no
    receipt and no hint, and no longer offers "Send to …" for this
    destination. The other fields are then ignored.
  - No body, or a body that is not JSON, is fine.
- **`ping`, 2xx**: body = manifest (yoink reads at most 64 KB). A bridge
  whose key is not configured yet answers 503 with the reason in `error`.
- **`entry.undo`, 2xx** = withdrawn; anything else leaves the entry marked as
  sent. A bridge without undo support answers 501.
- **`entry.update`, 2xx** = arrived (a body is not read). **501** = this
  destination cannot take updates: no more for this delivery. Other 4xx:
  this change is dropped. 401/403 and 404/410 as for `entry.send` (§6); 408,
  429, 5xx and network errors: retried with the intervals from §7, at most 5
  attempts, then this change is dropped (the next edit is sent again).
- `entry.undo` and `ping` are user gestures or a sync: **one** attempt, no
  retry.

## 6. Status codes → behaviour in yoink (`entry.send`)

| Response | yoink |
|---|---|
| 2xx | sent, receipt on the entry |
| 401, 403 | the bridge shows "check connection" (wrong secret), no retry; deliveries wait for a successful test |
| 404, 410 | the bridge is "unreachable" and paused, no retry |
| 3xx | failed (redirects are not followed) |
| 422 and other 4xx | failed, no retry, "Retry" on the entry; yoink fetches the manifest again (the destination may have been removed) |
| 408, 429, 5xx, timeout, DNS/TLS/network error | retried (§7) |

## 7. Retries and guarantees

- Delivery is **at-least-once**: after a timeout yoink cannot know whether the
  bridge already did the work, and sends the same `webhook-id` again. That is
  why deduplication in the bridge is mandatory.
- Intervals: 1 min → 10 min → 1 h → 6 h → 24 h, then "Not sent" with "Retry"
  on the entry. yoink only tries while it runs (launch or return to the
  foreground), so the intervals are minimums.
- **A retry chain ends at the latest 48 h after its first attempt**, even if
  the app did not run for that long. A bridge must therefore keep `webhook-id`s
  for deduplication for **at least 48 h** (the SDK does).
- Within a chain the `webhook-id` stays the same. A **new chain** ("Retry"
  after "Not sent", or sending again after "Withdraw") gets a new
  `webhook-id`.
- No ordering guarantee between entries.
- Per entry and destination, at most one delivery is open at a time.

## 8. Versioning

- `version` only increases for **incompatible** changes (a field removed or
  redefined). New fields and new `type` values are additive; bridges ignore
  what they do not know.
- A bridge rejects an unknown `version` with 400; yoink shows that as failed.
- New **values** of existing enumerations (`trigger`, `entry.type`,
  `day_part`, `attachments[].kind`, manifest `mode`) are additive too: whoever
  does not know a value treats it like a sensible default instead of
  rejecting it.

## 9. Connecting

1. In yoink the user taps **"Bridge einrichten"**. yoink creates a new key
   (`whsec_` + base64 of 32 random bytes), keeps it in the keychain and
   copies it to the clipboard ("Schlüssel kopieren").
2. The user gives the key to the bridge. With `yoink-bridge` on Cloudflare,
   they paste it into the deploy form as the secret `KEY_FROM_YOINK_APP`; any other
   bridge takes it as configuration (an environment variable, a secret).
   Whitespace around it is ignored.
3. The bridge's start page links back to yoink:

   ```
   yoink://ausgang?v=1&url=<https URL>&name=<name>
   ```

   All values are percent-encoded like JavaScript's `encodeURIComponent`
   (spaces as `%20`, never `+`); `v` and `url` are required, `name` is
   optional (the manifest's `relay.name` wins). Unknown parameters are
   ignored, a `secret` parameter too: **a link never carries the key**, so
   it is safe to show on a page or as a QR code. The user can also enter the
   URL in yoink by hand.
4. yoink sends a `ping` (§4.3) signed with the key. A 2xx with a manifest
   means connected; 401 means the bridge has a different key; 503 typically
   means the bridge has none yet.

All connections to one bridge use its one key; a second device gets the same
key (yoink offers to paste an existing one). A URL yoink is already
connected to is reconnected (same `connection.id`, the new key replaces the
old one). A bridge keeps accepting its key until the user changes it there;
after a leak, set the bridge up again in yoink and replace the key on the
bridge, and the old one stops working.

## 10. Test vectors

[`test/fixtures/webhook-vectors.json`](test/fixtures/webhook-vectors.json) is
canonical (maintained in the app repository and vendored here unchanged):

- `signing`: secret, ID, timestamp, body → expected signature (including the
  Standard Webhooks reference vector),
- `verify`: cases with `now` and the expected result (tampered body, wrong
  secret, replay under a new ID, several signatures, unknown signature
  version, time window, missing header),
- `payloads`: example bodies of all events,
- `responses`: bridge responses to `entry.send` → what yoink makes of them
  (including `ignored`),
- `manifests`: manifest answers to `ping` → which destinations (with their
  `group`, `null` when there is no valid one), waiting destinations and
  `settings_url` yoink reads from them.

Format changes change this file first; app tests and SDK tests run against the
same vectors.
