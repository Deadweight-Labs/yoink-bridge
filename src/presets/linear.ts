/**
 * Linear preset: creates an issue per entry, archives it on "withdraw", and
 * comments on it when the entry is edited in yoink afterwards.
 *
 * Linear GraphQL API, as documented on 2026-10-16:
 * - Endpoint `https://api.linear.app/graphql`; personal API keys go into the
 *   header `Authorization: <API_KEY>` (OAuth tokens would use "Bearer").
 *   https://linear.app/developers/graphql
 * - `issueCreate(input: IssueCreateInput!): IssuePayload!` with
 *   `{ teamId: String!, title, description, labelIds: [String!] }` →
 *   `{ success: Boolean!, issue: Issue }`, where `Issue` has `id`,
 *   `identifier` ("ENG-123") and `url`.
 * - `issueArchive(id: String!, trash: Boolean): IssueArchivePayload!` →
 *   `{ success: Boolean! }`; archived issues can be restored.
 * - `commentCreate(input: CommentCreateInput!): CommentPayload!` with
 *   `{ issueId: String, body: String }` ("The issue to associate the comment
 *   with. Can be a UUID or issue identifier (e.g., 'LIN-123')"; body in
 *   Markdown) → `{ success: Boolean!, comment: Comment! }` (schema as of
 *   2026-10-18). An unknown issue is a GraphQL error.
 * - `teams(first:)` → `nodes { id key }` (the key is the issue prefix);
 *   `issueLabels(filter: { name: … })` → `nodes { id name isGroup team { id } }`,
 *   where `team: null` means a workspace label and group labels can't be applied.
 * - `IssueCreateInput.priority: Int`: "0 = No priority, 1 = Urgent, 2 = High,
 *   3 = Medium, 4 = Low".
 *   Schema: https://github.com/linear/linear/blob/master/packages/sdk/src/schema.graphql
 * - Rate limits answer HTTP 400 with `errors[].extensions.code: "RATELIMITED"`
 *   (https://linear.app/developers/rate-limiting); Linear's SDK also treats 429
 *   as rate limited. A missing or invalid key answers 401 with an
 *   "authentication error" (observed, not documented).
 *
 * Not yet tested against the live Linear API.
 */
import { cutText } from '../manifest.ts';
import { BridgeError, type EntryHandler, type UndoHandler, type UpdateHandler } from '../bridge.ts';
import type { EntrySendEvent, EntryUndoEvent, EntryUpdateEvent, Receipt } from '../types.ts';
import { issueMarkdown, issueTitle, notConfigured, updateComment, type FetchLike } from './shared.ts';

export const LINEAR_ENDPOINT = 'https://api.linear.app/graphql';

export interface LinearOptions {
  /**
   * Personal API key (Linear → Settings → Security & access → Personal API
   * keys). May be `undefined` until the secret is set; sends then fail with
   * 503 (use `requires` in `yoink-bridge/cloudflare` to wait for it).
   */
  apiKey: string | undefined;
  /** Team key, the issue prefix such as `ABC`, or the team id. */
  team: string | undefined;
  /** Label names (or ids) to add to every issue. Workspace and team labels both work. */
  labels?: string[];
  /** Issue title. Default: the entry title, else the first line of the text. */
  title?: (event: EntrySendEvent) => string;
  /** Issue description (Markdown). Default: the text, project, due date, link, attachments, "— via yoink". */
  description?: (event: EntrySendEvent) => string;
  /** Custom `fetch`, e.g. for tests. */
  fetch?: FetchLike;
}

/** Overrides for `createIssue` (all optional). */
export interface IssueOverrides {
  title?: string;
  /** Markdown. */
  description?: string;
  /** 0 = no priority, 1 = urgent, 2 = high, 3 = medium, 4 = low. */
  priority?: number;
  /** Label names, resolved to ids (cached per isolate). Replaces the configured `labels`. */
  labelNames?: string[];
  /** Label ids, used as given (together with `labelNames`). Replaces the configured `labels`. */
  labelIds?: string[];
}

/**
 * `onEntry`/`onUndo`/`onUpdate` for a destination (`{ name, description,
 * ...linear({ … }) }`), plus the lower-level calls for your own routing code.
 * `createIssue`, `archiveIssue` and `commentOnIssue` are not enumerable, so
 * spreading copies only the handlers.
 */
