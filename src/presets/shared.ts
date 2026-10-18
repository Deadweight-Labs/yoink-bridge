import { cutText } from '../manifest.ts';
import { BridgeError } from '../bridge.ts';
import type { Due, EntrySendEvent, EntryUpdateEvent } from '../types.ts';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface TextStyle {
  bold(text: string): string;
  escape(text: string): string;
}

/**
 * Checks a webhook URL at setup time, without echoing it (it is a secret). A
 * missing URL (`undefined` or blank) is allowed and fails at send time with
 * 503, so a destination can wait for its secret (see `requires` in
 * `yoink-bridge/cloudflare`); a present but invalid URL throws right away.
 */
export function optionalHttpsUrl(url: unknown, preset: string): string | undefined {
  if (url === undefined || url === null || (typeof url === 'string' && url.trim() === '')) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(String(url));
  } catch {
    throw new TypeError(`${preset}: webhookUrl is not a valid URL`);
  }
  if (parsed.protocol !== 'https:') throw new TypeError(`${preset}: webhookUrl must use https://`);
  return parsed.href;
}

/** Thrown at send time when a credential was never configured (retryable: yoink tries again later). */
export function notConfigured(what: string): BridgeError {
  return new BridgeError(503, `${what} is not set`);
}

/**
 * Default message: the title (or first line) in bold, the rest of the text,
 * then a line with project, due date and source link (German labels, like
 * the issue text: `Projekt: … · Fällig: …`).
 */
export function defaultMessage(event: EntrySendEvent, style: TextStyle): string {
  const { entry } = event.data;
  const lines: string[] = [];
  const text = entry.text.trim();
  if (entry.title && !text.startsWith(entry.title)) {
    lines.push(style.bold(style.escape(entry.title)));
    if (text) lines.push(style.escape(text));
  } else if (text) {
    const [first = '', ...rest] = text.split('\n');
    lines.push(style.bold(style.escape(first)));
    if (rest.length > 0) lines.push(style.escape(rest.join('\n')));
  }

  const meta: string[] = [];
  if (entry.project) meta.push(`Projekt: ${style.escape(entry.project)}`);
  if (entry.due) meta.push(`Fällig: ${formatDue(entry.due)}`);
  if (entry.source_url) meta.push(style.escape(entry.source_url));
  if (meta.length > 0) lines.push(meta.join(' · '));
  return lines.join('\n');
}

const DAY_PARTS: Record<string, string> = {
  morning: 'morgens',
  forenoon: 'vormittags',
  noon: 'mittags',
  afternoon: 'nachmittags',
  evening: 'abends',
  night: 'nachts',
};

const ATTACHMENT_KINDS: Record<string, string> = { image: 'Bild', video: 'Video', audio: 'Audio', file: 'Datei' };

/**
 * A due date in German: `16.10.2026`, `16.10.2026 (abends)` or
 * `15.10.2026 22:30 UTC`. With a time of day (`at`), date and time both come
 * from `at` in UTC (the bridge doesn't know the user's time zone, and `date`
 * is the user's local day, which can differ from the UTC day). Without one,
 * `date` is shown with its day part. An unreadable `at` is left out;
 * unknown day parts and a `date` not in `YYYY-MM-DD` are shown as they come.
 */
export function formatDue(due: Due): string {
  if (due.day_part) {
    const part = Object.hasOwn(DAY_PARTS, due.day_part) ? DAY_PARTS[due.day_part] : due.day_part;
    return `${germanDate(due.date)} (${part})`;
  }
  if (due.at) {
    const time = new Date(due.at);
    if (!Number.isNaN(time.getTime())) {
      const iso = time.toISOString();
      return `${germanDate(iso.slice(0, 10))} ${iso.slice(11, 16)} UTC`;
    }
  }
  return germanDate(due.date);
}

/** `2026-10-16` → `16.10.2026`; anything else as it is. */
function germanDate(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  return match ? `${match[3]}.${match[2]}.${match[1]}` : date;
}

/**
 * Default issue title for trackers: the entry title, else its first non-empty
 * line, cut to `max` characters.
 */
export function issueTitle(event: EntrySendEvent, max: number): string {
  const { entry } = event.data;
  const title = entry.title?.trim() || entry.text.split('\n').find((line) => line.trim())?.trim() || 'Eintrag aus yoink';
  return cutText(title, max);
}

