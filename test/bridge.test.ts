import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createBridge,
  describeBridge,
  MemoryDedupeStore,
  parseManifest,
  received,
  BridgeError,
  SDK_VERSION,
  type DestinationConfig,
  type EntryHandler,
  type BridgeContext,
  type BridgeOptions,
} from '../src/index.ts';
import { deferred, newId, ping, SECRET, sendAuto, sendManual, signedRequest, undo, update } from './helpers.ts';
import pkg from '../package.json' with { type: 'json' };
import vectors from './fixtures/webhook-vectors.json' with { type: 'json' };

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

const noop = () => {};

/**
 * Bridge for the behaviour tests: `onEntry` serves both destinations used by
 * the payload vectors (`bugs` ← "entry.send auto", `einkauf` ← "entry.send
 * manual"); everything else is passed through.
 */
function testBridge({
  onEntry = noop,
  ...rest
}: Partial<Omit<BridgeOptions, 'destinations' | 'onEntry'>> & { onEntry?: EntryHandler }) {
  return createBridge({
    secret: SECRET,
    ...rest,
    destinations: {
      bugs: { name: 'Linear · Bugs', description: 'Concrete bugs in the yoink app.', onEntry },
      einkauf: { name: 'Einkaufsliste', description: 'Things to buy.', mode: 'suggest', onEntry },
    },
  });
}

/** An event addressed to another destination. */
function to<E extends { data: { destination: { id: string; name: string } } }>(event: E, id: string): E {
  return { ...event, data: { ...event.data, destination: { id, name: id } } };
}

describe('createBridge: the code is the config', () => {
  const dest = (extra: Partial<DestinationConfig> = {}): DestinationConfig => ({
    name: 'Bugs',
    description: 'Concrete bugs.',
    onEntry: noop,
    ...extra,
  });
  const make = (destinations: Record<string, DestinationConfig>, extra: Partial<BridgeOptions> = {}) =>
    createBridge({ secret: SECRET, ...extra, destinations } as BridgeOptions);

  it('requires a valid secret (surrounding whitespace is fine)', () => {
    expect(() => createBridge({ onEntry: noop } as never)).toThrow(/pass secret: the whsec_… key yoink created/);
    expect(() => createBridge({ secret: '', onEntry: noop })).toThrow(TypeError);
    expect(() => createBridge({ secret: 'whsec_***', onEntry: noop })).toThrow(/not valid base64/);
    expect(() => createBridge({ secret: `${SECRET}\n`, onEntry: noop })).not.toThrow();
  });

  it('requires destinations or onEntry, not both', () => {
    expect(() => createBridge({ secret: SECRET } as never)).toThrow(/pass destinations/);
    expect(() => createBridge({ secret: SECRET, onEntry: noop, destinations: { a: dest() } } as never)).toThrow(
      /either destinations or onEntry/,
    );
    expect(() => make({})).toThrow(/destinations is empty/);
  });

  it('rejects ids that yoink would skip', () => {
    for (const id of ['Bugs', '-x', '_x', 'a b', 'ümlaut', 'a'.repeat(41), '']) {
      expect(() => make({ [id]: dest() }), id).toThrow(/ids must match/);
    }
    expect(() => make({ ['a'.repeat(40)]: dest(), 'x_1-y': dest(), '0': dest() })).not.toThrow();
  });

  it('rejects a missing, blank or too long name (yoink would skip or cut it)', () => {
    expect(() => make({ a: dest({ name: undefined as never }) })).toThrow(/destination "a": name must be a string/);
    expect(() => make({ a: dest({ name: '   ' }) })).toThrow(/destination "a": name is empty/);
    expect(() => make({ a: dest({ name: 'N'.repeat(61) }) })).toThrow(/61 characters long; the limit is 60/);
    expect(() => make({ a: dest({ name: 'N'.repeat(60) }) })).not.toThrow();
    // Characters are user-perceived characters: a family emoji counts once.
    expect(() => make({ a: dest({ name: '👨‍👩‍👧'.repeat(60) }) })).not.toThrow();
    expect(() => make({ a: dest({ name: '👨‍👩‍👧'.repeat(61) }) })).toThrow(/61 characters/);
  });

  it('rejects a description over 500 characters', () => {
    expect(() => make({ a: dest({ description: 'd'.repeat(501) }) })).toThrow(/description is 501 characters/);
    expect(() => make({ a: dest({ description: 'd'.repeat(500) }) })).not.toThrow();
    expect(() => make({ a: dest({ description: 42 as never }) })).toThrow(/description must be a string/);
  });

  it('rejects more than 20 destinations', () => {
    const many = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`d${i}`, dest()]));
    expect(() => make(many(21))).toThrow(/21 destinations; the limit is 20/);
    expect(() => make(many(20))).not.toThrow();
  });

  it('rejects unknown modes and auto/suggest without a description', () => {
    expect(() => make({ a: dest({ mode: 'always' as never }) })).toThrow(/unknown mode "always"/);
    expect(() => make({ a: dest({ description: undefined, mode: 'auto' }) })).toThrow(/needs a description/);
    expect(() => make({ a: dest({ description: '  ', mode: 'suggest' }) })).toThrow(/needs a description/);
    expect(() => make({ a: dest({ description: undefined, mode: 'manual' }) })).not.toThrow();
    expect(() => make({ a: dest({ description: undefined }) })).not.toThrow();
  });

  it('rejects a group yoink would ignore; keeps a valid one exactly', () => {
    for (const group of ['Tracker', ' tracker', 'tracker ', '', '-x', 'a'.repeat(41), 'ü', 7, null]) {
      expect(() => make({ a: dest({ group: group as never }) }), String(group)).toThrow(/group must match/);
    }
    const bridge = make({ a: dest({ group: 'tracker' }), b: dest({ group: 'tracker' }), c: dest({ group: 'a'.repeat(40) }), d: dest() });
    expect(bridge.manifest.destinations.map((d) => d.group)).toEqual(['tracker', 'tracker', 'a'.repeat(40), undefined]);
    expect('group' in bridge.manifest.destinations[3]!).toBe(false);
  });

  it('rejects project lists yoink would read differently', () => {
    expect(() => make({ a: dest({ projects: [] }) })).toThrow(/projects is empty; omit it/);
    expect(() => make({ a: dest({ projects: ['yoink', ' '] }) })).toThrow(/projects\[1\] is empty/);
    expect(() => make({ a: dest({ projects: ['P'.repeat(61)] }) })).toThrow(/projects\[0\] is 61 characters/);
    expect(() => make({ a: dest({ projects: Array.from({ length: 21 }, (_, i) => `p${i}`) }) })).toThrow(
      /21 projects; the limit is 20/,
    );
    expect(() => make({ a: dest({ projects: 'yoink' as never }) })).toThrow(/projects must be an array/);
  });

  it('requires handlers to be functions', () => {
    expect(() => make({ a: dest({ onEntry: undefined as never }) })).toThrow(/destination "a": onEntry must be a function/);
    expect(() => make({ a: dest({ onUndo: 'no' as never }) })).toThrow(/onUndo must be a function/);
    expect(() => make({ a: dest({ onUpdate: 'no' as never }) })).toThrow(/a": onUpdate must be a function/);
    expect(() => make({ a: dest() }, { onUpdate: 1 as never })).toThrow(/createBridge: onUpdate must be a function/);
    expect(() => make({ a: dest() }, { onPing: 1 as never })).toThrow(/onPing must be a function/);
  });

  it('rejects a bridge name over 60 characters', () => {
    expect(() => make({ a: dest() }, { name: 'R'.repeat(61) })).toThrow(/name is 61 characters/);
  });

  it('works when fetch is passed around unbound', async () => {
    const { fetch } = testBridge({});
    expect((await fetch(await signedRequest(ping()))).status).toBe(200);
  });
});