export interface LinearHandlers {
  /** Creates the issue; answers `{ url, label: identifier, external_id: id }`. */
  onEntry: EntryHandler;
  /** Archives the issue created for the withdrawn entry. */
  onUndo: UndoHandler;
  /**
   * Edited in yoink after sending: comments "In yoink geändert" with what
   * changed (`updateComment`) on the issue from `external_id`. The issue's
   * title and description stay as they are. No `external_id` → 501
   * (no more updates for that delivery).
   */
  onUpdate: UpdateHandler;
  /** Creates an issue for `event`, with your own fields; returns the receipt. */
  createIssue(event: EntrySendEvent, overrides?: IssueOverrides): Promise<Receipt>;
  /** Archives an issue by id (what `onUndo` does with `external_id`). */
  archiveIssue(id: string): Promise<void>;
  /** Comments on an issue (id or identifier such as `ABC-12`); `body` is Markdown. */
  commentOnIssue(issue: string, body: string): Promise<void>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Default issue title: the entry title, else its first non-empty line (max. 255 characters). */
export function linearTitle(event: EntrySendEvent): string {
  return issueTitle(event, 255);
}

/**
 * Default issue description (Markdown): the text, a list with project, due
 * date, source link and attachments (which stay in yoink), then "— via yoink".
 */
export function linearDescription(event: EntrySendEvent): string {
  return issueMarkdown(event);
}

/**
 * Linear destination handlers. Errors: Linear rejecting the key (401/403 or
 * an authentication error) and other GraphQL errors or `success: false` are
 * permanent (`BridgeError(422)`, yoink does not retry); 5xx, 408/429, rate
 * limits, network errors and timeouts are `BridgeError(502)` (yoink retries).
 */
export function linear(options: LinearOptions): LinearHandlers {
  if (!options || typeof options !== 'object') throw new TypeError('linear: options are required');
  const labels = options.labels ?? [];
  if (!Array.isArray(labels) || labels.some((l) => typeof l !== 'string' || !l.trim())) {
    throw new TypeError('linear: labels must be a list of label names or ids');
  }
  const makeTitle = options.title ?? linearTitle;
  const makeDescription = options.description ?? linearDescription;
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));

  async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const apiKey = options.apiKey?.trim();
    if (!apiKey) throw notConfigured('the Linear API key');
    let response: Response;
    try {
      response = await doFetch(LINEAR_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: apiKey },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      throw new BridgeError(502, 'Linear unreachable', { cause: error });
    }
    const { status } = response;
    if (status === 401 || status === 403) throw new BridgeError(422, 'Linear rejected the API key');
    if (status >= 500 || status === 408 || status === 429) throw new BridgeError(502, `Linear answered ${status}`);

    let body: { data?: T; errors?: { message?: string; extensions?: { code?: string; type?: string } }[] };
    try {
      body = (await response.json()) as typeof body;
    } catch {
      throw new BridgeError(response.ok ? 502 : 422, `Linear answered ${status} without JSON`);
    }
    const [first] = body.errors ?? [];
    if (first) {
      const code = `${first.extensions?.code ?? ''} ${first.extensions?.type ?? ''}`.toUpperCase();
      if (code.includes('RATELIMITED') || code.includes('RATE_LIMITED')) {
        throw new BridgeError(502, 'Linear rate limit reached');
      }
      if (code.includes('AUTHENTICATION')) throw new BridgeError(422, 'Linear rejected the API key');
      throw new BridgeError(422, `Linear: ${first.message ?? 'request failed'}`);
    }
    if (!response.ok || body.data === undefined) throw new BridgeError(422, `Linear answered ${status}`);
    return body.data;
  }

  // Resolved once per isolate; a failure is not cached, so the next entry tries again.
  let teamId: Promise<string> | undefined;
  const labelCache = new Map<string, string>();

  function resolveTeam(): Promise<string> {
    const team = options.team?.trim();
    if (!team) return Promise.reject(notConfigured('the Linear team'));
    if (UUID.test(team)) return Promise.resolve(team);
    teamId ??= gql<{ teams: { nodes: { id: string; key: string }[] } }>(
      'query YoinkTeams { teams(first: 250) { nodes { id key } } }',
      {},
    ).then((data) => {
      const found = data.teams.nodes.find((node) => node.key.toUpperCase() === team.toUpperCase());
      if (!found) throw new BridgeError(422, `Linear team "${team}" not found`);
      return found.id;
    });
    teamId.catch(() => (teamId = undefined));
    return teamId;
  }

  /** Label names → ids; ids (UUIDs) pass through. Names must exist exactly (workspace or team). */
  async function resolveLabels(values: string[], team: string): Promise<string[]> {
    const trimmed = values.map((l) => l.trim()).filter(Boolean);
    const ids = trimmed.filter((l) => UUID.test(l));
    const names = [...new Set(trimmed.filter((l) => !UUID.test(l)))];
    const missing = names.filter((name) => !labelCache.has(name));
    if (missing.length > 0) {
      const data = await gql<{
        issueLabels: { nodes: { id: string; name: string; isGroup?: boolean; team: { id: string } | null }[] };
      }>(
        'query YoinkLabels($names: [String!]) { issueLabels(first: 250, filter: { name: { in: $names } }) { nodes { id name isGroup team { id } } } }',
        { names: missing },
      );
      for (const name of missing) {
        const candidates = data.issueLabels.nodes.filter(
          (node) => node.name === name && !node.isGroup && (node.team === null || node.team.id === team),
        );
        const label = candidates.find((node) => node.team !== null) ?? candidates[0];
        if (!label) throw new BridgeError(422, `Linear label "${name}" not found in this team or workspace`);
        labelCache.set(name, label.id);
      }
    }
    return [...new Set([...ids, ...names.map((name) => labelCache.get(name)!)])];
  }

  async function createIssue(event: EntrySendEvent, overrides: IssueOverrides = {}): Promise<Receipt> {
    const team = await resolveTeam();
    const input: Record<string, unknown> = {
      teamId: team,
      title: overrides.title?.trim() ? cutText(overrides.title.trim(), 255) : makeTitle(event),
      description: overrides.description ?? makeDescription(event),
    };
    if (overrides.priority !== undefined) {
      if (!Number.isInteger(overrides.priority) || overrides.priority < 0 || overrides.priority > 4) {
        throw new BridgeError(422, 'linear: priority must be 0 (none), 1 (urgent), 2 (high), 3 (medium) or 4 (low)');
      }
      input.priority = overrides.priority;
    }
    const custom = overrides.labelNames !== undefined || overrides.labelIds !== undefined;
    const ids = await resolveLabels(custom ? [...(overrides.labelNames ?? []), ...(overrides.labelIds ?? [])] : labels, team);
    if (ids.length > 0) input.labelIds = ids;
    const data = await gql<{
      issueCreate: { success: boolean; issue: { id: string; identifier: string; url: string } | null };
    }>(
      'mutation YoinkIssueCreate($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier url } } }',
      { input },
    );
    const issue = data.issueCreate?.issue;
    if (!data.issueCreate?.success || !issue) throw new BridgeError(422, 'Linear did not create the issue');
    return { url: issue.url, label: issue.identifier, external_id: issue.id };
  }

  async function archiveIssue(id: string): Promise<void> {
    const data = await gql<{ issueArchive: { success: boolean } }>(
      'mutation YoinkIssueArchive($id: String!) { issueArchive(id: $id) { success } }',
      { id },
    );
    if (!data.issueArchive?.success) throw new BridgeError(422, 'Linear did not archive the issue');
  }

  async function commentOnIssue(issue: string, body: string): Promise<void> {
    const data = await gql<{ commentCreate: { success: boolean } }>(
      'mutation YoinkCommentCreate($input: CommentCreateInput!) { commentCreate(input: $input) { success } }',
      { input: { issueId: issue, body } },
    );
    if (!data.commentCreate?.success) throw new BridgeError(422, 'Linear did not create the comment');
  }

  async function onUpdate(event: EntryUpdateEvent): Promise<void> {
    const issue = event.data.external_id;
    if (typeof issue !== 'string' || !issue.trim()) {
      // Nothing to comment on, now or after later edits: 501 stops updates for this delivery.
      throw new BridgeError(501, 'no external_id for this delivery: no Linear issue to comment on');
    }
    const body = updateComment(event);
    if (body !== null) await commentOnIssue(issue.trim(), body);
  }

  const handlers = {
    onEntry: (event: EntrySendEvent) => createIssue(event),
    onUndo: (event: EntryUndoEvent) => archiveIssue(event.data.external_id),
    onUpdate,
  };
  return Object.defineProperties(handlers, {
    createIssue: { value: createIssue, enumerable: false },
    archiveIssue: { value: archiveIssue, enumerable: false },
    commentOnIssue: { value: commentOnIssue, enumerable: false },
  }) as typeof handlers & Pick<LinearHandlers, 'createIssue' | 'archiveIssue' | 'commentOnIssue'>;
}
