import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBridge, BridgeError, type BridgeContext } from '../src/index.ts';
import { LINEAR_ENDPOINT, linear, linearDescription, linearTitle } from '../src/presets/linear.ts';
import { SECRET, sendAuto, sendManual, signedRequest, undo, update } from './helpers.ts';

const TEAM_ID = '11111111-2222-4333-8444-555555555555';
const LABEL_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const ctx = { id: 'msg_1', timestamp: 1, request: new Request('https://bridge.example/') } as BridgeContext;

type Call = { query: string; variables: Record<string, unknown>; headers: Headers };

/** A fake Linear GraphQL endpoint. */
function fakeLinear(handler: (call: Call) => { status?: number; body: unknown }) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toBe(LINEAR_ENDPOINT);
    const { query, variables } = JSON.parse(init.body as string);
    const call = { query, variables, headers: new Headers(init.headers) };
    calls.push(call);
    const { status = 200, body } = handler(call);
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  });
  return { fetch, calls };
}

const happy = (call: Call) => {
  if (call.query.includes('teams')) return { body: { data: { teams: { nodes: [{ id: 'other', key: 'XYZ' }, { id: TEAM_ID, key: 'ABC' }] } } } };
  if (call.query.includes('issueLabels')) {
    return {
      body: {
        data: {
          issueLabels: {
            nodes: [
              { id: 'foreign', name: 'Bug', team: { id: 'other' } },
              { id: 'group', name: 'Bug', isGroup: true, team: { id: TEAM_ID } },
              { id: LABEL_ID, name: 'Bug', team: null },
              { id: 'team-label', name: 'yoink', team: { id: TEAM_ID } },
            ],
          },
        },
      },
    };
  }
  if (call.query.includes('issueCreate')) {
    return {
      body: { data: { issueCreate: { success: true, issue: { id: 'issue-uuid', identifier: 'ABC-12', url: 'https://linear.app/acme/issue/ABC-12' } } } },
    };
  }
  if (call.query.includes('issueArchive')) return { body: { data: { issueArchive: { success: true } } } };
  if (call.query.includes('commentCreate')) {
    return { body: { data: { commentCreate: { success: true, comment: { id: 'comment-uuid' } } } } };
  }
  throw new Error(`unexpected query ${call.query}`);
};

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('linear preset', () => {
  it('creates an issue (team key resolved once) and answers the receipt', async () => {
    const { fetch, calls } = fakeLinear(happy);
    const { onEntry } = linear({ apiKey: 'lin_api_key', team: 'abc', labels: ['Bug', 'yoink'], fetch });
    expect(await onEntry(sendAuto(), ctx)).toEqual({
      url: 'https://linear.app/acme/issue/ABC-12',
      label: 'ABC-12',
      external_id: 'issue-uuid',
    });
    expect(calls[0]!.headers.get('authorization')).toBe('lin_api_key'); // personal key: no "Bearer"
    expect(calls[0]!.headers.get('content-type')).toBe('application/json');
    const create = calls.find((c) => c.query.includes('issueCreate'))!;
    expect(create.query).toContain('issueCreate(input: $input) { success issue { id identifier url } }');
    expect(create.variables.input).toEqual({
      teamId: TEAM_ID,
      title: 'Absturz beim Teilen von Videos',
      description:
        'Absturz beim Teilen von Videos 🎬\nPassiert nur bei Clips über 1 Minute — „Teilen“ → weißer Screen.\n\n' +
        '- Projekt: yoink\n- Fällig: 16.10.2026\n- Anhänge (nur in yoink): 1 × Bild\n\n— via yoink',
      labelIds: [LABEL_ID, 'team-label'],
    });

    await onEntry(sendAuto(), ctx);
    expect(calls.filter((c) => c.query.includes('teams'))).toHaveLength(1);
    expect(calls.filter((c) => c.query.includes('issueLabels'))).toHaveLength(1);
  });

  it('uses a team id directly and leaves out labelIds without labels', async () => {
    const { fetch, calls } = fakeLinear(happy);
    await linear({ apiKey: 'k', team: TEAM_ID, fetch }).onEntry(sendManual(), ctx);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.variables.input).toEqual({
      teamId: TEAM_ID,
      title: 'Zahnarzt anrufen',
      description: 'Zahnarzt anrufen\n\n- Fällig: 16.10.2026 (nachmittags)\n- Link: https://example.com/praxis\n\n— via yoink',
    });
  });

  it('custom title and description', async () => {
    const { fetch, calls } = fakeLinear(happy);
    await linear({ apiKey: 'k', team: TEAM_ID, fetch, title: () => 'T', description: (e) => `D ${e.data.destination.id}` }).onEntry(
      sendAuto(),
      ctx,
    );
    expect(calls[0]!.variables.input).toMatchObject({ title: 'T', description: 'D bugs' });
  });

  it('archives the issue on undo', async () => {
    const { fetch, calls } = fakeLinear(happy);
    await linear({ apiKey: 'k', team: 'ABC', fetch }).onUndo(undo(), ctx);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.query).toContain('issueArchive(id: $id) { success }');
    expect(calls[0]!.variables).toEqual({ id: 'lin_issue_42' });
  });

  it('comments on the issue from external_id on update, and never touches the issue itself', async () => {
    const { fetch, calls } = fakeLinear(happy);
    const handlers = linear({ apiKey: 'k', team: 'ABC', fetch });
    await handlers.onUpdate(update(), ctx);
    expect(calls).toHaveLength(1); // no team lookup, no issueUpdate
    expect(calls[0]!.query).toBe(
      'mutation YoinkCommentCreate($input: CommentCreateInput!) { commentCreate(input: $input) { success } }',
    );
    expect(calls[0]!.variables).toEqual({
      input: {
        issueId: 'lin_issue_42',
        body:
          '**In yoink geändert**\n\n' +
          'Neuer Text:\n\n' +
          '> Absturz beim Teilen von Videos 🎬\n' +
          '> Passiert bei Clips über 1 Minute und bei Live-Fotos — „Teilen“ → weißer Screen.\n\n' +
          'Fällig: 16.10.2026 → 20.10.2026\n\n' +
          '— via yoink',
      },
    });
    expect(calls[0]!.headers.get('authorization')).toBe('k');

    await handlers.commentOnIssue('ABC-12', 'Hallo');
    expect(calls[1]!.variables).toEqual({ input: { issueId: 'ABC-12', body: 'Hallo' } });
    expect(Object.keys({ ...handlers })).toEqual(['onEntry', 'onUndo', 'onUpdate']);
  });

  it('updates can be turned off after the spread: the bridge then answers 501', async () => {
    const { fetch, calls } = fakeLinear(happy);
    const bridge = createBridge({
      secret: SECRET,
      destinations: { bugs: { name: 'Bugs', description: 'Bugs.', ...linear({ apiKey: 'k', team: 'ABC', fetch }), onUpdate: undefined } },
    });
    expect((await bridge.fetch(await signedRequest(update()))).status).toBe(501);
    expect(calls).toHaveLength(0);
  });

  it('update without external_id is 501 (no more updates for it); without a known change nothing is posted', async () => {
    const { fetch, calls } = fakeLinear(happy);
    const handlers = linear({ apiKey: 'k', team: 'ABC', fetch });
    for (const externalId of [null, '', '  ']) {
      const event = update();
      event.data.external_id = externalId;
      expect(await statusOf(handlers.onUpdate(event, ctx))).toEqual({
        status: 501,
        message: 'no external_id for this delivery: no Linear issue to comment on',
      });
    }
    const event = update();
    event.data.changes = ['project'];
    await handlers.onUpdate(event, ctx);
    expect(calls).toHaveLength(0);
  });

  it('update errors: key, unknown issue and success false are 422; rate limits and outages 502; no key 503', async () => {
    const run = (response: { status?: number; body: unknown }) =>
      statusOf(linear({ apiKey: 'k', team: undefined, fetch: fakeLinear(() => response).fetch }).onUpdate(update(), ctx));
    expect(await run({ status: 401, body: {} })).toEqual({ status: 422, message: 'Linear rejected the API key' });
    expect(
      await run({
        status: 400,
        body: { errors: [{ message: 'Entity not found: Issue', extensions: { type: 'invalid input', code: 'INVALID_INPUT' } }] },
      }),
    ).toEqual({ status: 422, message: 'Linear: Entity not found: Issue' });
    expect(await run({ body: { data: { commentCreate: { success: false } } } })).toEqual({
      status: 422,
      message: 'Linear did not create the comment',
    });
    expect(await run({ status: 400, body: { errors: [{ message: 'Rate limit exceeded', extensions: { code: 'RATELIMITED' } }] } })).toEqual({
      status: 502,
      message: 'Linear rate limit reached',
    });
    for (const status of [500, 503, 408, 429]) expect((await run({ status, body: {} })).status).toBe(502);

    const { fetch } = fakeLinear(happy);
    expect(await statusOf(linear({ apiKey: undefined, team: 'ABC', fetch }).onUpdate(update(), ctx))).toEqual({
      status: 503,
      message: 'the Linear API key is not set',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  const statusOf = async (pending: unknown) => {
    const error = await Promise.resolve(pending).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BridgeError);
    return { status: (error as BridgeError).status, message: (error as BridgeError).message };
  };

  it('maps errors: key rejected and GraphQL errors are permanent (422), outages retryable (502)', async () => {
    const run = (response: { status?: number; body: unknown }) =>
      statusOf(linear({ apiKey: 'k', team: TEAM_ID, fetch: fakeLinear(() => response).fetch }).onEntry(sendAuto(), ctx));
    expect(await run({ status: 401, body: {} })).toEqual({ status: 422, message: 'Linear rejected the API key' });
    expect(await run({ status: 403, body: {} })).toEqual({ status: 422, message: 'Linear rejected the API key' });
    expect(
      await run({ status: 400, body: { errors: [{ message: 'Authentication required', extensions: { code: 'AUTHENTICATION_ERROR' } }] } }),
    ).toEqual({ status: 422, message: 'Linear rejected the API key' });
    expect(await run({ status: 400, body: { errors: [{ message: 'Argument Validation Error', extensions: { code: 'INVALID_INPUT' } }] } })).toEqual({
      status: 422,
      message: 'Linear: Argument Validation Error',
    });
    expect(await run({ status: 400, body: { errors: [{ message: 'Rate limit exceeded', extensions: { code: 'RATELIMITED' } }] } })).toEqual({
      status: 502,
      message: 'Linear rate limit reached',
    });
    // As observed for a missing or invalid key: 401 with an "authentication error".
    expect(
      await run({
        status: 401,
        body: { errors: [{ message: 'Authentication required, not authenticated', extensions: { type: 'authentication error', code: 'AUTHENTICATION_ERROR' } }] },
      }),
    ).toEqual({ status: 422, message: 'Linear rejected the API key' });
    expect(await run({ body: { data: { issueCreate: { success: false, issue: null } } } })).toEqual({
      status: 422,
      message: 'Linear did not create the issue',
    });
    for (const status of [500, 502, 503, 408, 429]) expect((await run({ status, body: {} })).status).toBe(502);
    expect(await run({ status: 200, body: 'not json' })).toEqual({ status: 502, message: 'Linear answered 200 without JSON' });

    const offline = linear({
      apiKey: 'k',
      team: TEAM_ID,
      fetch: async () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      },
    });
    expect(await statusOf(offline.onEntry(sendAuto(), ctx))).toEqual({ status: 502, message: 'Linear unreachable' });
    expect((await statusOf(offline.onUndo(undo(), ctx))).status).toBe(502);
  });

  it('unknown team or label is permanent; the failure is not cached', async () => {
    let teams = [{ id: 'other', key: 'XYZ' }];
    const { fetch, calls } = fakeLinear((call) =>
      call.query.includes('teams') ? { body: { data: { teams: { nodes: teams } } } } : happy(call),
    );
    const handlers = linear({ apiKey: 'k', team: 'ABC', fetch });
    expect(await statusOf(handlers.onEntry(sendAuto(), ctx))).toEqual({ status: 422, message: 'Linear team "ABC" not found' });
    teams = [{ id: TEAM_ID, key: 'ABC' }];
    await expect(Promise.resolve(handlers.onEntry(sendAuto(), ctx))).resolves.toMatchObject({ label: 'ABC-12' });
    expect(calls.filter((c) => c.query.includes('teams'))).toHaveLength(2);

    const labels = linear({ apiKey: 'k', team: TEAM_ID, labels: ['Nope'], fetch });
    expect(await statusOf(labels.onEntry(sendAuto(), ctx))).toEqual({
      status: 422,
      message: 'Linear label "Nope" not found in this team or workspace',
    });
  });

  it('missing key or team fails at send time with 503, so a destination can wait for its secrets', async () => {
    const { fetch } = fakeLinear(happy);
    expect(await statusOf(linear({ apiKey: undefined, team: 'ABC', fetch }).onEntry(sendAuto(), ctx))).toEqual({
      status: 503,
      message: 'the Linear API key is not set',
    });
    expect(await statusOf(linear({ apiKey: 'k', team: '', fetch }).onEntry(sendAuto(), ctx))).toEqual({
      status: 503,
      message: 'the Linear team is not set',
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(() => linear({ apiKey: 'k', team: 'ABC', labels: [''] })).toThrow(/labels must be a list/);
  });

  it('default title falls back to the first line, cut to 255 characters', () => {
    const event = sendManual();
    event.data.entry.text = '\n  First line  \nsecond';
    expect(linearTitle(event)).toBe('First line');
    event.data.entry.text = 'x'.repeat(300);
    expect(linearTitle(event)).toHaveLength(255);
    event.data.entry.title = '  Titel ';
    expect(linearTitle(event)).toBe('Titel');
    event.data.entry.project = 'Haus';
    event.data.entry.text = '';
    event.data.entry.due = null;
    event.data.entry.source_url = null;
    expect(linearDescription(event)).toBe('- Projekt: Haus\n\n— via yoink');
  });
});
