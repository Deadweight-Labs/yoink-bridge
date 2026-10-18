/**
 * Event types of the yoink webhook format v1. See PROTOCOL.md §3.
 *
 * All timestamps are ISO-8601 strings in UTC. Bridges must ignore fields they
 * do not know: new fields are additive and do not bump `version`.
 *
 * New *values* of the enumerations (`trigger`, `entry.type`, `day_part`,
 * `attachments[].kind`, `changes[]`) are additive too, so those types are open: they list
 * the known values for autocomplete but accept any string. Handle unknown
 * values with a sensible default instead of rejecting them.
 */

/** Known literals plus any other string (keeps editor autocomplete). */
export type Open<Known extends string> = Known | (string & {});

/** The app that sent the event. */
export interface AppInfo {
  name: string;
  /** Human-readable build, e.g. `"1.4 (212)"`. */
  build: string;
}

/** This connection in yoink. */
export interface ConnectionInfo {
  id: string;
  /** Display name of the connection in yoink. */
  name: string;
}

/** The destination from your manifest that an event is for. */
export interface DestinationRef {
  /** The destination id you declared in `createBridge({ destinations })`. */
  id: string;
  /** Its name as yoink read it from the manifest. */
  name: string;
}

/**
 * Why the entry was sent:
 * - `auto`: the check against the destination's description passed,
 * - `suggestion`: the user confirmed a suggestion,
 * - `manual`: the user picked "Send to …".
 */
export type KnownTrigger = 'auto' | 'suggestion' | 'manual';
/** `KnownTrigger` or a value added in a later app version. */
export type Trigger = Open<KnownTrigger>;

/** Coarse classification of an entry. Not a routing signal. */
export type KnownEntryType = 'todo' | 'reminder' | 'note' | 'idea';
/** `KnownEntryType` or a value added in a later app version. */
export type EntryType = Open<KnownEntryType>;

/** Part of the day a due time was derived from ("tonight" → `evening`). */
export type KnownDayPart = 'morning' | 'forenoon' | 'noon' | 'afternoon' | 'evening' | 'night';
/** `KnownDayPart` or a value added in a later app version. */
export type DayPart = Open<KnownDayPart>;

/** Kind of an attachment. */
export type KnownAttachmentKind = 'image' | 'video' | 'audio' | 'file';
/** `KnownAttachmentKind` or a value added in a later app version. */
export type AttachmentKind = Open<KnownAttachmentKind>;

export interface Due {
  /** Local calendar day of the user, `YYYY-MM-DD`. */
  date: string;
  /** Exact point in time (UTC, ISO-8601) when a time of day is known, else `null`. */
  at: string | null;
  /** Set when the time came from a part of the day rather than a clock time. */
  day_part: DayPart | null;
}

export interface Attachment {
  kind: AttachmentKind;
  /** File name. The content itself is never sent in v1. */
  name: string;
}

export interface Entry {
  id: string;
  title: string | null;
  /** Text as the user sees it. */
  text: string;
  /** Project name, or `null`. */
  project: string | null;
  type: EntryType;
  due: Due | null;
  /** When the entry was captured. */
  created_at: string;
  /** Shared link, or `null`. */
  source_url: string | null;
  attachments: Attachment[];
}

export interface Fit {
  /** Probability (0…1) that the entry matches this destination's description. */
  probability: number;
}

export interface EntrySendData {
  app: AppInfo;
  connection: ConnectionInfo;
  destination: DestinationRef;
  trigger: Trigger;
  entry: Entry;
  /** `null` when no check ran (sent by hand). */
  fit: Fit | null;
}

export interface EntryUndoData {
  app: AppInfo;
  connection: ConnectionInfo;
  /** The destination the entry was sent to. */
  destination: DestinationRef;
  /** `webhook-id` of the original `entry.send` delivery. */
  delivery_id: string;
  /** The `external_id` your bridge answered for that delivery. */
  external_id: string;
  entry: { id: string };
}

/** A part of an entry an `entry.update` reports as changed. */
export type KnownUpdateChange = 'title' | 'text' | 'due';
/** `KnownUpdateChange` or a value added in a later app version. */
export type UpdateChange = Open<KnownUpdateChange>;

/** What the destination last got of an entry: the state before this update. */
export interface PreviousEntry {
  title: string | null;
  text: string;
  /** Same shape as `entry.due`. */
  due: Due | null;
}