describe('manifest (ping)', () => {
  const vector = vectors.manifests[0]!;

  it('answers 200 with the manifest, byte-identical to the vector for the same config', async () => {
    const bridge = createBridge({
      secret: SECRET,
      name: 'Mein Relay', // as in the vector, written before the rename
      destinations: {
        bugs: {
          name: 'Linear · Bugs',
          description: 'Konkrete Fehler an der yoink-App. Keine Ideen.',
          projects: ['yoink'],
          mode: 'auto',
          onEntry: noop,
        },
        einkauf: { name: 'Einkaufsliste', description: 'Dinge, die gekauft werden müssen.', mode: 'suggest', onEntry: noop },
      },
    });
    const res = await bridge.fetch(await signedRequest(ping()));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    // The vector was written by an earlier SDK version (yoink-relay); only `relay.sdk` differs.
    const expected = vector.body.replace(/"sdk":"yoink-relay\/[^"]+"/, `"sdk":"yoink-bridge/${SDK_VERSION}"`);
    expect(await res.text()).toBe(expected);
    expect(SDK_VERSION).toBe(pkg.version);
  });

  it('leaves out what is not set, and trims (template literals are fine)', async () => {
    const bridge = createBridge({
      secret: SECRET,
      destinations: {
        notes: {
          name: ' Notion ',
          description: `
            Longer thoughts about the book.
          `,
          onEntry: noop,
        },
        inbox: { name: 'Inbox', onEntry: noop },
      },
    });
    expect(bridge.manifest).toEqual({
      relay: { sdk: `yoink-bridge/${SDK_VERSION}` },
      destinations: [
        { id: 'notes', name: 'Notion', description: 'Longer thoughts about the book.' },
        { id: 'inbox', name: 'Inbox' },
      ],
    });
    expect(await (await bridge.fetch(await signedRequest(ping()))).json()).toEqual(bridge.manifest);
  });

  it('short form: one manual destination "default" named after the bridge', async () => {
    const bridge = createBridge({ secret: SECRET, name: 'Meine Bridge', onEntry: noop });
    expect(bridge.manifest.destinations).toEqual([{ id: 'default', name: 'Meine Bridge', mode: 'manual' }]);
    expect(createBridge({ secret: SECRET, onEntry: noop }).manifest).toEqual({
      relay: { sdk: `yoink-bridge/${SDK_VERSION}` },
      destinations: [{ id: 'default', name: 'Bridge', mode: 'manual' }],
    });
  });

  it('parses back to exactly its config', () => {
    const destinations: Record<string, DestinationConfig> = {
      bugs: { name: 'Linear · Bugs', description: 'Bugs. No ideas.', projects: ['yoink', 'Web'], group: 'tracker', onEntry: noop },
      issues: { name: 'GitHub · Issues', description: 'Bugs in the code.', group: 'tracker', onEntry: noop },
      shopping: { name: 'Shopping', description: 'Things to buy.', mode: 'suggest', onEntry: noop },
      later: { name: 'Later', description: 'Anything to read later.', mode: 'manual', onEntry: noop },
      inbox: { name: 'Inbox 📥', onEntry: noop },
    };
    const bridge = createBridge({ secret: SECRET, name: 'Meine Bridge', destinations });
    expect(parseManifest(JSON.stringify(bridge.manifest))).toEqual({
      bridgeName: 'Meine Bridge',
      settingsUrl: null,
      waiting: [],
      destinations: Object.entries(destinations).map(([id, d]) => ({
        id,
        name: d.name,
        description: d.description ?? '',
        projects: d.projects ?? [],
        mode: d.mode ?? (d.description ? 'auto' : 'manual'),
        group: d.group ?? null,
      })),
    });
    expect(describeBridge(bridge)).toContain('  group:       tracker (an entry goes to at most one of bugs, issues)');
  });

  it('is frozen', () => {
    const bridge = testBridge({});
    expect(Object.isFrozen(bridge.manifest)).toBe(true);
    expect(Object.isFrozen(bridge.manifest.destinations[0])).toBe(true);
  });

  it('is never deduplicated, so a repeated ping checks again', async () => {
    const onPing = vi.fn();
    const store = new MemoryDedupeStore();
    const bridge = testBridge({ onPing, dedupe: store });
    const id = newId();
    await bridge.fetch(await signedRequest(ping(), { id }));
    await bridge.fetch(await signedRequest(ping(), { id }));
    expect(onPing).toHaveBeenCalledTimes(2);
    expect(store.size).toBe(0);
  });

  it('onPing can add fields but not replace relay or destinations', async () => {
    const bridge = testBridge({ onPing: () => ({ build: 'abc123', destinations: [], relay: { name: 'x' } }) });
    const body = await (await bridge.fetch(await signedRequest(ping()))).json();
    expect(body).toEqual({ ...bridge.manifest, build: 'abc123' });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('"destinations", which is reserved'));

    const quiet = testBridge({ onPing: () => {} });
    expect(await (await quiet.fetch(await signedRequest(ping()))).json()).toEqual(quiet.manifest);
  });

  it('onPing can fail the connection test', async () => {
    const failing = testBridge({
      onPing: () => {
        throw new BridgeError(503, 'SLACK_WEBHOOK_URL is not set');
      },
    });
    const res = await failing.fetch(await signedRequest(ping()));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'SLACK_WEBHOOK_URL is not set' });
  });

  it('500 when onPing makes the answer larger than yoink reads (64 KB)', async () => {
    const bridge = testBridge({ onPing: () => ({ padding: 'x'.repeat(70_000) }) });
    const res = await bridge.fetch(await signedRequest(ping()));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'manifest too large' });
  });
});

