import type { BridgeContext } from '../bridge.ts';
import type { EntrySendEvent } from '../types.ts';
import { defaultMessage, postJson, optionalHttpsUrl, type FetchLike } from './shared.ts';

export interface SlackOptions {
  /** Slack incoming-webhook URL (`https://hooks.slack.com/services/…`). Treat it as a secret. */
  webhookUrl: string | undefined;
  /** Builds the message text (Slack mrkdwn). Default: title, text, project, due date, link. */
  format?: (event: EntrySendEvent) => string;
  /** Custom `fetch`, e.g. for tests. */
  fetch?: FetchLike;
}

/** Escapes the three characters Slack treats as control characters. */
export function escapeSlack(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Default Slack text for an entry. */
export function formatSlack(event: EntrySendEvent): string {
  return defaultMessage(event, { bold: (t) => `*${t}*`, escape: escapeSlack });
}

/**
 * Returns an `onEntry` handler that posts `{ text }` to a Slack incoming
 * webhook. Answers 204 (Slack returns no link to the message). If Slack
 * rejects the call for good (4xx, e.g. a revoked webhook) it throws
 * `BridgeError(422)` and yoink stops; on network errors, timeouts, 408, 429
 * and 5xx it throws `BridgeError(502)` and yoink retries.
 */
export function slack(options: SlackOptions): SlackHandler {
  const url = optionalHttpsUrl(options?.webhookUrl, 'slack');
  const format = options.format ?? formatSlack;
  const post = (text: string) => postJson(options.fetch, url, { text }, 'Slack');
  return Object.assign(async (event: EntrySendEvent) => post(format(event)), { post });
}

/**
 * The `onEntry` handler from `slack()`, plus the lower-level call for your
 * own routing code: `await chat.post('*New:* …')`. Same errors as the handler.
 */
export type SlackHandler = ((event: EntrySendEvent, ctx?: BridgeContext) => Promise<void>) & {
  /** Posts `{ text }` (Slack mrkdwn; escape user text with `escapeSlack`). */
  post(text: string): Promise<void>;
};
