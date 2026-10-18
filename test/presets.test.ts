import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BridgeError } from '../src/index.ts';
import { discord, formatDiscord } from '../src/presets/discord.ts';
import { formatDue, issueMarkdown, issueTitle, updateComment } from '../src/presets/shared.ts';
import { escapeSlack, formatSlack, slack } from '../src/presets/slack.ts';
import { bugsBridge, sendAuto, sendManual, signedRequest, update } from './helpers.ts';

const SLACK_URL = 'https://hooks.slack.com/services/T000/B000/XXXX';
const DISCORD_URL = 'https://discord.com/api/webhooks/1/abc';

function fakeFetch(status = 200, body = 'ok') {
  return vi.fn(async (_url: string, _init: RequestInit) => new Response(status === 204 ? null : body, { status }));
}

function sentJson(fetchMock: ReturnType<typeof fakeFetch>): unknown {
  const init = fetchMock.mock.calls[0]![1];
  return JSON.parse(init.body as string);
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('slack preset', () => {
  it('posts { text } as JSON to the webhook URL', async () => {
    const fetch = fakeFetch();
    await slack({ webhookUrl: SLACK_URL, fetch })(sendAuto());
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(SLACK_URL);
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
    expect(sentJson(fetch)).toEqual({ text: formatSlack(sendAuto()) });
  });

  it('default text: bold first line, rest, project and due date', () => {
    expect(formatSlack(sendAuto())).toBe(
      '*Absturz beim Teilen von Videos 🎬*\n' +
        'Passiert nur bei Clips über 1 Minute — „Teilen“ → weißer Screen.\n' +
        'Projekt: yoink · Fällig: 16.10.2026',
    );
    expect(formatSlack(sendManual())).toBe(
      '*Zahnarzt anrufen*\nFällig: 16.10.2026 (nachmittags) · https://example.com/praxis',
    );
  });

  it('escapes Slack control characters so entries cannot ping @channel', () => {
    const event = sendManual();
    event.data.entry.text = 'Tell <!channel> about A&B <https://evil|click>';
    expect(formatSlack(event)).toContain('Tell &lt;!channel&gt; about A&amp;B &lt;https://evil|click&gt;');
    expect(escapeSlack('<&>')).toBe('&lt;&amp;&gt;');
  });

  it('uses a custom format', async () => {
    const fetch = fakeFetch();
    await slack({ webhookUrl: SLACK_URL, fetch, format: (e) => `new: ${e.data.entry.id}` })(sendAuto());
    expect(sentJson(fetch)).toEqual({ text: 'new: 3c9e8f20-6b1a-4d2e-8f3a-5b6c7d8e9f01' });
  });

  it('maps a permanent upstream 4xx to BridgeError(422), without the URL', async () => {
    const failing = slack({ webhookUrl: SLACK_URL, fetch: fakeFetch(404, 'no_service') });
    const error = await failing(sendAuto()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BridgeError);
    expect((error as BridgeError).status).toBe(422);
    expect((error as BridgeError).message).toBe('Slack webhook answered 404: no_service');
  });

  it('throws BridgeError(502) on a network error, without the URL', async () => {
    const offline = slack({
      webhookUrl: SLACK_URL,
      fetch: async () => {
        throw new TypeError(`fetch failed for ${SLACK_URL}`);
      },
    });
    const error2 = await offline(sendAuto()).catch((e: unknown) => e);
    expect((error2 as BridgeError).status).toBe(502);
    expect((error2 as BridgeError).message).not.toContain('hooks.slack.com');
  });

  it('rejects an invalid or non-https webhook URL up front', () => {
    expect(() => slack({ webhookUrl: 'not a url' })).toThrow(/webhookUrl is not a valid URL/);
    expect(() => slack({ webhookUrl: 'http://hooks.slack.com/x' })).toThrow(/https/);
    expect(() => discord({ webhookUrl: 'http://discord.com/x' })).toThrow(/https/);
  });

  it('a missing URL fails only at send time, with 503 (retried), so a destination can wait for its secret', async () => {
    for (const handler of [slack({ webhookUrl: undefined }), slack({ webhookUrl: '  ' }), discord({ webhookUrl: undefined })]) {
      const error = await handler(sendAuto()).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BridgeError);
      expect((error as BridgeError).status).toBe(503);
      expect((error as BridgeError).message).toMatch(/webhook URL is not set/);
    }
  });

  it('works as onEntry: 204 on success, 502 (retried) when Slack is down, 422 (final) when revoked', async () => {
    const ok = bugsBridge(slack({ webhookUrl: SLACK_URL, fetch: fakeFetch() }));
    expect((await ok.fetch(await signedRequest(sendAuto()))).status).toBe(204);

    const down = bugsBridge(slack({ webhookUrl: SLACK_URL, fetch: fakeFetch(500) }));
    expect((await down.fetch(await signedRequest(sendAuto()))).status).toBe(502);

    const revoked = bugsBridge(slack({ webhookUrl: SLACK_URL, fetch: fakeFetch(410, 'channel_is_archived') }));
    const res = await revoked.fetch(await signedRequest(sendAuto()));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'Slack webhook answered 410: channel_is_archived' });
  });

  it('takes no updates: an edit after sending answers 501 and posts nothing', async () => {
    const fetch = fakeFetch();
    const bridge = bugsBridge(slack({ webhookUrl: SLACK_URL, fetch }));
    expect((await bridge.fetch(await signedRequest(update()))).status).toBe(501);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('upstream status mapping (both presets)', () => {
  const presets = [
    ['slack', (fetch: ReturnType<typeof fakeFetch>) => slack({ webhookUrl: SLACK_URL, fetch })],
    ['discord', (fetch: ReturnType<typeof fakeFetch>) => discord({ webhookUrl: DISCORD_URL, fetch })],
  ] as const;
  const cases: [number, number][] = [
    [400, 422],
    [401, 422],
    [403, 422],
    [404, 422],
    [410, 422],
    [413, 422],
    [408, 502],
    [429, 502],
    [500, 502],
    [502, 502],
    [503, 502],
  ];

  for (const [name, make] of presets) {
    it.each(cases)(`${name}: upstream %i → BridgeError(%i)`, async (upstream, expected) => {
      const error = await make(fakeFetch(upstream, 'nope'))(sendAuto()).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BridgeError);
      expect((error as BridgeError).status).toBe(expected);
    });

    it(`${name}: network errors and timeouts → BridgeError(502)`, async () => {
      for (const failure of [
        new TypeError('fetch failed'),
        new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
      ]) {
        const fetch = vi.fn(async (_url: string, _init: RequestInit): Promise<Response> => {
          throw failure;
        });
        const error = await make(fetch as never)(sendAuto()).catch((e: unknown) => e);
        expect((error as BridgeError).status).toBe(502);
        expect((error as BridgeError).cause).toBe(failure);
        expect(fetch.mock.calls[0]![1].signal).toBeInstanceOf(AbortSignal);
      }
    });

    it(`${name}: any 2xx is success`, async () => {
      for (const status of [200, 201, 204]) {
        await expect(make(fakeFetch(status, ''))(sendAuto())).resolves.toBeUndefined();
      }
    });
  }

  it('formats unknown enum values instead of failing', () => {
    const event = sendManual();
    event.data.entry.due = { date: '2026-10-16', at: null, day_part: 'dawn' };
    expect(formatSlack(event)).toContain('Fällig: 16.10.2026 (dawn)');
    event.data.entry.due = { date: '16 Oct', at: null, day_part: null };
    expect(formatSlack(event)).toContain('Fällig: 16 Oct ·');
  });
});

describe('discord preset', () => {
  it('posts { content } with mentions disabled', async () => {
    const fetch = fakeFetch(204, '');
    await discord({ webhookUrl: DISCORD_URL, fetch })(sendAuto());
    const [url] = fetch.mock.calls[0]!;
    expect(url).toBe(DISCORD_URL);
    expect(sentJson(fetch)).toEqual({
      content:
        '**Absturz beim Teilen von Videos 🎬**\n' +
        'Passiert nur bei Clips über 1 Minute — „Teilen“ → weißer Screen.\n' +
        'Projekt: yoink · Fällig: 16.10.2026',
      allowed_mentions: { parse: [] },
    });
  });

  it('bolds a title that differs from the text', () => {
    const event = sendManual();
    event.data.entry.title = 'Praxis';
    event.data.entry.due = { date: '2026-10-16', at: '2026-10-16T13:00:00Z', day_part: null };
    expect(formatDiscord(event)).toBe('**Praxis**\nZahnarzt anrufen\nFällig: 16.10.2026 13:00 UTC · https://example.com/praxis');
  });

  it('cuts content to 2000 characters without splitting an emoji', async () => {
    const fetch = fakeFetch(204, '');
    await discord({ webhookUrl: DISCORD_URL, fetch, format: () => 'a'.repeat(1998) + '🎬🎬' })(sendAuto());
    const { content } = sentJson(fetch) as { content: string };
    expect(content.length).toBeLessThanOrEqual(2000);
    expect(content).toBe('a'.repeat(1998) + '…');
  });

  it('throws BridgeError(502) when rate-limited and 422 for a deleted webhook', async () => {
    const limited = await discord({ webhookUrl: DISCORD_URL, fetch: fakeFetch(429, '{"retry_after":1}') })(
      sendAuto(),
    ).catch((e: unknown) => e);
    expect(limited).toBeInstanceOf(BridgeError);
    expect((limited as BridgeError).status).toBe(502);

    const deleted = await discord({ webhookUrl: DISCORD_URL, fetch: fakeFetch(404, '{"message":"Unknown Webhook"}') })(
      sendAuto(),
    ).catch((e: unknown) => e);
    expect((deleted as BridgeError).status).toBe(422);
  });
});

describe('updateComment', () => {
  const HEAD = '**In yoink geändert**';
  const FOOT = '— via yoink';
  const event = (changes: string[], edit: (e: ReturnType<typeof update>) => void = () => {}) => {
    const e = update();
    e.data.changes = changes;
    edit(e);
    return e;
  };

  it('text and due (the vector): the whole new text quoted, the due date old → new', () => {
    expect(updateComment(update())).toBe(
      `${HEAD}\n\n` +
        'Neuer Text:\n\n' +
        '> Absturz beim Teilen von Videos 🎬\n' +
        '> Passiert bei Clips über 1 Minute und bei Live-Fotos — „Teilen“ → weißer Screen.\n\n' +
        'Fällig: 16.10.2026 → 20.10.2026\n\n' +
        FOOT,
    );
  });

  it('title only: old → new on one line, — for a missing title', () => {
    const renamed = event(['title'], (e) => {
      e.data.previous.title = 'Absturz';
      e.data.entry.title = 'Absturz beim Teilen\nvon Videos ';
    });
    expect(updateComment(renamed)).toBe(`${HEAD}\n\nTitel: Absturz → Absturz beim Teilen von Videos\n\n${FOOT}`);
    const added = event(['title'], (e) => {
      e.data.previous.title = null;
    });
    expect(updateComment(added)).toBe(`${HEAD}\n\nTitel: — → Absturz beim Teilen von Videos\n\n${FOOT}`);
    const removed = event(['title'], (e) => {
      e.data.entry.title = '  ';
    });
    expect(updateComment(removed)).toBe(`${HEAD}\n\nTitel: Absturz beim Teilen von Videos → —\n\n${FOOT}`);
  });

  it('due: formatted like the issue, — when it was added or removed', () => {
    const removed = event(['due'], (e) => {
      e.data.entry.due = null;
    });
    expect(updateComment(removed)).toBe(`${HEAD}\n\nFällig: 16.10.2026 → —\n\n${FOOT}`);
    const added = event(['due'], (e) => {
      e.data.previous.due = null;
      e.data.entry.due = { date: '2026-10-20', at: '2026-10-20T16:30:00Z', day_part: null };
    });
    expect(updateComment(added)).toBe(`${HEAD}\n\nFällig: — → 20.10.2026 16:30 UTC\n\n${FOOT}`);
    const evening = event(['due'], (e) => {
      e.data.entry.due = { date: '2026-10-16', at: '2026-10-16T17:00:00Z', day_part: 'evening' };
    });
    expect(updateComment(evening)).toBe(`${HEAD}\n\nFällig: 16.10.2026 → 16.10.2026 (abends)\n\n${FOOT}`);
  });

  it('all three, always in the order title, text, due; empty lines stay inside the quote', () => {
    const all = event(['due', 'title', 'text'], (e) => {
      e.data.previous.title = null;
      e.data.entry.title = 'Neu';
      e.data.entry.text = '  Erste Zeile\n\n- Punkt\r\nletzte  \n';
    });
    expect(updateComment(all)).toBe(
      `${HEAD}\n\nTitel: — → Neu\n\nNeuer Text:\n\n> Erste Zeile\n>\n> - Punkt\n> letzte\n\nFällig: 16.10.2026 → 20.10.2026\n\n${FOOT}`,
    );
  });

  it('a text that became empty reads —', () => {
    expect(updateComment(event(['text'], (e) => void (e.data.entry.text = ' \n ')))).toBe(`${HEAD}\n\nNeuer Text: —\n\n${FOOT}`);
  });

  it('null when no known part changed (unknown changes are ignored, not shown)', () => {
    expect(updateComment(event([]))).toBeNull();
    expect(updateComment(event(['project', 'color']))).toBeNull();
    expect(updateComment(event(['project', 'due']))).toBe(`${HEAD}\n\nFällig: 16.10.2026 → 20.10.2026\n\n${FOOT}`);
    expect(updateComment(event([], (e) => void ((e.data as { changes: unknown }).changes = 'text')))).toBeNull();
  });
});

describe('German in the tracker', () => {
  it('formatDue: German date, day parts in German, time in UTC; unknown values as they come', () => {
    const due = (day_part: string | null, at: string | null = null) => ({ date: '2026-10-20', at, day_part });
    const parts = ['morning', 'forenoon', 'noon', 'afternoon', 'evening', 'night'].map((p) => formatDue(due(p)));
    expect(parts).toEqual([
      '20.10.2026 (morgens)',
      '20.10.2026 (vormittags)',
      '20.10.2026 (mittags)',
      '20.10.2026 (nachmittags)',
      '20.10.2026 (abends)',
      '20.10.2026 (nachts)',
    ]);
    expect(formatDue(due(null))).toBe('20.10.2026');
    expect(formatDue(due(null, '2026-10-20T07:05:00Z'))).toBe('20.10.2026 07:05 UTC');
    expect(formatDue(due('dawn'))).toBe('20.10.2026 (dawn)');
    expect(formatDue(due('constructor'))).toBe('20.10.2026 (constructor)');
    expect(formatDue({ date: 'bald', at: null, day_part: null })).toBe('bald');
  });

  it('formatDue with a time: date and time both from `at` in UTC, not the local `date`', () => {
    // 00:30 on the 16th in Berlin is 22:30 UTC on the 15th.
    expect(formatDue({ date: '2026-10-16', at: '2026-10-15T22:30:00Z', day_part: null })).toBe('15.10.2026 22:30 UTC');
    expect(formatDue({ date: '2026-10-16', at: '2026-10-16T00:30:00+02:00', day_part: null })).toBe('15.10.2026 22:30 UTC');
    expect(formatDue({ date: '2026-12-31', at: '2027-01-01T03:00:00Z', day_part: null })).toBe('01.01.2027 03:00 UTC');
    expect(formatDue({ date: '2026-10-16', at: '2026-10-16T09:15:00.500Z', day_part: null })).toBe('16.10.2026 09:15 UTC');
    // A day part is local: it stays with `date`. An unreadable `at` is left out.
    expect(formatDue({ date: '2026-10-16', at: '2026-10-15T22:30:00Z', day_part: 'night' })).toBe('16.10.2026 (nachts)');
    expect(formatDue({ date: '2026-10-16', at: 'soon', day_part: null })).toBe('16.10.2026');
  });

  it('the update comment uses the same UTC date for a due time', () => {
    const event = update();
    event.data.changes = ['due'];
    event.data.previous.due = { date: '2026-10-16', at: '2026-10-15T22:30:00Z', day_part: null };
    event.data.entry.due = { date: '2026-10-17', at: '2026-10-17T08:00:00Z', day_part: null };
    expect(updateComment(event)).toBe(
      '**In yoink geändert**\n\nFällig: 15.10.2026 22:30 UTC → 17.10.2026 08:00 UTC\n\n— via yoink',
    );
  });

  it('issue text: German labels and attachment kinds; the fallback title is German', () => {
    const event = sendAuto();
    event.data.entry.source_url = 'https://example.com/x';
    event.data.entry.attachments = [
      { kind: 'image', name: 'a' },
      { kind: 'video', name: 'b' },
      { kind: 'image', name: 'c' },
      { kind: 'file', name: 'd' },
      { kind: 'audio', name: 'e' },
      { kind: 'hologram', name: 'f' },
    ];
    expect(issueMarkdown(event).split('\n\n').at(-2)).toBe(
      '- Projekt: yoink\n- Fällig: 16.10.2026\n- Link: https://example.com/x\n' +
        '- Anhänge (nur in yoink): 2 × Bild, 1 × Video, 1 × Datei, 1 × Audio, 1 × hologram',
    );
    event.data.entry.title = null;
    event.data.entry.text = ' \n ';
    expect(issueTitle(event, 255)).toBe('Eintrag aus yoink');
  });
});