describe('dispatch by destination', () => {
  it('routes entry.send to the destination named in data.destination.id', async () => {
    const bugs = vi.fn(() => ({ label: 'ABC-12' }));
    const shopping = vi.fn();
    const bridge = createBridge({
      secret: SECRET,
      destinations: {
        bugs: { name: 'Bugs', description: 'Bugs.', onEntry: bugs },
        einkauf: { name: 'Einkauf', description: 'Things to buy.', onEntry: shopping },
      },
    });
    const a = await bridge.fetch(await signedRequest(sendAuto()));
    expect(a.status).toBe(200);
    expect(await a.json()).toEqual({ label: 'ABC-12' });
    const b = await bridge.fetch(await signedRequest(sendManual()));
    expect(b.status).toBe(204);
    expect(bugs).toHaveBeenCalledOnce();
    expect(shopping).toHaveBeenCalledOnce();
    expect(shopping.mock.calls[0]![0]).toEqual(sendManual());
  });

  it('422 unknown_destination for an unknown, missing or inherited id, without running a handler', async () => {
    const onEntry = vi.fn();
    const bridge = testBridge({ onEntry });
    for (const id of ['removed', 'toString', 'constructor', '__proto__']) {
      const res = await bridge.fetch(await signedRequest(to(sendAuto(), id)));
      expect(res.status, id).toBe(422);
      expect(await res.json()).toEqual({ error: 'unknown_destination' });
    }
    const event = sendAuto();
    const { destination: _omit, ...data } = event.data;
    expect((await bridge.fetch(await signedRequest({ ...event, data }))).status).toBe(422);
    const numeric = to(sendAuto(), 'x');
    (numeric.data.destination as { id: unknown }).id = 7;
    expect((await bridge.fetch(await signedRequest(numeric))).status).toBe(422);
    expect(onEntry).not.toHaveBeenCalled();
  });

  it('a destination may be called "constructor"', async () => {
    const onEntry = vi.fn();
    const bridge = createBridge({ secret: SECRET, destinations: { constructor: { name: 'C', onEntry } } });
    expect((await bridge.fetch(await signedRequest(to(sendAuto(), 'constructor')))).status).toBe(204);
    expect(onEntry).toHaveBeenCalledOnce();
  });

  it('short form handles destination "default" only', async () => {
    const onEntry = vi.fn();
    const bridge = createBridge({ secret: SECRET, onEntry });
    expect((await bridge.fetch(await signedRequest(to(sendAuto(), 'default')))).status).toBe(204);
    expect((await bridge.fetch(await signedRequest(sendAuto()))).status).toBe(422);
    expect(onEntry).toHaveBeenCalledOnce();
  });
});

