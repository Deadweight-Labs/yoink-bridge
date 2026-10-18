/**
 * The manifest: what a bridge tells yoink about its destinations (PROTOCOL.md
 * §3), and how yoink reads it.
 */
import type { DestinationMode, Manifest } from './types.ts';

/** Limits yoink applies when reading a manifest. */
export const MANIFEST_LIMITS = {
  /** More destinations are ignored. */
  destinations: 20,
  /** More project names per destination are ignored. */
  projects: 20,
  /** Characters of a destination name, the bridge name and project names. */
  name: 60,
  /** Characters of a description. */
  description: 500,
  /** yoink reads at most this many bytes of the `ping` answer. */
  bytes: 64 * 1024,
  /** Waiting destinations yoink reads. */
  waiting: 20,
  /** Missing setting names per waiting destination. */
  missing: 10,
} as const;

/** Destination ids: lowercase letters, digits, `_` and `-`, starting with a letter or digit, max. 40. */
export const DESTINATION_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/**
 * Destination groups: the same pattern as ids. Kept exactly as given (no
 * trimming, no lowercasing); anything else reads as no group.
 */
export const GROUP_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/** Names of missing settings in `waiting[].missing`: uppercase letters, digits and `_`, max. 64. */
export const SETTING_NAME_PATTERN = /^[A-Z0-9_]{1,64}$/;

/** One destination as yoink reads it: every field filled in, texts trimmed and cut. */
export interface ParsedDestination {
  id: string;
  name: string;
  /** `""` when there is none (then `mode` is `manual`). */
  description: string;
  /** `[]` means every entry qualifies, with or without a project. */
  projects: string[];
  mode: DestinationMode;
  /**
   * Destinations with the same group are alternatives: an entry goes to at
   * most one of them. `null` without a valid group (it never skips the
   * destination).
   */
  group: string | null;
}

/** A waiting destination as yoink reads it. */
export interface ParsedWaiting {
  id: string;
  name: string;
  /** Valid setting names only, at most 10. */
  missing: string[];
}

/** What yoink reads from a `ping` answer. */
export interface ParsedManifest {
  /** `null` when the manifest has none; yoink then uses the setup-link name or the host. */
  bridgeName: string | null;
  /** `relay.settings_url` if it is `https://`, else `null`. */
  settingsUrl: string | null;
  destinations: ParsedDestination[];
  waiting: ParsedWaiting[];
}

const KNOWN_MODES: ReadonlySet<string> = new Set(['auto', 'suggest', 'manual', 'all']);
const encoder = new TextEncoder();

/**
 * Reads a manifest exactly like yoink does, so you can see what the app will
 * make of it. Lenient by design: invalid or duplicate destinations are
 * skipped (an invalid one does not claim its id), long texts are cut, and
 * anything that is not a JSON object yields no destinations.
 *
 * Pass the raw body as a string, or an already parsed value. The 64 KB read
 * limit only applies to a string (a parsed value has no byte size).
 */
export function parseManifest(input: unknown): ParsedManifest {
  const empty: ParsedManifest = { bridgeName: null, settingsUrl: null, destinations: [], waiting: [] };
  let value: unknown = input;
  if (typeof input === 'string') {
    if (encoder.encode(input).length > MANIFEST_LIMITS.bytes) return empty; // yoink would read a cut, invalid body
    try {
      value = JSON.parse(input);
    } catch {
      return empty;
    }
  }
  if (!isRecord(value)) return empty;

  const bridge = isRecord(value.relay) ? value.relay : {};
  const bridgeName = cleanText(bridge.name, MANIFEST_LIMITS.name) || null;

  const destinations: ParsedDestination[] = [];
  const seen = new Set<string>();
  const list = Array.isArray(value.destinations) ? value.destinations : [];
  for (const raw of list) {
    if (destinations.length >= MANIFEST_LIMITS.destinations) break;
    if (!isRecord(raw)) continue;
    const { id } = raw;
    if (typeof id !== 'string' || !DESTINATION_ID_PATTERN.test(id) || seen.has(id)) continue;
    const name = cleanText(raw.name, MANIFEST_LIMITS.name);
    if (!name) continue;
    seen.add(id);

    const description = cleanText(raw.description, MANIFEST_LIMITS.description);
    const projects: string[] = [];
    if (Array.isArray(raw.projects)) {
      for (const project of raw.projects) {
        if (projects.length >= MANIFEST_LIMITS.projects) break;
        const cleaned = cleanText(project, MANIFEST_LIMITS.name);
        if (cleaned) projects.push(cleaned);
      }
    }
    const group = typeof raw.group === 'string' && GROUP_PATTERN.test(raw.group) ? raw.group : null;
    destinations.push({ id, name, description, projects, mode: readMode(raw.mode, description), group });
  }

  const waiting: ParsedWaiting[] = [];
  const waitingIds = new Set<string>();
  for (const raw of Array.isArray(value.waiting) ? value.waiting : []) {
    if (waiting.length >= MANIFEST_LIMITS.waiting) break;
    if (!isRecord(raw)) continue;
    const { id } = raw;
    if (typeof id !== 'string' || !DESTINATION_ID_PATTERN.test(id) || waitingIds.has(id)) continue;
    const name = cleanText(raw.name, MANIFEST_LIMITS.name);
    if (!name) continue;
    waitingIds.add(id);
    const missing = (Array.isArray(raw.missing) ? raw.missing : [])
      .filter((m): m is string => typeof m === 'string' && SETTING_NAME_PATTERN.test(m))
      .slice(0, MANIFEST_LIMITS.missing);
    waiting.push({ id, name, missing });
  }

  return { bridgeName, settingsUrl: httpsUrl(bridge.settings_url), destinations, waiting };
}

