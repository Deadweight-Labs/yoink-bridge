/**
 * GitHub Issues preset: creates an issue per entry, closes it as "not
 * planned" on "withdraw", and comments on it when the entry is edited in
 * yoink afterwards.
 *
 * GitHub REST API, as documented on 2026-10-18
 * (https://docs.github.com/en/rest/issues/issues?apiVersion=2022-11-28):
 * - `POST /repos/{owner}/{repo}/issues` with `{ title, body, labels }` → 201
 *   with the issue (`number`, `html_url`). "Only users with push access can
 *   set labels for new issues. Labels are silently dropped otherwise." 410
 *   when issues are disabled; 422 "Validation failed, or the endpoint has been
 *   spammed".
 * - `PATCH /repos/{owner}/{repo}/issues/{issue_number}` with
 *   `{ state: "closed", state_reason: "not_planned" }`; closing a closed
 *   issue again is fine.
 * - `POST /repos/{owner}/{repo}/issues/{issue_number}/comments` with
 *   `{ body }` → 201 with the comment; 403, 404, 410 (issue deleted or
 *   issues disabled), 422
 *   (https://docs.github.com/en/rest/issues/comments?apiVersion=2022-11-28).
 * - Headers: `Authorization: Bearer <token>`, `Accept:
 *   application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`, and a
 *   `User-Agent` (requests without one are rejected; Workers' fetch adds
 *   none).
 * - Rate limits answer 403 or 429, with `x-ratelimit-remaining: 0` (primary)
 *   or a message about a secondary rate limit, often with `retry-after`.
 *   A fine-grained token without access to the repository gets 404.
 *
 * Token: a fine-grained personal access token limited to one repository with
 * "Issues: Read and write" (github.com → Settings → Developer settings →
 * Personal access tokens → Fine-grained tokens).
 *
 * Not yet tested against the live GitHub API.
 */
import { cutText } from '../manifest.ts';
import { BridgeError, type EntryHandler, type UndoHandler, type UpdateHandler } from '../bridge.ts';
import type { EntrySendEvent, EntryUndoEvent, EntryUpdateEvent, Receipt } from '../types.ts';
import { SDK_VERSION } from '../version.ts';
import { issueMarkdown, issueTitle, notConfigured, updateComment, type FetchLike } from './shared.ts';

export const GITHUB_API = 'https://api.github.com';
export const GITHUB_API_VERSION = '2022-11-28';

export interface GitHubOptions {
  /**
   * Fine-grained personal access token with "Issues: Read and write" on the
   * repository. May be `undefined` until the secret is set; sends then fail
   * with 503 (use `requires` in `yoink-bridge/cloudflare` to wait for it).
   */
  token: string | undefined;
  /**
   * The repository, `owner/name` (a `https://github.com/owner/name` URL is
   * accepted too). `undefined` → 503 at send time, like a missing token;
   * anything else that is not a repository → 422 at send time, with the reason.
   */
  repo: string | undefined;
  /** Label names to add to every issue. They should exist in the repository. */
  labels?: string[];
  /** Issue title. Default: the entry title, else the first line of the text (max. 256 characters). */
  title?: (event: EntrySendEvent) => string;
  /** Issue body (Markdown). Default: the text, project, due date, link, attachments, "— via yoink". */
  body?: (event: EntrySendEvent) => string;
  /** Custom `fetch`, e.g. for tests. */
  fetch?: FetchLike;
}

/** Overrides for `createIssue` (all optional). */
export interface GitHubIssueOverrides {
  title?: string;
  /** Markdown. */
  body?: string;
  /** Label names. Replaces the configured `labels`. */
  labels?: string[];
}

/**
 * `onEntry`/`onUndo`/`onUpdate` for a destination (`{ name, description,
 * ...github({ … }) }`), plus the lower-level calls for your own routing code.
 * `createIssue`, `closeIssue` and `commentOnIssue` are not enumerable, so
 * spreading copies only the handlers.
 */
export interface GitHubHandlers {
  /** Creates the issue; answers `{ url: html_url, label: "#12", external_id: "owner/name#12" }`. */
  onEntry: EntryHandler;
  /** Closes the issue created for the withdrawn entry as "not planned". */
  onUndo: UndoHandler;
  /**
   * Edited in yoink after sending: comments "In yoink geändert" with what
   * changed (`updateComment`) on the issue from `external_id`, in the
   * repository named there. The issue's title and body stay as they are. No
   * `external_id` → 501 (no more updates for that delivery).
   */
  onUpdate: UpdateHandler;
  /** Creates an issue for `event`, with your own fields; returns the receipt. */
  createIssue(event: EntrySendEvent, overrides?: GitHubIssueOverrides): Promise<Receipt>;
  /**
   * Closes an issue as "not planned" (what `onUndo` does with `external_id`):
   * `owner/name#12` in that repository, or a bare number (`12`) in the
   * current `repo`.
   */
  closeIssue(issue: number | string): Promise<void>;
  /** Comments on an issue (`owner/name#12`, or a number in the current `repo`); `body` is Markdown. */
  commentOnIssue(issue: number | string, body: string): Promise<void>;
}

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * `owner/name` from what a user may paste as `GITHUB_REPO`: `owner/name`, or
 * the repository URL (`https://github.com/owner/name`, also with `.git` or a
 * trailing slash). `null` if it is not a repository.
 */
