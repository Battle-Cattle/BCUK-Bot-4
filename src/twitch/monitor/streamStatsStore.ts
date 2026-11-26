// The last Helix answer for each monitored Twitch login: live or offline, title, category, viewer count, start time and
// when it was checked. The poll writes it, straight from the Helix response, so it is kept apart from `LiveStateMap`
// (which exists for Discord announcements: a stream whose announcement failed has no entry, and an offline stream stays in
// it through its grace period). The dashboard's own-channel stats read it (#1182, #1183).
//
// In memory, per process, like the other monitor state (see CLAUDE.md, "Single instance only"). Everything in it is
// untrusted text from Twitch: render it as text, never as markup.
import type { TwitchStream } from '../twitchApi';

/** What Helix said about one login at one check. Missing fields are absent, never made up. */
export interface StreamStats {
  /** True when Helix listed the stream as live at `checkedAt`. */
  live: boolean;
  /** The stream title; only while live and non-empty. */
  title?: string;
  /** The category (game) name; only while live and non-empty. */
  category?: string;
  /** Current viewers; only while live and a non-negative whole number. */
  viewerCount?: number;
  /** ISO time the stream went live; only while live and a valid date. */
  startedAt?: string;
  /** ISO time of the poll that produced this entry. A failed poll writes nothing, so this only gets older. */
  checkedAt: string;
}

const stats = new Map<string, StreamStats>();
const listeners = new Set<(logins: string[]) => void>();

/**
 * Builds the stored entry for one login from its Helix stream, if it is live.
 * @param stream - The login's live stream from Helix, or undefined when it is offline.
 * @param checkedAt - ISO time of the check.
 * @returns The entry, with only the fields Helix gave usable values for.
 */
function buildEntry(stream: TwitchStream | undefined, checkedAt: string): StreamStats {
  if (!stream) return { live: false, checkedAt };
  const entry: StreamStats = { live: true, checkedAt };
  if (stream.title) entry.title = stream.title;
  if (stream.game_name) entry.category = stream.game_name;
  if (Number.isSafeInteger(stream.viewer_count) && (stream.viewer_count as number) >= 0) entry.viewerCount = stream.viewer_count;
  if (stream.started_at && !Number.isNaN(Date.parse(stream.started_at))) entry.startedAt = stream.started_at;
  return entry;
}

/**
 * Records the result of a successful Helix check: each login is live (it has a stream in `liveByUserId`) or offline, all
 * stamped with one time. Notifies the listeners once, with the logins written.
 * @param loginToUserId - The lowercased logins checked, each mapped to its Twitch user ID.
 * @param liveByUserId - The live streams Helix returned, by Twitch user ID.
 * @param now - The check time; defaults to now.
 */
export function recordStreamStatsPoll(
  loginToUserId: ReadonlyMap<string, string>,
  liveByUserId: ReadonlyMap<string, TwitchStream>,
  now: Date = new Date(),
): void {
  const checkedAt = now.toISOString();
  const written: string[] = [];
  for (const [login, userId] of loginToUserId) {
    stats.set(login, buildEntry(liveByUserId.get(userId), checkedAt));
    written.push(login);
  }
  if (written.length === 0) return;
  for (const listener of listeners) listener(written);
}

/**
 * The last recorded stats for a login.
 * @param login - Lowercased Twitch login.
 * @returns The entry, or undefined when the login isn't monitored or hasn't been checked yet.
 */
export function getStreamStats(login: string): StreamStats | undefined {
  return stats.get(login);
}

/**
 * Forgets every login that is no longer monitored, so a removed channel's last stats can't be served.
 * @param monitored - The lowercased logins the monitor now watches.
 */
export function dropUnmonitoredStreamStats(monitored: Iterable<string>): void {
  const keep = new Set(monitored);
  for (const login of Array.from(stats.keys())) if (!keep.has(login)) stats.delete(login);
}

/**
 * Registers a listener called after each poll with the logins whose stats were just written. Never removed: it lives for
 * the process, like `onStatusChanged`.
 * @param listener - Called with the logins written.
 */
export function onStreamStatsUpdated(listener: (logins: string[]) => void): void {
  listeners.add(listener);
}

/** Empties the stored stats; listeners are registered once at import by their modules, so they stay. Exported for tests. */
export function resetStreamStatsForTests(): void {
  stats.clear();
}
