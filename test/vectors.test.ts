import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { describeBridge, MANIFEST_LIMITS, parseManifest, signWebhook, verifyWebhook } from '../src/index.ts';
import type {
  AppInfo,
  Attachment,
  ConnectionInfo,
  ManifestWaiting,
  DestinationRef,
  Due,
  Entry,
  EntrySendData,
  EntrySendEvent,
  EntryUndoData,
  EntryUndoEvent,
  EntryUpdateData,
  EntryUpdateEvent,
  Fit,
  KnownAttachmentKind,
  KnownDayPart,
  KnownEntryType,
  KnownTrigger,
  KnownUpdateChange,
  Manifest,
  ManifestDestination,
  PingData,
  PingEvent,
  PreviousEntry,
  YoinkEvent,
} from '../src/index.ts';
import { DEFAULT_TOLERANCE_SECONDS } from '../src/signature.ts';

const FIXTURE = new URL('./fixtures/webhook-vectors.json', import.meta.url);
/** SHA-256 of the vendored file; see test/fixtures/README.md. Update only when re-vendoring. */
const FIXTURE_SHA256 = '59aedb987a361cf20408768de5966061ed8c547a277304a0b054bb8db48b3326';

const raw = readFileSync(FIXTURE);
const vectors = JSON.parse(raw.toString('utf8')) as {
  format_version: number;
  tolerance_seconds: number;
  signing: { name: string; secret: string; id: string; timestamp: number; body: string; signature: string }[];
  verify: {
    name: string;
    secret: string;
    headers: Record<string, string>;
    body: string;
    now: number;
    valid: boolean;
    reason?: 'headers' | 'timestamp' | 'signature';
  }[];
  payloads: { name: string; json: unknown }[];
  manifests: {
    name: string;
    body: string;
    expect: {
      relay_name: string | null;
      settings_url?: string | null;
      destinations: { id: string; name: string; description: string; projects: string[]; mode: string; group: string | null }[];
      waiting?: { id: string; name: string; missing: string[] }[];
    };
  }[];
};

describe('vendored vectors', () => {
  it('are byte-identical to the copy from the app repo', () => {
    expect(createHash('sha256').update(raw).digest('hex')).toBe(FIXTURE_SHA256);
  });

  it('describe format v1 with the default tolerance', () => {
    expect(vectors.format_version).toBe(1);
    expect(vectors.tolerance_seconds).toBe(DEFAULT_TOLERANCE_SECONDS);
  });
});

describe('signing vectors', () => {
  it.each(vectors.signing.map((v) => [v.name, v] as const))('%s', async (_name, v) => {
    const signature = await signWebhook({ secret: v.secret, id: v.id, timestamp: v.timestamp, body: v.body });
    expect(signature).toBe(v.signature);
    // The same bytes, passed as bytes, sign identically.
    const bytes = new TextEncoder().encode(v.body);
    expect(await signWebhook({ secret: v.secret, id: v.id, timestamp: v.timestamp, body: bytes })).toBe(v.signature);
  });

  it('signatures verify', async () => {
    for (const v of vectors.signing) {
      const result = await verifyWebhook({
        secret: v.secret,
        headers: { 'webhook-id': v.id, 'webhook-timestamp': String(v.timestamp), 'webhook-signature': v.signature },
        body: v.body,
        now: v.timestamp,
      });
      expect(result, v.name).toEqual({ ok: true });
    }
  });
});

describe('verify vectors', () => {
  it.each(vectors.verify.map((v) => [v.name, v] as const))('%s', async (_name, v) => {
    const expected = v.valid ? { ok: true } : { ok: false, reason: v.reason };
    // Plain record, string body.
    expect(await verifyWebhook({ secret: v.secret, headers: v.headers, body: v.body, now: v.now })).toEqual(expected);
    // Fetch Headers, byte body, upper-case header names.
    const upper = Object.fromEntries(Object.entries(v.headers).map(([k, val]) => [k.toUpperCase(), val]));
    expect(
      await verifyWebhook({
        secret: v.secret,
        headers: new Headers(upper),
        body: new TextEncoder().encode(v.body),
        now: v.now,
      }),
    ).toEqual(expected);
    expect(await verifyWebhook({ secret: v.secret, headers: upper, body: v.body, now: v.now })).toEqual(expected);
  });

  it('rejects a malformed timestamp as a header problem', async () => {
    const v = vectors.verify[0]!;
    const headers = { ...v.headers, 'webhook-timestamp': '1792057297.5' };
    expect(await verifyWebhook({ secret: v.secret, headers, body: v.body, now: v.now })).toEqual({
      ok: false,
      reason: 'headers',
    });
  });

  it('honours a custom tolerance', async () => {
    const v = vectors.verify[0]!;
    const options = { secret: v.secret, headers: v.headers, body: v.body, now: v.now + 10 };
    expect(await verifyWebhook({ ...options, toleranceSeconds: 5 })).toEqual({ ok: false, reason: 'timestamp' });
    expect(await verifyWebhook({ ...options, toleranceSeconds: 10 })).toEqual({ ok: true });
  });

  it('accepts the secret without the whsec_ prefix and throws on a malformed one', async () => {
    const v = vectors.verify[0]!;
    const bare = v.secret.slice('whsec_'.length);
    expect(await verifyWebhook({ secret: bare, headers: v.headers, body: v.body, now: v.now })).toEqual({ ok: true });
    await expect(verifyWebhook({ secret: 'whsec_not base64!', headers: v.headers, body: v.body })).rejects.toThrow(
      TypeError,
    );
  });
});