describe('request checks', () => {
  it('405 for anything but POST', async () => {
    const bridge = testBridge({ secret: SECRET, onEntry: noop });
    for (const method of ['GET', 'HEAD', 'PUT', 'OPTIONS']) {
      const res = await bridge.fetch(new Request('https://bridge.example/', { method }));
      expect(res.status, method).toBe(405);
      expect(res.headers.get('allow')).toBe('POST');
    }
  });

  it('413 when the body is over the limit (streamed and declared)', async () => {
    const onEntry = vi.fn();
    const bridge = testBridge({ secret: SECRET, onEntry, maxBodyBytes: 100 });
    const streamed = await signedRequest(sendAuto());
    expect(streamed.headers.get('content-length')).toBeNull();
    expect((await bridge.fetch(streamed)).status).toBe(413);

    const declared = new Request('https://bridge.example/', {
      method: 'POST',
      headers: { 'content-length': '5000' },
      body: 'x',
    });
    expect((await bridge.fetch(declared)).status).toBe(413);
    expect(onEntry).not.toHaveBeenCalled();
  });

  it('default limit is 1 MiB', async () => {
    const bridge = testBridge({ secret: SECRET, onEntry: noop });
    const event = sendManual();
    event.data.entry.text = 'x'.repeat(1024 * 1024);
    expect((await bridge.fetch(await signedRequest(event))).status).toBe(413);
  });

  it('401 for a bad signature, a wrong secret, missing headers or a stale timestamp', async () => {
    const onEntry = vi.fn();
    const bridge = testBridge({ secret: SECRET, onEntry });

    const tampered = await signedRequest(sendAuto());
    const body = (await tampered.text()).replace('Absturz', 'Abstutz');
    const res1 = await bridge.fetch(new Request(tampered.url, { method: 'POST', headers: tampered.headers, body }));
    expect(res1.status).toBe(401);
    expect(await res1.json()).toEqual({ error: 'invalid signature' });

    const otherSecret = 'whsec_//79/Pv6+fj39vX08/Lx8O/u7ezr6uno5+bl5OPi4eA=';
    expect((await bridge.fetch(await signedRequest(sendAuto(), { secret: otherSecret }))).status).toBe(401);

    const unsigned = new Request('https://bridge.example/', { method: 'POST', body: JSON.stringify(sendAuto()) });
    const res3 = await bridge.fetch(unsigned);
    expect(res3.status).toBe(401);
    expect(await res3.json()).toEqual({ error: 'missing or malformed webhook headers' });

    const stale = await signedRequest(sendAuto(), { timestamp: Math.floor(Date.now() / 1000) - 301 });
    const res4 = await bridge.fetch(stale);
    expect(res4.status).toBe(401);
    expect(await res4.json()).toEqual({ error: 'webhook-timestamp outside the allowed tolerance' });

    expect(onEntry).not.toHaveBeenCalled();
  });

  it('honours toleranceSeconds', async () => {
    const bridge = testBridge({ secret: SECRET, onEntry: noop, toleranceSeconds: 600 });
    const old = await signedRequest(sendAuto(), { timestamp: Math.floor(Date.now() / 1000) - 400 });
    expect((await bridge.fetch(old)).status).toBe(204);
  });

  it('400 for an unknown version, before any handler runs', async () => {
    const onEntry = vi.fn();
    const bridge = testBridge({ secret: SECRET, onEntry });
    const v2 = { ...sendAuto(), version: 2 };
    const res = await bridge.fetch(await signedRequest(v2));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'unsupported version: 2' });

    const { version: _omit, ...noVersion } = sendAuto();
    expect((await bridge.fetch(await signedRequest(noVersion))).status).toBe(400);
    expect(onEntry).not.toHaveBeenCalled();
  });

  it('400 for a signed body that is not a JSON object', async () => {
    const bridge = testBridge({ secret: SECRET, onEntry: noop });
    expect((await bridge.fetch(await signedRequest('not json'))).status).toBe(400);
    expect((await bridge.fetch(await signedRequest('[1,2]'))).status).toBe(400);
    expect((await bridge.fetch(await signedRequest({ version: 1, type: 'entry.send' }))).status).toBe(400);
  });

  it('204 for an unknown type (also the retired connection.pair/unpair), without calling any handler', async () => {
    const onEntry = vi.fn();
    const onUndo = vi.fn();
    const onUpdate = vi.fn();
    const onPing = vi.fn();
    const bridge = testBridge({ secret: SECRET, onEntry, onUndo, onUpdate, onPing });
    for (const type of ['entry.archive', 'connection.pair', 'connection.unpair']) {
      const future = { version: 1, type, timestamp: '2026-10-15T10:00:00Z', data: { anything: true } };
      const res = await bridge.fetch(await signedRequest(future));
      expect(res.status, type).toBe(204);
      expect(await res.text()).toBe('');
    }
    expect(onEntry).not.toHaveBeenCalled();
    expect(onUndo).not.toHaveBeenCalled();
    expect(onUpdate).not.toHaveBeenCalled();
    expect(onPing).not.toHaveBeenCalled();
  });

  it('verifies before parsing: an unsigned body gets 401, even when it is not JSON', async () => {
    const bridge = testBridge({});
    const res = await bridge.fetch(new Request('https://bridge.example/', { method: 'POST', body: 'not json' }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'missing or malformed webhook headers' });
  });

  it('accepts unknown enum values (they are additive) and passes them through', async () => {
    const onEntry = vi.fn();
    const bridge = testBridge({ secret: SECRET, onEntry });
    const event = sendAuto();
    event.data.trigger = 'scheduled';
    event.data.entry.type = 'event';
    event.data.entry.due = { date: '2026-10-16', at: null, day_part: 'dawn' };
    event.data.entry.attachments = [{ kind: 'hologram', name: 'x.holo' }];
    const res = await bridge.fetch(await signedRequest(event));
    expect(res.status).toBe(204);
    expect(onEntry.mock.calls[0]![0]).toEqual(event);
  });

  it('ignores unknown fields', async () => {
    const onEntry = vi.fn();
    const bridge = testBridge({ secret: SECRET, onEntry });
    const event = { ...sendAuto(), extra: 1, data: { ...sendAuto().data, future_field: { x: 1 } } };
    expect((await bridge.fetch(await signedRequest(event))).status).toBe(204);
    expect(onEntry).toHaveBeenCalledOnce();
  });
});

