import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BridgeError, SDK_VERSION, type BridgeContext } from '../src/index.ts';
import { github, githubBody, githubTitle, parseGitHubRepo } from '../src/presets/github.ts';
import { sendAuto, sendManual, undo, update } from './helpers.ts';

const ctx = { id: 'msg_1', timestamp: 1, request: new Request('https://bridge.example/') } as BridgeContext;

type Call = { url: string; method: string; body: Record<string, unknown>; headers: Headers };
type Reply = { status?: number; body?: unknown; headers?: Record<string, string> };

/** A fake GitHub REST API. */
function fakeGitHub(handler: (call: Call) => Reply) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    const call = { url, method: init.method ?? 'GET', body: JSON.parse(init.body as string), headers: new Headers(init.headers) };
    calls.push(call);
    const { status = 200, body, headers } = handler(call);
    return new Response(body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
  });
  return { fetch, calls };
}

const created = () => ({
  status: 201,
  body: { id: 99, number: 12, html_url: 'https://github.com/octo/app/issues/12', state: 'open' },
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function bridgeError(promise: Promise<unknown>): Promise<BridgeError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(BridgeError);
  return error as BridgeError;
}

describe('github preset', () => {
  it('creates an issue with the headers GitHub requires and answers the receipt', async () => {
    const { fetch, calls } = fakeGitHub(created);
    const { onEntry } = github({ token: ' github_pat_x ', repo: 'octo/app', labels: ['yoink', ' bug ', 'yoink'], fetch });
    expect(await onEntry(sendAuto(), ctx)).toEqual({
      url: 'https://github.com/octo/app/issues/12',
      label: '#12',
      external_id: 'octo/app#12',
    });
    const [call] = calls;
    expect(call!.url).toBe('https://api.github.com/repos/octo/app/issues');
    expect(call!.method).toBe('POST');
    expect(call!.headers.get('authorization')).toBe('Bearer github_pat_x');
    expect(call!.headers.get('accept')).toBe('application/vnd.github+json');
    expect(call!.headers.get('x-github-api-version')).toBe('2022-11-28');
    expect(call!.headers.get('user-agent')).toBe(`yoink-bridge/${SDK_VERSION}`);
    expect(call!.headers.get('content-type')).toBe('application/json');
    expect(call!.body).toEqual({
      title: 'Absturz beim Teilen von Videos',
      body:
        'Absturz beim Teilen von Videos 🎬\nPassiert nur bei Clips über 1 Minute — „Teilen“ → weißer Screen.\n\n' +
        '- Projekt: yoink\n- Fällig: 16.10.2026\n- Anhänge (nur in yoink): 1 × Bild\n\n— via yoink',
      labels: ['yoink', 'bug'],
    });
  });

  it('without labels sends none; the body lists due time and link', async () => {
    const { fetch, calls } = fakeGitHub(created);
    await github({ token: 't', repo: 'octo/app', fetch }).onEntry(sendManual(), ctx);
    expect(calls[0]!.body).toEqual({
      title: 'Zahnarzt anrufen',
      body: 'Zahnarzt anrufen\n\n- Fällig: 16.10.2026 (nachmittags)\n- Link: https://example.com/praxis\n\n— via yoink',
    });
  });

  it('custom title and body; createIssue with overrides for own routing', async () => {
    const { fetch, calls } = fakeGitHub(created);
    const handlers = github({ token: 't', repo: 'octo/app', labels: ['yoink'], fetch, title: () => 'T', body: (e) => `B ${e.data.destination.id}` });
    await handlers.onEntry(sendAuto(), ctx);
    expect(calls[0]!.body).toEqual({ title: 'T', body: 'B bugs', labels: ['yoink'] });
    await handlers.createIssue(sendAuto(), { title: ` ${'x'.repeat(300)} `, body: 'Own', labels: [] });
    expect(calls[1]!.body).toEqual({ title: 'x'.repeat(256), body: 'Own' });
    expect(Object.keys({ ...handlers })).toEqual(['onEntry', 'onUndo', 'onUpdate']);
  });

  it('closes the issue as not planned on undo, in the repository named in external_id', async () => {
    const { fetch, calls } = fakeGitHub(() => ({ status: 200, body: { number: 42, state: 'closed' } }));
    // GITHUB_REPO changed since the entry was sent: undo still targets the old repository.
    const handlers = github({ token: 't', repo: 'octo/new-home', fetch });
    const event = undo();
    event.data.external_id = 'octo/app#42';
    await handlers.onUndo(event, ctx);
    expect(calls[0]!.url).toBe('https://api.github.com/repos/octo/app/issues/42');
    expect(calls[0]!.method).toBe('PATCH');
    expect(calls[0]!.body).toEqual({ state: 'closed', state_reason: 'not_planned' });

    // A bare number (older receipts) means the current GITHUB_REPO.
    event.data.external_id = ' 7 ';
    await handlers.onUndo(event, ctx);
    expect(calls[1]!.url).toBe('https://api.github.com/repos/octo/new-home/issues/7');
    await handlers.closeIssue(8);
    expect(calls[2]!.url).toBe('https://api.github.com/repos/octo/new-home/issues/8');

    for (const bad of [undo().data.external_id, 'octo/app#0', 'octo/app#', 'not a repo#3', 'octo/app/x#3', '#3']) {
      event.data.external_id = bad;
      const error = await bridgeError(handlers.onUndo(event, ctx) as Promise<void>);
      expect(error.status, bad).toBe(422);
      expect(error.message).toMatch(/^not a GitHub issue/);
    }
    expect(calls).toHaveLength(3);
  });

  it('created and withdrawn: the external_id round-trips', async () => {
    const { fetch, calls } = fakeGitHub((call) => (call.method === 'POST' ? created() : { status: 200, body: {} }));
    const handlers = github({ token: 't', repo: 'https://github.com/Octo/App.git', fetch });
    const receipt = await handlers.createIssue(sendAuto());
    expect(receipt.external_id).toBe('Octo/App#12');
    expect(receipt.external_id!.length).toBeLessThanOrEqual(256);
    const event = undo();
    event.data.external_id = receipt.external_id!;
    await handlers.onUndo(event, ctx);
    expect(calls[1]!.url).toBe('https://api.github.com/repos/Octo/App/issues/12');
  });

  it('comments on the issue on update, in the repository named in external_id, with the same headers', async () => {
    const { fetch, calls } = fakeGitHub(() => ({ status: 201, body: { id: 5, html_url: 'https://github.com/octo/app/issues/42#issuecomment-5' } }));
    const handlers = github({ token: 't', repo: 'octo/new-home', fetch });
    const event = update();
    event.data.external_id = 'octo/app#42';
    await handlers.onUpdate(event, ctx);
    const [call] = calls;
    expect(call!.url).toBe('https://api.github.com/repos/octo/app/issues/42/comments');
    expect(call!.method).toBe('POST');
    expect(call!.headers.get('authorization')).toBe('Bearer t');
    expect(call!.headers.get('accept')).toBe('application/vnd.github+json');
    expect(call!.headers.get('x-github-api-version')).toBe('2022-11-28');
    expect(call!.headers.get('user-agent')).toBe(`yoink-bridge/${SDK_VERSION}`);
    expect(call!.body).toEqual({
      body:
        '**In yoink geändert**\n\n' +
        'Neuer Text:\n\n' +
        '> Absturz beim Teilen von Videos 🎬\n' +
        '> Passiert bei Clips über 1 Minute und bei Live-Fotos — „Teilen“ → weißer Screen.\n\n' +
        'Fällig: 16.10.2026 → 20.10.2026\n\n' +
        '— via yoink',
    });

    // A bare number means the current GITHUB_REPO, as for undo.
    event.data.external_id = '7';
    await handlers.onUpdate(event, ctx);
    expect(calls[1]!.url).toBe('https://api.github.com/repos/octo/new-home/issues/7/comments');
    await handlers.commentOnIssue(8, 'Hallo');
    expect(calls[2]!.url).toBe('https://api.github.com/repos/octo/new-home/issues/8/comments');
    expect(calls[2]!.body).toEqual({ body: 'Hallo' });
  });

  it('update without external_id is 501 (no more updates for it), a malformed one 422; no known change posts nothing', async () => {
    const { fetch, calls } = fakeGitHub(created);
    const handlers = github({ token: 't', repo: 'octo/app', fetch });
    const event = update();
    for (const externalId of [null, '', ' ']) {
      event.data.external_id = externalId;
      const error = await bridgeError(handlers.onUpdate(event, ctx) as Promise<void>);
      expect(`${error.status} ${error.message}`).toBe('501 no external_id for this delivery: no GitHub issue to comment on');
    }
    event.data.external_id = 'lin_issue_42';
    const error = await bridgeError(handlers.onUpdate(event, ctx) as Promise<void>);
    expect(`${error.status} ${error.message}`).toBe('422 not a GitHub issue: "lin_issue_42"');
    event.data.external_id = 'octo/app#3';
    event.data.changes = ['project'];
    await handlers.onUpdate(event, ctx);
    expect(calls).toHaveLength(0);
  });

  it('update errors name the issue; rate limits and outages are retryable; a missing token is 503', async () => {
    const status = async (reply: Reply) => {
      const { fetch } = fakeGitHub(() => reply);
      const event = update();
      event.data.external_id = 'octo/app#42';
      const error = await bridgeError(github({ token: 't', repo: undefined, fetch }).onUpdate(event, ctx) as Promise<unknown>);
      return `${error.status} ${error.message}`;
    };
    expect(await status({ status: 404, body: { message: 'Not Found' } })).toBe(
      '422 GitHub: issue octo/app#42 not found, or the token has no access to octo/app',
    );
    expect(await status({ status: 410, body: { message: 'Gone' } })).toBe(
      '422 GitHub: issue octo/app#42 was deleted, or issues are turned off in octo/app',
    );
    expect(await status({ status: 422, body: { message: 'Validation Failed', errors: [{ field: 'body', code: 'custom' }] } })).toBe(
      '422 GitHub rejected the request for octo/app#42: Validation Failed: body custom',
    );
    expect(await status({ status: 401, body: { message: 'Bad credentials' } })).toBe(
      '422 GitHub rejected the token (expired or revoked?): set a new GITHUB_TOKEN',
    );
    expect(await status({ status: 429, body: {} })).toBe('502 GitHub rate limit reached');
    expect(await status({ status: 502 })).toBe('502 GitHub answered 502');

    const { fetch } = fakeGitHub(created);
    const event = update();
    event.data.external_id = 'octo/app#42';
    const error = await bridgeError(github({ token: undefined, repo: 'octo/app', fetch }).onUpdate(event, ctx) as Promise<unknown>);
    expect(`${error.status} ${error.message}`).toBe('503 the GitHub token is not set');
    // A bare number needs GITHUB_REPO.
    event.data.external_id = '42';
    const noRepo = await bridgeError(github({ token: 't', repo: undefined, fetch }).onUpdate(event, ctx) as Promise<unknown>);
    expect(noRepo.status).toBe(503);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('maps errors: rate limits and outages are retryable (502), the rest is permanent (422)', async () => {
    const status = async (reply: Reply) => {
      const { fetch } = fakeGitHub(() => reply);
      const error = await bridgeError(github({ token: 't', repo: 'octo/app', fetch }).onEntry(sendAuto(), ctx) as Promise<unknown>);
      return `${error.status} ${error.message}`;
    };
    expect(await status({ status: 401, body: { message: 'Bad credentials' } })).toBe(
      '422 GitHub rejected the token (expired or revoked?): set a new GITHUB_TOKEN',
    );
    expect(await status({ status: 403, body: { message: 'Resource not accessible by personal access token' } })).toBe(
      '422 GitHub refused: the token needs "Issues: Read and write" on octo/app (Resource not accessible by personal access token)',
    );
    expect(await status({ status: 403, body: { message: 'API rate limit exceeded' }, headers: { 'x-ratelimit-remaining': '0' } })).toBe(
      '502 GitHub rate limit reached',
    );
    expect(await status({ status: 403, body: { message: 'You have exceeded a secondary rate limit.' }, headers: { 'retry-after': '60' } })).toBe(
      '502 GitHub rate limit reached (retry after 60 s)',
    );
    expect(await status({ status: 429, body: {} })).toBe('502 GitHub rate limit reached');
    expect(await status({ status: 404, body: { message: 'Not Found' } })).toBe('422 GitHub: octo/app not found, or the token has no access to it');
    expect(await status({ status: 410, body: { message: 'Issues are disabled for this repo' } })).toBe('422 GitHub: issues are turned off in octo/app');
    expect(
      await status({ status: 422, body: { message: 'Validation Failed', errors: [{ resource: 'Issue', field: 'title', code: 'missing_field' }] } }),
    ).toBe('422 GitHub rejected the issue: Validation Failed: title missing_field');
    expect(await status({ status: 500, body: 'oops' })).toBe('502 GitHub answered 500');
    expect(await status({ status: 503 })).toBe('502 GitHub answered 503');
    expect(await status({ status: 408 })).toBe('502 GitHub answered 408');
    expect(await status({ status: 418, body: { message: 'teapot' } })).toBe('422 GitHub answered 418: teapot');
    expect(await status({ status: 201, body: 'not json' })).toBe('502 GitHub answered 201 without JSON');
    expect(await status({ status: 201, body: { id: 1 } })).toBe('502 GitHub answered without an issue');
  });

  it('network errors and timeouts are retryable', async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError('network down');
    });
    const error = await bridgeError(github({ token: 't', repo: 'octo/app', fetch }).onEntry(sendAuto(), ctx) as Promise<unknown>);
    expect(error.status).toBe(502);
    expect(error.message).toBe('GitHub unreachable');
  });

  it('a missing token or repo fails at send time with 503, so a destination can wait; a bad repo is 422', async () => {
    const { fetch, calls } = fakeGitHub(created);
    for (const options of [{ token: undefined, repo: 'octo/app' }, { token: ' ', repo: 'octo/app' }, { token: 't', repo: undefined }, { token: 't', repo: '' }]) {
      const error = await bridgeError(github({ ...options, fetch }).onEntry(sendAuto(), ctx) as Promise<unknown>);
      expect(error.status, JSON.stringify(options)).toBe(503);
    }
    const bad = await bridgeError(github({ token: 't', repo: 'not a repo', fetch }).onEntry(sendAuto(), ctx) as Promise<unknown>);
    expect(bad.status).toBe(422);
    expect(bad.message).toBe('GITHUB_REPO must be owner/name, e.g. octocat/hello-world');
    expect(calls).toHaveLength(0);
    expect(() => github({ token: 't', repo: 'o/r', labels: [''] })).toThrow(/labels must be a list/);
  });

  it('GITHUB_REPO: owner/name, or the repository URL', () => {
    expect(parseGitHubRepo('octo/app')).toEqual({ owner: 'octo', name: 'app' });
    expect(parseGitHubRepo(' https://github.com/Octo-Org/my.app.git/ ')).toEqual({ owner: 'Octo-Org', name: 'my.app' });
    expect(parseGitHubRepo('github.com/octo/app_2')).toEqual({ owner: 'octo', name: 'app_2' });
    for (const bad of ['octo', 'octo/', '/app', 'octo/app/issues', '-octo/app', 'octo/..', 'oc to/app', 'https://gitlab.com/octo/app']) {
      expect(parseGitHubRepo(bad), bad).toBeNull();
    }
  });

  it('default title falls back to the first line, cut to 256 characters', () => {
    const event = sendManual();
    event.data.entry.text = '\n  First line  \nsecond';
    expect(githubTitle(event)).toBe('First line');
    event.data.entry.text = 'x'.repeat(300);
    expect(githubTitle(event)).toHaveLength(256);
    event.data.entry.title = '  Titel ';
    expect(githubTitle(event)).toBe('Titel');
    event.data.entry.text = '';
    event.data.entry.due = null;
    event.data.entry.source_url = null;
    expect(githubBody(event)).toBe('— via yoink');
  });
});