// ---------------------------------------------------------------------------
// Payloads must match the TypeScript types exactly: every field the types
// declare is present with the right JSON type, and no field is undeclared.
// The schemas below are typed against the interfaces, so changing a type
// without updating its schema (or the other way round) fails `tsc`.
// Enumerations are open in the types (unknown values are additive), but the
// vectors must only use the known values, listed completely via `Known*`.

type Check = (value: unknown, path: string) => void;
type Schema<T> = { [K in keyof T]-?: Check };

const fail = (path: string, message: string): never => {
  throw new Error(`${path}: ${message}`);
};
const str: Check = (v, p) => void (typeof v === 'string' || fail(p, `expected string, got ${JSON.stringify(v)}`));
const num: Check = (v, p) => void (typeof v === 'number' || fail(p, `expected number, got ${JSON.stringify(v)}`));
const isoUtc: Check = (v, p) => {
  str(v, p);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(v as string)) fail(p, `not ISO-8601 UTC: ${v}`);
};
const literal =
  (expected: unknown): Check =>
  (v, p) =>
    void (v === expected || fail(p, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(v)}`));
const nullable =
  (check: Check): Check =>
  (v, p) =>
    v === null ? undefined : check(v, p);
/** All known members of a string union, checked for completeness by the compiler. */
const oneOf = <T extends string>(members: Record<T, true>): Check => {
  const allowed = Object.keys(members);
  return (v, p) => void (allowed.includes(v as string) || fail(p, `${JSON.stringify(v)} not in ${allowed.join('|')}`));
};
const object =
  <T>(schema: Schema<T>): Check =>
  (v, p) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(p, 'expected object');
    const record = v as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (!(key in schema)) fail(`${p}.${key}`, 'field is not declared in the types');
    }
    for (const [key, check] of Object.entries(schema) as [string, Check][]) {
      if (!(key in record)) {
        // Allowed only for optional fields, whose check accepts `undefined`.
        try {
          check(undefined, `${p}.${key}`);
        } catch {
          fail(`${p}.${key}`, 'missing');
        }
        continue;
      }
      check(record[key], `${p}.${key}`);
    }
  };
const arrayOf =
  (check: Check): Check =>
  (v, p) => {
    if (!Array.isArray(v)) fail(p, 'expected array');
    (v as unknown[]).forEach((item, i) => check(item, `${p}[${i}]`));
  };

const app = object<AppInfo>({ name: str, build: str });
const connection = object<ConnectionInfo>({ id: str, name: str });
const destination = object<DestinationRef>({ id: str, name: str });
const due = object<Due>({
  date: (v, p) => {
    str(v, p);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v as string)) fail(p, 'expected YYYY-MM-DD');
  },
  at: nullable(isoUtc),
  day_part: nullable(
    oneOf<KnownDayPart>({ morning: true, forenoon: true, noon: true, afternoon: true, evening: true, night: true }),
  ),
});
const entry = object<Entry>({
  id: str,
  title: nullable(str),
  text: str,
  project: nullable(str),
  type: oneOf<KnownEntryType>({ todo: true, reminder: true, note: true, idea: true }),
  due: nullable(due),
  created_at: isoUtc,
  source_url: nullable(str),
  attachments: arrayOf(
    object<Attachment>({
      kind: oneOf<KnownAttachmentKind>({ image: true, video: true, audio: true, file: true }),
      name: str,
    }),
  ),
});
const fit = object<Fit>({
  probability: (v, p) => {
    num(v, p);
    if ((v as number) < 0 || (v as number) > 1) fail(p, 'expected 0…1');
  },
});

const envelope = <E extends YoinkEvent>(type: E['type'], data: Check) =>
  object<E>({ version: literal(1), type: literal(type), timestamp: isoUtc, data } as Schema<E>);

const schemas: Record<YoinkEvent['type'], Check> = {
  'entry.send': envelope<EntrySendEvent>(
    'entry.send',
    object<EntrySendData>({
      app,
      connection,
      destination,
      trigger: oneOf<KnownTrigger>({ auto: true, suggestion: true, manual: true }),
      entry,
      fit: nullable(fit),
    }),
  ),
  'entry.undo': envelope<EntryUndoEvent>(
    'entry.undo',
    object<EntryUndoData>({
      app,
      connection,
      destination,
      delivery_id: str,
      external_id: str,
      entry: object<{ id: string }>({ id: str }),
    }),
  ),
  'entry.update': envelope<EntryUpdateEvent>(
    'entry.update',
    object<EntryUpdateData>({
      app,
      connection,
      destination,
      delivery_id: str,
      external_id: nullable(str),
      entry,
      previous: object<PreviousEntry>({ title: nullable(str), text: str, due: nullable(due) }),
      changes: (v, p) => {
        arrayOf(oneOf<KnownUpdateChange>({ title: true, text: true, due: true }))(v, p);
        // In this order, each at most once, at least one.
        const order = ['title', 'text', 'due'];
        const indices = (v as string[]).map((c) => order.indexOf(c));
        if (indices.length === 0 || indices.some((x, i) => i > 0 && x <= indices[i - 1]!)) {
          fail(p, `expected a non-empty subset of ${order.join(', ')} in that order`);
        }
      },
    }),
  ),
  ping: envelope<PingEvent>('ping', object<PingData>({ app, connection })),
};

describe('payload vectors', () => {
  it.each(vectors.payloads.map((p) => [p.name, p.json] as const))('%s matches the types', (_name, json) => {
    const type = (json as { type: YoinkEvent['type'] }).type;
    const check = schemas[type];
    expect(check, `no schema for ${type}`).toBeDefined();
    expect(() => check(json, '$')).not.toThrow();
  });

  it('cover every event type', () => {
    const types = new Set(vectors.payloads.map((p) => (p.json as { type: string }).type));
    expect([...types].sort()).toEqual(Object.keys(schemas).sort());
  });

  it('are the parsed bodies of the signing vectors', () => {
    const signedBodies = vectors.signing.slice(1).map((v) => JSON.parse(v.body) as unknown);
    for (const body of signedBodies) {
      expect(vectors.payloads.map((p) => p.json)).toContainEqual(body);
    }
  });

  it('schema check catches an undeclared field', () => {
    const ping = vectors.payloads.find((p) => (p.json as { type: string }).type === 'ping')!.json as PingEvent;
    const extra = { ...ping, data: { ...ping.data, surprise: 1 } };
    expect(() => schemas.ping(extra, '$')).toThrow(/surprise: field is not declared/);
  });
});

describe('manifest vectors', () => {
  it.each(vectors.manifests.map((m) => [m.name, m] as const))('%s', (_name, m) => {
    // Cases written before `settings_url`/`waiting` existed omit them: absent means none.
    const expected = {
      bridgeName: m.expect.relay_name,
      settingsUrl: m.expect.settings_url ?? null,
      destinations: m.expect.destinations,
      waiting: m.expect.waiting ?? [],
    };
    expect(parseManifest(m.body)).toEqual(expected);
    // Parsed JSON reads the same as the raw body, except for the 64 KB rule,
    // which only applies to the raw body (a parsed value has no byte size).
    if (Buffer.byteLength(m.body) > MANIFEST_LIMITS.bytes) return;
    let json: unknown;
    try {
      json = JSON.parse(m.body);
    } catch {
      return;
    }
    expect(parseManifest(json)).toEqual(expected);
  });

  it('the full manifest vector matches the Manifest type', () => {
    const optionalStr: Check = (v, p) => (v === undefined ? undefined : str(v, p));
    const check = object<Manifest>({
      relay: object<Manifest['relay']>({ name: optionalStr, sdk: optionalStr, settings_url: optionalStr }),
      destinations: arrayOf(
        object<ManifestDestination>({
          id: str,
          name: str,
          description: optionalStr,
          projects: (v, p) => (v === undefined ? undefined : arrayOf(str)(v, p)),
          mode: optionalStr,
          group: optionalStr,
        }),
      ),
      waiting: (v, p) =>
        v === undefined ? undefined : arrayOf(object<ManifestWaiting>({ id: str, name: str, missing: arrayOf(str) }))(v, p),
    });
    const full = (name: string) => JSON.parse(vectors.manifests.find((m) => m.name === name)!.body) as unknown;
    expect(() => check(full('two destinations, all fields'), '$')).not.toThrow();
    const waiting = full('waiting destinations and settings_url') as { waiting: Record<string, unknown>[] };
    // The vector deliberately contains invalid entries; the valid ones match the type.
    waiting.waiting = waiting.waiting.filter((w) => Array.isArray(w.missing) && w.id === 'bugs');
    expect(() => check(waiting, '$')).not.toThrow();
    const groups = full('groups: same group means only one of them; an invalid group means none, not a skipped destination') as {
      destinations: Record<string, unknown>[];
    };
    // Invalid groups are deliberate; the valid ones match the type.
    groups.destinations = groups.destinations.filter((d) => d.group === undefined || d.group === 'tracker');
    expect(() => check(groups, '$')).not.toThrow();
  });

  it('describeBridge lists what yoink reads, and what it skipped', () => {
    const text = describeBridge(vectors.manifests[0]!.body);
    expect(text).toContain('yoink reads 2 destinations from "Mein Relay":');
    expect(text).toContain('bugs: Linear · Bugs\n  mode:        auto');
    expect(text).toContain('  projects:    yoink\n  description: Konkrete Fehler an der yoink-App. Keine Ideen.');
    expect(text).toContain('einkauf: Einkaufsliste\n  mode:        suggest (only suggested on the entry)\n  projects:    all');

    const skipped = vectors.manifests.find((m) => m.name.startsWith('invalid and duplicate'))!;
    expect(describeBridge(skipped.body)).toContain('7 of 8 entries in the manifest were skipped');
    expect(describeBridge('ok')).toBe('yoink reads no destinations.\n');
  });
});

describe('parseManifest edge cases beyond the vectors', () => {
  const one = (destination: Record<string, unknown>) => parseManifest({ destinations: [destination] }).destinations;

  it('cuts by user-perceived characters, not UTF-16 units', () => {
    const [d] = one({ id: 'x', name: '👨‍👩‍👧'.repeat(61), description: 'é'.repeat(501) });
    expect(d!.name).toBe('👨‍👩‍👧'.repeat(60));
    expect(d!.description).toBe('é'.repeat(500));
  });

  it('treats a null mode as missing and non-string modes as unknown', () => {
    expect(one({ id: 'x', name: 'X', description: 'd', mode: null })[0]!.mode).toBe('auto');
    expect(one({ id: 'x', name: 'X', description: 'd', mode: 3 })[0]!.mode).toBe('suggest');
    expect(one({ id: 'x', name: 'X', description: 'd', mode: 'manual' })[0]!.mode).toBe('manual');
  });

  it('keeps at most 20 non-blank project names and ignores non-arrays', () => {
    const projects = ['  ', ...Array.from({ length: 25 }, (_, i) => ` p${i} `), 7];
    expect(one({ id: 'x', name: 'X', projects })[0]!.projects).toEqual(Array.from({ length: 20 }, (_, i) => `p${i}`));
    expect(one({ id: 'x', name: 'X', projects: 'yoink' })[0]!.projects).toEqual([]);
  });

  it('reads nothing from non-objects or a body over 64 KB', () => {
    for (const input of [null, 42, [], '[]', '"x"', { destinations: 'no' }]) {
      expect(parseManifest(input)).toEqual({ bridgeName: null, settingsUrl: null, destinations: [], waiting: [] });
    }
    const big = JSON.stringify({ destinations: [{ id: 'x', name: 'X' }], pad: 'x'.repeat(70_000) });
    expect(parseManifest(big).destinations).toEqual([]);
    expect(parseManifest(JSON.parse(big)).destinations).toHaveLength(1);
  });

  it('a blank bridge name reads as none', () => {
    expect(parseManifest({ relay: { name: '  ' }, destinations: [] }).bridgeName).toBeNull();
    expect(parseManifest({ relay: 'x', destinations: [] }).bridgeName).toBeNull();
  });
});

describe('waiting and groups in describeBridge', () => {
  it('shows waiting destinations and the settings link', () => {
    const text = describeBridge(vectors.manifests.find((m) => m.name === 'waiting destinations and settings_url')!.body);
    expect(text).toContain('  bugs: Linear · Bugs – waiting for LINEAR_API_KEY, LINEAR_TEAM');
    expect(text).toContain('  leer: Ohne Liste\n');
    expect(text).toContain('Add keys: https://dash.cloudflare.com/?to=/:account/workers/services/view/r/production/settings');
  });

  it('shows which destinations share a group', () => {
    const text = describeBridge(vectors.manifests.find((m) => m.name.startsWith('groups:'))!.body);
    expect(text).toContain('bugs: Linear · Bugs\n  mode:        auto');
    expect(text).toContain('  group:       tracker (an entry goes to at most one of bugs, issues, e)');
    expect(text.match(/group:/g)).toHaveLength(3);
  });
});