/**
 * Default issue text (Markdown) for trackers: the entry text, a list with
 * project, due date, source link and attachments (which stay in yoink), then
 * "— via yoink". Labels are German, like yoink:
 *
 * ```
 * - Projekt: yoink
 * - Fällig: 16.10.2026
 * - Link: https://…
 * - Anhänge (nur in yoink): 1 × Bild
 * ```
 */
export function issueMarkdown(event: EntrySendEvent): string {
  const { entry } = event.data;
  const parts: string[] = [];
  if (entry.text.trim()) parts.push(entry.text.trim());
  const meta: string[] = [];
  if (entry.project) meta.push(`- Projekt: ${entry.project}`);
  if (entry.due) meta.push(`- Fällig: ${formatDue(entry.due)}`);
  if (entry.source_url) meta.push(`- Link: ${entry.source_url}`);
  if (entry.attachments.length > 0) {
    const counts = new Map<string, number>();
    for (const { kind } of entry.attachments) {
      const name = Object.hasOwn(ATTACHMENT_KINDS, kind) ? ATTACHMENT_KINDS[kind]! : kind;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    meta.push(`- Anhänge (nur in yoink): ${[...counts].map(([kind, n]) => `${n} × ${kind}`).join(', ')}`);
  }
  if (meta.length > 0) parts.push(meta.join('\n'));
  parts.push('— via yoink');
  return parts.join('\n\n');
}

/**
 * Comment text (Markdown) for an `entry.update`, as the Linear and GitHub
 * presets post it: never a new title or description, only a note of what
 * changed. Shows only the changed parts, in this order:
 *
 * ```
 * **In yoink geändert**
 *
 * Titel: <alt> → <neu>
 *
 * Neuer Text:
 *
 * > <the whole new text, quoted>
 *
 * Fällig: <alt> → <neu>
 *
 * — via yoink
 * ```
 *
 * A missing title, due date or text reads `—`. `null` when none of the
 * known parts (`title`, `text`, `due`) changed: then there is nothing to
 * post.
 */
export function updateComment(event: EntryUpdateEvent): string | null {
  const { entry, previous, changes } = event.data;
  const changed = new Set<string>(Array.isArray(changes) ? changes : []);
  const parts: string[] = [];
  if (changed.has('title')) parts.push(`Titel: ${titleText(previous?.title)} → ${titleText(entry.title)}`);
  if (changed.has('text')) {
    const text = typeof entry.text === 'string' ? entry.text.trim() : '';
    parts.push(text ? `Neuer Text:\n\n${quote(text)}` : 'Neuer Text: —');
  }
  if (changed.has('due')) parts.push(`Fällig: ${dueText(previous?.due)} → ${dueText(entry.due)}`);
  if (parts.length === 0) return null;
  return ['**In yoink geändert**', ...parts, '— via yoink'].join('\n\n');
}

/** A title on one line, `—` when there is none. */
function titleText(title: string | null | undefined): string {
  const line = typeof title === 'string' ? title.replace(/\s+/g, ' ').trim() : '';
  return line || '—';
}

function dueText(due: Due | null | undefined): string {
  return due && typeof due.date === 'string' ? formatDue(due) : '—';
}

/** A Markdown blockquote (empty lines stay inside the quote). */
function quote(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => (line.trim() ? `> ${line}` : '>'))
    .join('\n');
}

/**
 * POSTs JSON upstream. A permanent upstream 4xx (e.g. a revoked webhook)
 * becomes `BridgeError(422)`, so yoink stops retrying; network errors,
 * timeouts, 408, 429 and 5xx become `BridgeError(502)`, so yoink retries.
 */
export async function postJson(
  fetchImpl: FetchLike | undefined,
  url: string | undefined,
  payload: unknown,
  service: string,
): Promise<void> {
  if (url === undefined) throw notConfigured(`the ${service} webhook URL`);
  const doFetch: FetchLike = fetchImpl ?? ((input, init) => fetch(input, init));
  let response: Response;
  try {
    response = await doFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new BridgeError(502, `${service} webhook unreachable`, { cause: error });
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 200);
    const { status } = response;
    const permanent = status >= 400 && status < 500 && status !== 408 && status !== 429;
    throw new BridgeError(permanent ? 422 : 502, `${service} webhook answered ${status}${detail ? `: ${detail}` : ''}`);
  }
  await response.body?.cancel().catch(() => {});
}