describe('entry.send', () => {
  it('200 with exactly the returned receipt fields', async () => {
    const bridge = testBridge({
      secret: SECRET,
      onEntry: () => ({ url: 'https://linear.app/acme/issue/ABC-12', label: 'ABC-12', external_id: 'lin_issue_42' }),
    });
    const res = await bridge.fetch(await signedRequest(sendAuto()));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    expect(await res.text()).toBe(
      '{"url":"https://linear.app/acme/issue/ABC-12","label":"ABC-12","external_id":"lin_issue_42"}',
    );
  });

  it('leaves out fields that were not given and drops non-string or unknown ones', async () => {
    const bridge = testBridge({
      secret: SECRET,
      onEntry: () => ({ label: 'X-1', url: undefined, external_id: 42, extra: 'no' }) as never,
    });
    const res = await bridge.fetch(await signedRequest(sendAuto()));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"label":"X-1"}');
  });

  it('204 when the handler returns nothing', async () => {
    const bridge = testBridge({ secret: SECRET, onEntry: async () => {} });
    const res = await bridge.fetch(await signedRequest(sendAuto()));
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
  });

  it('passes the typed event and { id, timestamp, request }', async () => {
    const onEntry = vi.fn();
    const bridge = testBridge({ secret: SECRET, onEntry });
    const id = newId();
    const timestamp = Math.floor(Date.now() / 1000) - 5;
    const request = await signedRequest(sendManual(), { id, timestamp });
    await bridge.fetch(request);
    expect(onEntry).toHaveBeenCalledOnce();
    const [event, ctx] = onEntry.mock.calls[0] as [unknown, BridgeContext];
    expect(event).toEqual(sendManual());
    expect(ctx).toEqual({ id, timestamp, request });
  });
});

describe('entry.undo', () => {
  it('warns once per destination when it hands out an external_id but undo is not supported', async () => {
    const bridge = testBridge({ onEntry: () => ({ external_id: 'x' }) });
    await bridge.fetch(await signedRequest(sendAuto()));
    await bridge.fetch(await signedRequest(sendAuto()));
    expect(console.warn).toHaveBeenCalledOnce();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('destination "bugs"'));
  });

  it('501 when no onUndo is configured anywhere', async () => {
    const bridge = testBridge({});
    const res = await bridge.fetch(await signedRequest(undo()));
    expect(res.status).toBe(501);
    expect((await bridge.fetch(await signedRequest(to(undo(), 'removed')))).status).toBe(501);
  });

  it("uses the destination's onUndo, then the top-level one", async () => {
    const own = vi.fn();
    const fallback = vi.fn();
    const bridge = createBridge({
      secret: SECRET,
      onUndo: fallback,
      destinations: {
        bugs: { name: 'Bugs', description: 'Bugs.', onEntry: noop, onUndo: own },
        other: { name: 'Other', description: 'Other.', onEntry: noop },
      },
    });
    expect((await bridge.fetch(await signedRequest(undo()))).status).toBe(204);
    expect(own.mock.calls[0]![0]).toEqual(undo());
    expect(fallback).not.toHaveBeenCalled();

    expect((await bridge.fetch(await signedRequest(to(undo(), 'other')))).status).toBe(204);
    // A destination removed since the send can still be withdrawn by the fallback.
    expect((await bridge.fetch(await signedRequest(to(undo(), 'removed')))).status).toBe(204);
    expect(fallback).toHaveBeenCalledTimes(2);
  });

  it('501 for a known destination without undo, 422 for an unknown one, when only some support it', async () => {
    const bridge = createBridge({
      secret: SECRET,
      destinations: {
        bugs: { name: 'Bugs', description: 'Bugs.', onEntry: noop, onUndo: noop },
        other: { name: 'Other', description: 'Other.', onEntry: noop },
      },
    });
    expect((await bridge.fetch(await signedRequest(to(undo(), 'other')))).status).toBe(501);
    const res = await bridge.fetch(await signedRequest(to(undo(), 'removed')));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'unknown_destination' });
  });

  it('maps errors like entry.send', async () => {
    const bridge = testBridge({
      onUndo: () => {
        throw new BridgeError(409, 'issue already closed');
      },
    });
    const res = await bridge.fetch(await signedRequest(undo()));
    expect(res.status).toBe(409);
  });
});