export function parseGitHubRepo(value: string): { owner: string; name: string } | null {
  let path = value.trim().replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, '');
  path = path.replace(/\/+$/, '').replace(/\.git$/i, '');
  const [owner, name, ...rest] = path.split('/');
  if (rest.length > 0 || !owner || !name || !OWNER.test(owner) || !NAME.test(name) || name === '.' || name === '..') {
    return null;
  }
  return { owner, name };
}

/** Default issue title: the entry title, else its first non-empty line (max. 256 characters). */
export function githubTitle(event: EntrySendEvent): string {
  return issueTitle(event, 256);
}

/**
 * Default issue body (Markdown): the text, a list with project, due date,
 * source link and attachments (which stay in yoink), then "— via yoink".
 */
export function githubBody(event: EntrySendEvent): string {
  return issueMarkdown(event);
}

/**
 * GitHub Issues destination handlers. Errors: a rejected token (401), missing
 * permission (403), an unknown repository (404, also when the token has no
 * access), disabled issues (410) and validation errors (422) are permanent
 * (`BridgeError(422)`, yoink does not retry); rate limits, 5xx, 408, network
 * errors and timeouts are `BridgeError(502)` (yoink retries).
 */
export function github(options: GitHubOptions): GitHubHandlers {
  if (!options || typeof options !== 'object') throw new TypeError('github: options are required');
  const labels = options.labels ?? [];
  if (!Array.isArray(labels) || labels.some((l) => typeof l !== 'string' || !l.trim())) {
    throw new TypeError('github: labels must be a list of label names');
  }
  const makeTitle = options.title ?? githubTitle;
  const makeBody = options.body ?? githubBody;
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));

  function repository(): string {
    if (options.repo === undefined || options.repo === null || !String(options.repo).trim()) {
      throw notConfigured('the GitHub repository');
    }
    const repo = parseGitHubRepo(String(options.repo));
    if (!repo) throw new BridgeError(422, 'GITHUB_REPO must be owner/name, e.g. octocat/hello-world');
    return `${repo.owner}/${repo.name}`;
  }

  /**
   * `target` (`owner/name`) defaults to the configured repository; `issue`
   * (the number) makes error messages name that issue.
   */
  async function call<T>(
    method: 'POST' | 'PATCH',
    target: string | undefined,
    path: string,
    payload: unknown,
    issue?: string,
  ): Promise<T> {
    const token = options.token?.trim();
    if (!token) throw notConfigured('the GitHub token');
    const repo = target ?? repository();
    let response: Response;
    try {
      response = await doFetch(`${GITHUB_API}/repos/${repo}${path}`, {
        method,
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'user-agent': `yoink-bridge/${SDK_VERSION}`,
          'x-github-api-version': GITHUB_API_VERSION,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      throw new BridgeError(502, 'GitHub unreachable', { cause: error });
    }
    if (response.ok) {
      try {
        return (await response.json()) as T;
      } catch {
        throw new BridgeError(502, `GitHub answered ${response.status} without JSON`);
      }
    }
    throw await failure(response, repo, issue);
  }

  async function createIssue(event: EntrySendEvent, overrides: GitHubIssueOverrides = {}): Promise<Receipt> {
    const title = overrides.title?.trim() ? cutText(overrides.title.trim(), 256) : makeTitle(event);
    const issueLabels = [...new Set((overrides.labels ?? labels).map((l) => l.trim()).filter(Boolean))];
    const payload: Record<string, unknown> = { title, body: overrides.body ?? makeBody(event) };
    if (issueLabels.length > 0) payload.labels = issueLabels;
    const repo = repository();
    const issue = await call<{ number?: unknown; html_url?: unknown }>('POST', repo, '/issues', payload);
    if (typeof issue.number !== 'number' || typeof issue.html_url !== 'string') {
      throw new BridgeError(502, 'GitHub answered without an issue');
    }
    // The repository goes into external_id, so withdrawing still closes the
    // right issue after GITHUB_REPO changed.
    return { url: issue.html_url, label: `#${issue.number}`, external_id: `${repo}#${issue.number}` };
  }

  function issueRef(issue: number | string): { repo?: string; number: string } {
    const ref = parseIssueRef(String(issue));
    if (!ref) throw new BridgeError(422, `not a GitHub issue: ${JSON.stringify(String(issue)).slice(0, 60)}`);
    return ref;
  }

  async function closeIssue(issue: number | string): Promise<void> {
    const ref = issueRef(issue);
    await call('PATCH', ref.repo, `/issues/${ref.number}`, { state: 'closed', state_reason: 'not_planned' }, ref.number);
  }

  async function commentOnIssue(issue: number | string, body: string): Promise<void> {
    const ref = issueRef(issue);
    await call('POST', ref.repo, `/issues/${ref.number}/comments`, { body }, ref.number);
  }

  async function onUpdate(event: EntryUpdateEvent): Promise<void> {
    const issue = event.data.external_id;
    if (typeof issue !== 'string' || !issue.trim()) {
      // Nothing to comment on, now or after later edits: 501 stops updates for this delivery.
      throw new BridgeError(501, 'no external_id for this delivery: no GitHub issue to comment on');
    }
    const body = updateComment(event);
    if (body !== null) await commentOnIssue(issue, body);
  }

  const handlers = {
    onEntry: (event: EntrySendEvent) => createIssue(event),
    onUndo: (event: EntryUndoEvent) => closeIssue(event.data.external_id),
    onUpdate,
  };
  return Object.defineProperties(handlers, {
    createIssue: { value: createIssue, enumerable: false },
    closeIssue: { value: closeIssue, enumerable: false },
    commentOnIssue: { value: commentOnIssue, enumerable: false },
  }) as typeof handlers & Pick<GitHubHandlers, 'createIssue' | 'closeIssue' | 'commentOnIssue'>;
}

/**
 * `owner/name#12` → that repository and number; a bare `12` (older
 * receipts) → that number in the configured repository.
 */
function parseIssueRef(value: string): { repo?: string; number: string } | null {
  const match = /^(?:(.+)#)?([1-9]\d{0,15})$/.exec(value.trim());
  if (!match) return null;
  if (match[1] === undefined) return { number: match[2]! };
  const repo = parseGitHubRepo(match[1]);
  return repo ? { repo: `${repo.owner}/${repo.name}`, number: match[2]! } : null;
}

/**
 * Maps a failed GitHub answer to a `BridgeError`: retryable (502) or permanent
 * (422). `issue` (a number) is set for calls on an existing issue.
 */
async function failure(response: Response, repo: string, issue?: string): Promise<BridgeError> {
  const { status } = response;
  let message = '';
  try {
    const body = (await response.json()) as { message?: unknown; errors?: { message?: unknown; code?: unknown; field?: unknown }[] };
    if (typeof body.message === 'string') message = body.message;
    const details = (Array.isArray(body.errors) ? body.errors : [])
      .map((e) => (typeof e?.message === 'string' ? e.message : [e?.field, e?.code].filter((x) => typeof x === 'string').join(' ')))
      .filter(Boolean);
    if (details.length > 0) message += `${message ? ': ' : ''}${details.join('; ')}`;
  } catch {
    // no JSON: the status says enough
  }
  message = message.slice(0, 200);
  const rateLimited =
    status === 429 ||
    (status === 403 && (response.headers.get('x-ratelimit-remaining') === '0' || /rate limit/i.test(message)));
  if (rateLimited) {
    const wait = response.headers.get('retry-after');
    return new BridgeError(502, `GitHub rate limit reached${wait ? ` (retry after ${wait} s)` : ''}`);
  }
  if (status >= 500 || status === 408) return new BridgeError(502, `GitHub answered ${status}`);
  if (status === 401) return new BridgeError(422, 'GitHub rejected the token (expired or revoked?): set a new GITHUB_TOKEN');
  if (status === 403) {
    return new BridgeError(422, `GitHub refused: the token needs "Issues: Read and write" on ${repo}${message ? ` (${message})` : ''}`);
  }
  if (status === 404) {
    return new BridgeError(
      422,
      issue === undefined
        ? `GitHub: ${repo} not found, or the token has no access to it`
        : `GitHub: issue ${repo}#${issue} not found, or the token has no access to ${repo}`,
    );
  }
  if (status === 410) {
    return new BridgeError(
      422,
      issue === undefined
        ? `GitHub: issues are turned off in ${repo}`
        : `GitHub: issue ${repo}#${issue} was deleted, or issues are turned off in ${repo}`,
    );
  }
  if (status === 422) {
    const what = issue === undefined ? 'the issue' : `the request for ${repo}#${issue}`;
    return new BridgeError(422, `GitHub rejected ${what}${message ? `: ${message}` : ''}`);
  }
  return new BridgeError(422, `GitHub answered ${status}${message ? `: ${message}` : ''}`);
}
