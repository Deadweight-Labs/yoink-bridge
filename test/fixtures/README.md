# Test vectors

`webhook-vectors.json` is **vendored** from the yoink app repository
(`yoinkTests/Fixtures/webhook-vectors.json`). It is the canonical set of test
vectors for the webhook format; the app and this SDK test against the same
file.

**Do not edit it by hand.** Format changes start in the app repo; then copy
the file here unchanged and update `FIXTURE_SHA256` in
`test/vectors.test.ts`, which fails on any byte difference.

| | |
|---|---|
| Vendored | 2026-10-18 |
| SHA-256 | `59aedb987a361cf20408768de5966061ed8c547a277304a0b054bb8db48b3326` |

The secrets in this file are test-only values.