describe('entry.update', () => {
  it("calls the destination's onUpdate with the event and answers 204", async () => {
    const onUpdate = vi.fn();
    const bridge = createBridge({
      secret: SECRET,
      destinations: { bugs: { name: 'Bugs', description: 'Bugs.', onEntry: noop, onUpdate } },
    });
    const id = newId();
    const timestamp = Math.floor(Date.now() / 1000);
    const request = await signedRequest(update(), { id, timestamp });
    const res = await bridge.fetch(request);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect(onUpdate).toHaveBeenCalledOnce();
    expect(onUpdate.mock.calls[0]).toEqual([update(), { id, timestamp, request }]);
  });

  it('is lenient: unknown fields and changes pass through to the handler', async () => {
    const onUpdate = vi.fn();
    const bridge = testBridge({ onUpdate });
    const event = update() as unknown as { data: Record<string, unknown> };
    event.data.changes = ['text', 'project'];
    event.data.surprise = { later: true };
    expect((await bridge.fetch(await signedRequest(event))).status).toBe(204);
    expect(onUpdate.mock.calls[0]![0]).toEqual(event);
  });

  it("uses the destination's onUpdate, then the top-level one", async () => {
    const own = vi.fn();
    const fallback = vi.fn();
    const bridge = createBridge({
      secret: SECRET,
      onUpdate: fallback,
      destinations: {
        bugs: { name: 'Bugs', description: 'Bugs.', onEntry: noop, onUpdate: own },
        other: { name: 'Other', description: 'Other.', onEntry: noop },
      },
    });
    expect((await bridge.fetch(await signedRequest(update()))).status).toBe(204);
    expect(own).toHaveBeenCalledOnce();
    expect(fallback).not.toHaveBeenCalled();
    expect((await bridge.fetch(await signedRequest(to(update(), 'other')))).status).toBe(204);
    expect((await bridge.fetch(await signedRequest(to(update(), 'removed')))).status).toBe(204);
    expect(fallback).toHaveBeenCalledTimes(2);
  });

  it('501 when no onUpdate is configured anywhere, so yoink stops sending updates', async () => {
    const onUndo = vi.fn();
    const bridge = testBridge({ onUndo });
    const res = await bridge.fetch(await signedRequest(update()));
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({ error: 'this bridge does not support entry.update' });
    expect((await bridge.fetch(await signedRequest(to(update(), 'removed')))).status).toBe(501);
    expect(onUndo).not.toHaveBeenCalled();
  });

  it('501 for a known destination without onUpdate, 422 for an unknown one, when only some support it', async () => {
    const bridge = createBridge({
      secret: SECRET,
      destinations: {
        bugs: { name: 'Bugs', description: 'Bugs.', onEntry: noop, onUpdate: noop },
        other: { name: 'Other', description: 'Other.', onEntry: noop },
      },
    });
    expect((await bridge.fetch(await signedRequest(to(update(), 'other')))).status).toBe(501);
    const res = await bridge.fetch(await signedRequest(to(update(), 'removed')));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'unknown_destination' });
  });

  it('dedupes by webhook-id; retryable failures run again, final ones are replayed', async () => {
    let fail: BridgeError | undefined = new BridgeError(502, 'Linear answered 503');
    const onUpdate = vi.fn(() => {
      if (fail) throw fail;
    });
    const bridge = testBridge({ onUpdate });
    const id = newId();
    expect((await bridge.fetch(await signedRequest(update(), { id }))).status).toBe(502);
    fail = undefined;
    expect((await bridge.fetch(await signedRequest(update(), { id }))).status).toBe(204);
    expect((await bridge.fetch(await signedRequest(update(), { id }))).status).toBe(204);
    expect(onUpdate).toHaveBeenCalledTimes(2);

    fail = new BridgeError(422, 'no external_id');
    const other = newId();
    expect((await bridge.fetch(await signedRequest(update(), { id: other }))).status).toBe(422);
    const replay = await bridge.fetch(await signedRequest(update(), { id: other }));
    expect(replay.status).toBe(422);
    expect(await replay.json()).toEqual({ error: 'no external_id' });
    expect(onUpdate).toHaveBeenCalledTimes(3);
  });

  it('a handler may answer 501 itself for a delivery it cannot update', async () => {
    const bridge = testBridge({
      onUpdate: () => {
        throw new BridgeError(501, 'this entry went to a chat; no updates');
      },
    });
    const res = await bridge.fetch(await signedRequest(update()));
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({ error: 'this entry went to a chat; no updates' });
  });
});

describe('a destination waiting for its settings', () => {
  const waitingBridge = (extra: Partial<BridgeOptions> = {}) =>
    createBridge({
      secret: SECRET,
      ...extra,
      destinations: { other: { name: 'Other', description: 'Other.', onEntry: noop } },
      waiting: [
        { id: 'bugs', name: 'Linear · Bugs', missing: ['LINEAR_API_KEY'] },
        { id: 'leer', name: 'Leer', missing: [] },
      ],
    } as BridgeOptions);

  it('answers 503 (retried) to send, undo and update, even when no destination takes updates or undo', async () => {
    const bridge = waitingBridge();
    for (const event of [sendAuto(), undo(), update()]) {
      const res = await bridge.fetch(await signedRequest(event));
      expect(res.status, event.type).toBe(503);
      expect(await res.json()).toEqual({ error: 'destination "bugs" is waiting for LINEAR_API_KEY' });
    }
    const res = await bridge.fetch(await signedRequest(to(update(), 'leer')));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'destination "leer" is waiting for its settings' });
    // An id that is neither active nor waiting keeps its answers.
    expect((await bridge.fetch(await signedRequest(to(sendAuto(), 'gone')))).status).toBe(422);
    expect((await bridge.fetch(await signedRequest(to(update(), 'gone')))).status).toBe(501);
  });

  it('a bridge-level onUpdate or onUndo does not run for it, and nothing is stored for dedupe', async () => {
    const onUpdate = vi.fn();
    const onUndo = vi.fn();
    const store = new MemoryDedupeStore();
    const bridge = waitingBridge({ onUpdate, onUndo, dedupe: store });
    const id = newId();
    expect((await bridge.fetch(await signedRequest(update(), { id }))).status).toBe(503);
    expect((await bridge.fetch(await signedRequest(undo()))).status).toBe(503);
    expect(onUpdate).not.toHaveBeenCalled();
    expect(onUndo).not.toHaveBeenCalled();
    expect(store.size).toBe(0);
    // Once the destination is active (same store), the retry of that update goes through.
    const active = createBridge({
      secret: SECRET,
      dedupe: store,
      destinations: { bugs: { name: 'Bugs', description: 'Bugs.', onEntry: noop, onUpdate } },
    });
    expect((await active.fetch(await signedRequest(update(), { id }))).status).toBe(204);
    expect(onUpdate).toHaveBeenCalledOnce();
  });
});