export interface EntryUpdateData {
  app: AppInfo;
  connection: ConnectionInfo;
  /** The destination the entry was sent to. */
  destination: DestinationRef;
  /** `webhook-id` of the original `entry.send` delivery. */
  delivery_id: string;
  /** The `external_id` your bridge answered for that delivery, or `null` if it answered none. */
  external_id: string | null;
  /** The whole entry as it is now (same shape as in `entry.send`). */
  entry: Entry;
  /** What the destination last got (title, text, due). */
  previous: PreviousEntry;
  /** What changed, in this order: `title`, `text`, `due`. */
  changes: UpdateChange[];
}

export interface PingData {
  app: AppInfo;
  connection: ConnectionInfo;
}

/** Common envelope of every event. */
export interface WebhookEnvelope<Type extends string, Data> {
  version: 1;
  type: Type;
  /**
   * When yoink built this body, ISO-8601 UTC. New on every retry: the body
   * of a retry may differ (the entry was edited in between); dedupe keeps the
   * first delivery the bridge accepted.
   */
  timestamp: string;
  data: Data;
}

/** An entry goes to one of your destinations. */
export type EntrySendEvent = WebhookEnvelope<'entry.send', EntrySendData>;
/** The user withdrew an entry that was sent earlier. */
export type EntryUndoEvent = WebhookEnvelope<'entry.undo', EntryUndoData>;
/**
 * The user edited an entry (title, text or due) after it was sent here. yoink
 * sends it once per editing burst, 2 minutes after the last edit.
 */
export type EntryUpdateEvent = WebhookEnvelope<'entry.update', EntryUpdateData>;
/** Connection test and manifest fetch ("refresh", and once the last sync is 6 h old). */
export type PingEvent = WebhookEnvelope<'ping', PingData>;

export type YoinkEvent = EntrySendEvent | EntryUndoEvent | EntryUpdateEvent | PingEvent;
export type YoinkEventType = YoinkEvent['type'];

/**
 * What a bridge may answer to `entry.send` (all optional). yoink reads at most
 * 16 KB of the response body. To take an entry and drop it, return
 * `ignore()` instead.
 */
export interface Receipt {
  /** Back link shown in yoink. Must be `https://`, otherwise yoink drops it. */
  url?: string;
  /** Chip text in yoink. Longer than 64 characters gets cut. */
  label?: string;
  /** Max. 256 characters. Enables "Withdraw" in yoink (sends `entry.undo`); comes back in `entry.update`. */
  external_id?: string;
}

// ---------------------------------------------------------------------------
// Manifest: the bridge's answer to `ping` (PROTOCOL.md §3).

/**
 * How yoink treats a destination:
 * - `auto` (default with a description): confident matches are sent by
 *   themselves, unsure ones are suggested on the entry,
 * - `suggest`: only suggestions on the entry,
 * - `manual`: never checked, only "Send to …" by hand,
 * - `all`: every new entry (within `projects`) is sent unchecked and the
 *   bridge decides itself; needs no description. Starts switched off in yoink:
 *   the user turns it on once, then it applies to new entries.
 */
export type DestinationMode = 'auto' | 'suggest' | 'manual' | 'all';

/** One destination as it appears on the wire. */
export interface ManifestDestination {
  id: string;
  name: string;
  description?: string;
  projects?: string[];
  /** Unknown values are read as `suggest`. */
  mode?: Open<DestinationMode>;
  /**
   * Alternatives share a group: an entry goes to at most one destination of
   * a group. `[a-z0-9][a-z0-9_-]{0,39}`; anything else reads as no group.
   */
  group?: string;
}

/** A destination that exists in code but still misses settings. */
export interface ManifestWaiting {
  id: string;
  name: string;
  /** Up to 10 names of missing settings (`[A-Z0-9_]{1,64}`), never values. */
  missing: string[];
}

/** The JSON body a bridge answers to `ping`. */
export interface Manifest {
  /** About the bridge (the field keeps its protocol name `relay`). */
  relay: {
    name?: string;
    sdk?: string;
    /** Where the user adds the bridge's keys (`https://` only); yoink shows "add keys ↗". */
    settings_url?: string;
  };
  destinations: ManifestDestination[];
  /** Destinations waiting for settings; yoink shows them greyed out and sends nothing there. */
  waiting?: ManifestWaiting[];
}

/** "Taken, but nothing done with it": yoink shows no receipt and no hint. Create it with `ignore()`. */
export interface Ignored {
  readonly ignored: true;
}
