import type { BridgeContext } from '../bridge.ts';
import type { EntrySendEvent } from '../types.ts';
import { defaultMessage, postJson, optionalHttpsUrl, type FetchLike } from './shared.ts';

export interface DiscordOptions {
  /** Discord webhook URL (`https://discord.com/api/webhooks/…`). Treat it as a secret. */
  webhookUrl: string | undefined;
  /** Builds the message content (Discord markdown). Default: title, text, project, due date, link. */
  format?: (event: EntrySendEvent) => string;
  /** Custom `fetch`, e.g. for tests. */
  fetch?: FetchLike;
}

/** Discord rejects `content` longer than this. */
export const DISCORD_CONTENT_LIMIT = 2000;

/** Default Discord content for an entry. */
export function formatDiscord(event: EntrySendEvent): string {
  return defaultMessage(event, { bold: (t) => `**${t}**`, escape: (t) => t });
}

/**
 * Returns an `onEntry` handler that posts `{ content }` to a Discord webhook.
 * Mentions (`@everyone`, roles, users) are disabled, and content is cut to
 * Discord's 2000-character limit. If Discord rejects the call for good (4xx,
 * e.g. a deleted webhook) it throws `BridgeError(422)` and yoink stops; on
 * network errors, timeouts, 408, 429 and 5xx it throws `BridgeError(502)` and
 * yoink retries.
 */
export function discord(options: DiscordOptions): DiscordHandler {
  const url = optionalHttpsUrl(options?.webhookUrl, 'discord');
  const format = options.format ?? formatDiscord;
  const post = (text: string) =>
    postJson(options.fetch, url, { content: truncate(text, DISCORD_CONTENT_LIMIT), allowed_mentions: { parse: [] } }, 'Discord');
  return Object.assign(async (event: EntrySendEvent) => post(format(event)), { post });
}

/**
 * The `onEntry` handler from `discord()`, plus the lower-level call for your
 * own routing code: `await chat.post('**New:** …')`. Same errors as the handler.
 */
export type DiscordHandler = ((event: EntrySendEvent, ctx?: BridgeContext) => Promise<void>) & {
  /** Posts `{ content }` (cut to 2000 characters, mentions disabled). */
  post(text: string): Promise<void>;
};

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  let cut = text.slice(0, limit - 1);
  // Do not split a surrogate pair.
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut}…`;
}