describe('errors', () => {
  it('BridgeError sets the status and message', async () => {
    const bridge = testBridge({
      secret: SECRET,
      onEntry: () => {
        throw new BridgeError(422, 'no route for project yoink');
      },
    });
    const res = await bridge.fetch(await signedRequest(sendAuto()));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'no route for project yoink' });
  });

  it('BridgeError only accepts error statuses', () => {
    expect(() => new BridgeError(200, 'ok')).toThrow(RangeError);
    expect(() => new BridgeError(302, 'moved')).toThrow(RangeError);
    expect(new BridgeError(599, 'x').status).toBe(599);
  });

  it('500 on any other throw, without leaking the message', async () => {
    const bridge = testBridge({
      secret: SECRET,
      onEntry: async () => {
        throw new Error('db password is hunter2');
      },
    });
    const res = await bridge.fetch(await signedRequest(sendAuto()));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal error' });
    expect(console.error).toHaveBeenCalled();
  });
});

describe('dedupe', () => {
  it('replays the cached response for a repeated webhook-id without re-running the handler', async () => {
    let n = 0;
    const onEntry = vi.fn(() => ({ label: `#${++n}`, external_id: `ext_${n}` }));
    const bridge = testBridge({ secret: SECRET, onEntry });
    const id = newId();
    const first = await bridge.fetch(await signedRequest(sendAuto(), { id }));
    // A retry is re-signed with a newer timestamp but keeps the id.
    const retry = await bridge.fetch(
      await signedRequest(sendAuto(), { id, timestamp: Math.floor(Date.now() / 1000) + 60 }),
    );
    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(await retry.text()).toBe(await first.text());
    expect(onEntry).toHaveBeenCalledOnce();

    // A new id runs the handler again.
    const other = await bridge.fetch(await signedRequest(sendAuto()));
    expect(await other.json()).toEqual({ label: '#2', external_id: 'ext_2' });
  });

  it('replays 204 and permanent 4xx too', async () => {
    const onEntry = vi.fn(() => {
      throw new BridgeError(422, 'nope');
    });
    const bridge = testBridge({ secret: SECRET, onEntry });
    const id = newId();
    const a = await bridge.fetch(await signedRequest(sendAuto(), { id }));
    const b = await bridge.fetch(await signedRequest(sendAuto(), { id }));
    expect([a.status, b.status]).toEqual([422, 422]);
    expect(await b.json()).toEqual({ error: 'nope' });
    expect(onEntry).toHaveBeenCalledOnce();

    const quiet = vi.fn();
    const bridge2 = testBridge({ secret: SECRET, onEntry: quiet });
    const id2 = newId();
    await bridge2.fetch(await signedRequest(sendAuto(), { id: id2 }));
    expect((await bridge2.fetch(await signedRequest(sendAuto(), { id: id2 }))).status).toBe(204);
    expect(quiet).toHaveBeenCalledOnce();
  });

  it('503 with Retry-After while the first delivery is still in flight', async () => {
    const gate = deferred();
    const onEntry = vi.fn(async () => {
      await gate.promise;
      return { label: 'done' };
    });
    const bridge = testBridge({ secret: SECRET, onEntry });
    const id = newId();
    const first = bridge.fetch(await signedRequest(sendAuto(), { id }));
    await vi.waitFor(() => expect(onEntry).toHaveBeenCalledOnce());

    const duplicate = await bridge.fetch(await signedRequest(sendAuto(), { id }));
    expect(duplicate.status).toBe(503);
    expect(duplicate.headers.get('retry-after')).toBe('60');

    gate.resolve();
    expect((await first).status).toBe(200);
    const later = await bridge.fetch(await signedRequest(sendAuto(), { id }));
    expect(await later.json()).toEqual({ label: 'done' });
    expect(onEntry).toHaveBeenCalledOnce();
  });

  it('does not cache failures that yoink retries (5xx, 408, 429)', async () => {
    for (const failure of [
      () => {
        throw new Error('boom');
      },
      () => {
        throw new BridgeError(502, 'upstream down');
      },
      () => {
        throw new BridgeError(429, 'slow down');
      },
      () => {
        throw new BridgeError(408, 'timeout');
      },
    ]) {
      const onEntry = vi.fn().mockImplementationOnce(failure).mockImplementationOnce(() => ({ label: 'ok' }));
      const bridge = testBridge({ secret: SECRET, onEntry });
      const id = newId();
      const first = await bridge.fetch(await signedRequest(sendAuto(), { id }));
      expect([500, 502, 429, 408]).toContain(first.status);
      const retry = await bridge.fetch(await signedRequest(sendAuto(), { id }));
      expect(retry.status).toBe(200);
      expect(await retry.json()).toEqual({ label: 'ok' });
      expect(onEntry).toHaveBeenCalledTimes(2);
    }
  });

  it('uses a custom store', async () => {
    const calls: string[] = [];
    const store = {
      begin: vi.fn(async (id: string) => {
        calls.push(`begin ${id}`);
        return null;
      }),
      complete: vi.fn(async (id: string) => void calls.push(`complete ${id}`)),
      release: vi.fn(async (id: string) => void calls.push(`release ${id}`)),
    };
    const bridge = testBridge({ secret: SECRET, onEntry: () => ({ label: 'L' }), dedupe: store });
    await bridge.fetch(await signedRequest(sendAuto(), { id: 'msg_custom' }));
    expect(calls).toEqual(['begin msg_custom', 'complete msg_custom']);
    expect(store.complete).toHaveBeenCalledWith('msg_custom', { status: 200, body: '{"label":"L"}' });
  });

  it('still answers the handler result when the store fails to complete', async () => {
    const store = {
      begin: async () => null,
      complete: async () => {
        throw new Error('kv down');
      },
      release: async () => {},
    };
    const bridge = testBridge({ secret: SECRET, onEntry: () => ({ label: 'L' }), dedupe: store });
    const res = await bridge.fetch(await signedRequest(sendAuto()));
    expect(res.status).toBe(200);
  });

  it('500 (retryable) when the store cannot begin', async () => {
    const onEntry = vi.fn();
    const store = {
      begin: async () => {
        throw new Error('kv down');
      },
      complete: async () => {},
      release: async () => {},
    };
    const bridge = testBridge({ secret: SECRET, onEntry, dedupe: store });
    expect((await bridge.fetch(await signedRequest(sendAuto()))).status).toBe(500);
    expect(onEntry).not.toHaveBeenCalled();
  });
});