/** The trimmed value if it is an absolute `https://` URL, else `null`. */
function httpsUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  try {
    return new URL(trimmed).protocol === 'https:' ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * `all` needs no description and is never downgraded. Otherwise: without a
 * description nothing is checked (`manual`); without a mode it is `auto`;
 * unknown → `suggest`.
 */
function readMode(mode: unknown, description: string): DestinationMode {
  if (mode === 'all') return 'all';
  if (!description) return 'manual';
  if (mode === undefined || mode === null) return 'auto';
  return typeof mode === 'string' && KNOWN_MODES.has(mode) ? (mode as DestinationMode) : 'suggest';
}

/** Trimmed and cut to `max` characters; `""` for anything that is not a string. */
function cleanText(value: unknown, max: number): string {
  return typeof value === 'string' ? cutText(value.trim(), max) : '';
}

// ---------------------------------------------------------------------------
// Characters are user-perceived characters (grapheme clusters), as in Swift:
// "👨‍👩‍👧" counts as one.

const segmenter: { segment(input: string): Iterable<{ segment: string }> } | undefined =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : undefined;

function characters(text: string): string[] {
  return segmenter ? Array.from(segmenter.segment(text), (s) => s.segment) : Array.from(text);
}

/** Length in user-perceived characters. */
export function textLength(text: string): number {
  return characters(text).length;
}

/** The first `max` user-perceived characters of `text`. */
export function cutText(text: string, max: number): string {
  if (text.length <= max) return text; // fast path: never more characters than UTF-16 units
  const chars = characters(text);
  return chars.length <= max ? text : chars.slice(0, max).join('');
}

// ---------------------------------------------------------------------------

const MODE_HINTS: Record<DestinationMode, string> = {
  auto: 'confident matches are sent, unsure ones suggested',
  suggest: 'only suggested on the entry',
  manual: 'never checked, only "Send to …" by hand',
  all: 'gets every new entry – switch it on in yoink',
};

/**
 * Describes, in plain text, the destinations yoink will read from a bridge:
 * pass the bridge from `createBridge`, its manifest, or a raw `ping` body.
 */
export function describeBridge(input: { manifest: Manifest } | Manifest | string): string {
  const raw: unknown =
    typeof input === 'string' ? input : 'manifest' in input && isRecord(input.manifest) ? input.manifest : input;
  const parsed = parseManifest(raw);
  const bridge = parsed.bridgeName ? ` from "${parsed.bridgeName}"` : '';
  const count = parsed.destinations.length;
  const lines = [
    count === 0 ? `yoink reads no destinations${bridge}.` : `yoink reads ${count} destination${count === 1 ? '' : 's'}${bridge}:`,
  ];
  for (const d of parsed.destinations) {
    lines.push(
      '',
      `${d.id}: ${d.name}`,
      `  mode:        ${d.mode} (${MODE_HINTS[d.mode]})`,
      `  projects:    ${d.projects.length > 0 ? d.projects.join(', ') : 'all'}`,
    );
    if (d.group) {
      const members = parsed.destinations.filter((other) => other.group === d.group).map((other) => other.id);
      lines.push(
        members.length > 1
          ? `  group:       ${d.group} (an entry goes to at most one of ${members.join(', ')})`
          : `  group:       ${d.group} (the only one of this group so far)`,
      );
    }
    if (d.description) lines.push(`  description: ${d.description.replace(/\n/g, '\n               ')}`);
  }

  const rawJson = typeof raw === 'string' ? safeParse(raw) : raw;
  const declared = isRecord(rawJson) && Array.isArray(rawJson.destinations) ? rawJson.destinations.length : count;
  if (declared > count) {
    lines.push(
      '',
      `${declared - count} of ${declared} entries in the manifest were skipped ` +
        `(invalid or duplicate id, missing name, or more than ${MANIFEST_LIMITS.destinations}).`,
    );
  }
  if (parsed.waiting.length > 0) {
    lines.push('', 'Waiting for settings (yoink shows them greyed out and sends nothing there):');
    for (const w of parsed.waiting) {
      lines.push(`  ${w.id}: ${w.name}${w.missing.length > 0 ? ` – waiting for ${w.missing.join(', ')}` : ''}`);
    }
  }
  if (parsed.settingsUrl) lines.push('', `Add keys: ${parsed.settingsUrl}`);
  return `${lines.join('\n')}\n`;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