describe('manifest additions and options', () => {
  it('waiting[] and a settings URL (static or per request)', async () => {
    const bridge = createBridge({
      secret: SECRET,
      destinations: { test: { name: 'Test', onEntry: () => {} } },
      waiting: [{ id: 'bugs', name: 'Linear · Bugs', missing: ['LINEAR_API_KEY', 'LINEAR_TEAM'] }],
      settingsUrl: (request) => `https://dash.example/${new URL(request.url).hostname}`,
    });
    expect(bridge.manifest.waiting).toEqual([{ id: 'bugs', name: 'Linear · Bugs', missing: ['LINEAR_API_KEY', 'LINEAR_TEAM'] }]);
    const parsed = parseManifest(await (await bridge.fetch(await signedRequest(ping()))).text());
    expect(parsed.settingsUrl).toBe('https://dash.example/bridge.example');
    expect(parsed.waiting).toEqual(bridge.manifest.waiting);
    // Waiting destinations are not destinations yet: an entry for one is retried.
    const res = await bridge.fetch(await signedRequest(sendAuto()));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'destination "bugs" is waiting for LINEAR_API_KEY, LINEAR_TEAM' });

    const fixed = createBridge({ secret: SECRET, onEntry: () => {}, settingsUrl: 'https://dash.example/settings' });
    expect(fixed.manifest.relay.settings_url).toBe('https://dash.example/settings');
  });

  it('validates the options', () => {
    const base = { secret: SECRET, destinations: { test: { name: 'Test', onEntry: () => {} } } };
    expect(() => createBridge({ ...base, settingsUrl: 'http://dash.example' })).toThrow(/settingsUrl must be an https/);
    expect(() => createBridge({ ...base, waiting: [{ id: 'test', name: 'X', missing: [] }] })).toThrow(/already used/);
    expect(() => createBridge({ ...base, waiting: [{ id: 'b', name: 'X', missing: ['lower_case'] }] })).toThrow(/missing must be/);
    expect(() => createBridge({ ...base, waiting: [{ id: 'B', name: 'X', missing: [] }] })).toThrow(/ids must match/);
    // A bridge may consist of waiting destinations only.
    expect(() => createBridge({ secret: SECRET, destinations: {}, waiting: [{ id: 'b', name: 'B', missing: ['K'] }] })).not.toThrow();
  });

  it('received() answers the "Angekommen ✓" receipt', async () => {
    expect(await received()(sendAuto(), {} as never)).toEqual({ label: 'Angekommen ✓' });
    expect(await received('Got it')(sendAuto(), {} as never)).toEqual({ label: 'Got it' });
  });
});

describe('MemoryDedupeStore', () => {
  it('forgets completed deliveries after the TTL and pending ones after the lease', async () => {
    let now = 0;
    const store = new MemoryDedupeStore({ ttlSeconds: 100, pendingTtlSeconds: 10, now: () => now });
    expect(await store.begin('a')).toBeNull();
    expect(await store.begin('a')).toEqual({ state: 'pending' });
    now = 10_001;
    expect(await store.begin('a')).toBeNull(); // lease expired, claimed again
    await store.complete('a', { status: 204, body: null });
    now = 50_000;
    expect(await store.begin('a')).toEqual({ state: 'done', response: { status: 204, body: null } });
    now = 10_001 + 100_000;
    expect(await store.begin('a')).toBeNull();
  });

  it('defaults to a 48 h window', async () => {
    let now = 0;
    const store = new MemoryDedupeStore({ now: () => now });
    await store.begin('a');
    await store.complete('a', { status: 204, body: null });
    now = 48 * 3600 * 1000 - 1;
    expect(await store.begin('a')).toMatchObject({ state: 'done' });
    now = 48 * 3600 * 1000;
    expect(await store.begin('a')).toBeNull();
  });

  it('stays bounded, evicting expired and then the oldest ids', async () => {
    let now = 0;
    const store = new MemoryDedupeStore({ maxEntries: 3, ttlSeconds: 10, pendingTtlSeconds: 10, now: () => now });
    for (const id of ['a', 'b', 'c']) {
      await store.begin(id);
      await store.complete(id, { status: 204, body: null });
    }
    await store.begin('d');
    expect(store.size).toBe(3);
    expect(await store.begin('a')).toBeNull(); // 'a' was evicted (and is claimed anew)
    expect(store.size).toBe(3);

    now = 20_000; // everything expired
    await store.begin('e');
    expect(store.size).toBe(1);
  });

  it('release drops the record', async () => {
    const store = new MemoryDedupeStore();
    await store.begin('a');
    await store.release('a');
    expect(await store.begin('a')).toBeNull();
  });
});
