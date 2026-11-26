// Closes the dashboard's live (SSE) streams when the session that opened them ends (#1112).
//
// Nothing else ends an open stream: its 25 s keepalive holds it indefinitely, and the account,
// guild or authorisation it was opened under is only checked when it connects. This module keeps a
// registry of the open dashboard streams by session and user, and closes them when
//   - the session is destroyed or regenerated (logout, account switch, lost panel access, a guild
//     change that destroys the session, the 7-day cap): `wrapStoreDestroy` hooks the session store,
//     because express-session's `destroy` and `regenerate` both end in `store.destroy`;
//   - the user signs out their other sessions (`closeUserStreams`);
//   - the session picks another guild, or loses the one it was in: the status stream is per guild (`switchSessionGuild`,
//     `closeSessionStreamsForGuild`), so one opened under the old guild must not outlive the change;
//   - the session's own end time passes: an idle-expired session's cookie is dropped by the browser,
//     so nothing would ever call `destroy` for it (`registerSessionStream` sets one unref'd timer).
//
// Single instance only: the registry, the tombstones and the timers are in this process's memory,
// like the other per-process state in this bot (see CLAUDE.md, "Single instance only").
import type { Request, Response } from 'express';
import type { Store } from 'express-session';
import { createLogger } from '../shared/logger';
import { chainConnectionCleanup } from './routes/sseChannel';
import { sessionEndsAt } from './sessionLifetime';

const log = createLogger('SessionStreams');

/** Which dashboard stream a registered connection is. */
export type SessionStreamKind = 'status' | 'events';

/** The named SSE frame that tells a dashboard page its stream was closed because its context (session, account or guild) changed, so it reloads. It has no payload and is written once, just before the stream ends. */
export const CONTEXT_CHANGED_FRAME = 'event: context-changed\ndata: {}\n\n';

/** How long a destroyed session ID, or a user's minimum generation, is remembered (longer than any gap between a request loading its session and attaching its stream). */
export const TOMBSTONE_TTL_MS = 10 * 60 * 1000;

/**
 * How long a session's last guild switch is remembered. Short: it only covers the race where a status stream's
 * request loaded the session before the switch, a matter of one request's lookups, and refusing a stream wrongly
 * (the record and the session disagreeing) costs a live panel, unlike a destroyed session's tombstone.
 */
export const SESSION_GUILD_TTL_MS = 60 * 1000;

/** Most destroyed session IDs (and, separately, per-user minimum generations) remembered at once; the oldest are dropped first. */
export const MAX_TRACKED_ENTRIES = 10_000;

/** One registered stream. */
interface StreamEntry {
  req: Request;
  res: Response;
  sessionId: string;
  discordId: string;
  generation: number;
  /** The guild the stream was opened under: set for a `status` stream (which is per guild), null for an `events` stream (per streamer). */
  guildId: string | null;
  timer: NodeJS.Timeout | null;
}

const streams = new Map<Response, StreamEntry>();
const bySession = new Map<string, Set<Response>>();
const byUser = new Map<string, Set<Response>>();

// Destroyed session IDs (value: when to forget), so a stream whose request loaded its session
// before the destroy, then awaited a lookup, is refused when it finally registers.
const tombstones = new Map<string, number>();
// Per session, the guild it last switched to (value: when to forget), so a status stream whose request loaded the
// session before the switch, then awaited a lookup, is refused when it registers under the old guild.
const sessionGuilds = new Map<string, { guildId: string; expiresAt: number }>();
// Per user, the lowest session generation allowed to register (set by "sign out other sessions"),
// with when to forget it, for the same reason.
const minGenerations = new Map<string, { generation: number; expiresAt: number }>();

/**
 * Adds `key` to a bounded map, moving it to the newest position and dropping the oldest entries
 * once the map is over {@link MAX_TRACKED_ENTRIES}.
 * @param map - The map to add to.
 * @param key - Key to add or refresh.
 * @param value - Value to store.
 */
function remember<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX_TRACKED_ENTRIES) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}

/**
 * Adds `res` to a key's set in one of the registry's indexes.
 * @param index - The index to add to.
 * @param key - Session ID or Discord ID.
 * @param res - The stream's response.
 */
function indexAdd(index: Map<string, Set<Response>>, key: string, res: Response): void {
  const set = index.get(key) ?? new Set<Response>();
  set.add(res);
  index.set(key, set);
}

/**
 * Removes `res` from a key's set in one of the registry's indexes, dropping the set once empty.
 * @param index - The index to remove from.
 * @param key - Session ID or Discord ID.
 * @param res - The stream's response.
 */
function indexDelete(index: Map<string, Set<Response>>, key: string, res: Response): void {
  const set = index.get(key);
  if (!set) return;
  set.delete(res);
  if (set.size === 0) index.delete(key);
}

/**
 * Forgets a stream: clears its timer and removes it from every index. Idempotent, so it can run
 * from each way a connection can end.
 * @param res - The stream's response.
 */
function unregister(res: Response): void {
  const entry = streams.get(res);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  streams.delete(res);
  indexDelete(bySession, entry.sessionId, res);
  indexDelete(byUser, entry.discordId, res);
}

/**
 * Ends one stream and forgets it. A failing `end()` is logged and never stops the caller closing
 * the rest. The request's session is detached first: express-session saves or touches a session
 * when its response ends, and a stream closed because its session ended must not write that session
 * back, which could land after the store's DELETE and bring a logged-out session back (or extend its
 * row). With no `req.session`, the response ends without touching the store.
 * @param res - The stream's response.
 * @param req - The stream's request (for a stream not yet registered, since the registry has no entry for it).
 * @param notify - True to write a `context-changed` frame first, so the page reloads under its new context instead of reconnecting into it. Only for a close the registry triggers after the stream attached; a stream refused at attach has no page state to refresh.
 */
function closeStream(res: Response, req: Request | undefined = streams.get(res)?.req, notify = false): void {
  unregister(res);
  if (req) Reflect.deleteProperty(req, 'session');
  // The frame is best effort: a write that throws must never stop the stream ending.
  if (notify && !res.writableEnded && !res.destroyed) {
    try {
      res.write(CONTEXT_CHANGED_FRAME);
    } catch (err) {
      log.warn('Failed to write the context-changed frame to a dashboard stream:', err);
    }
  }
  try {
    res.end();
  } catch (err) {
    log.error('Failed to close a dashboard stream:', err);
  }
}

/**
 * Whether a destroyed session ID is still remembered.
 * @param sessionId - Session ID to check.
 * @returns True when the session was destroyed within {@link TOMBSTONE_TTL_MS}.
 */
function isTombstoned(sessionId: string): boolean {
  const expiresAt = tombstones.get(sessionId);
  if (expiresAt === undefined) return false;
  if (expiresAt > Date.now()) return true;
  tombstones.delete(sessionId);
  return false;
}

/**
 * Whether a user's session generation is below the minimum recorded by "sign out other sessions".
 * @param discordId - Discord snowflake of the user.
 * @param generation - The session's generation.
 * @returns True when the session has been signed out and must not attach a stream.
 */
function isBelowMinGeneration(discordId: string, generation: number): boolean {
  const entry = minGenerations.get(discordId);
  if (!entry) return false;
  if (entry.expiresAt <= Date.now()) {
    minGenerations.delete(discordId);
    return false;
  }
  return generation < entry.generation;
}

/**
 * Whether a status stream was opened under a guild the session has since switched away from.
 * @param sessionId - The stream's session ID.
 * @param guildId - The guild the stream was opened under, or null for a stream that has none.
 * @returns True when the session switched to a different guild within {@link SESSION_GUILD_TTL_MS}.
 */
function isStaleGuild(sessionId: string, guildId: string | null): boolean {
  const entry = sessionGuilds.get(sessionId);
  if (!entry || guildId === null) return false;
  if (entry.expiresAt <= Date.now()) {
    sessionGuilds.delete(sessionId);
    return false;
  }
  return guildId !== entry.guildId;
}

/**
 * Whether a stream must be refused: its session was destroyed, signed out by "sign out other
 * sessions", or switched to another guild than the one the stream was opened under.
 * @param sessionId - The stream's session ID.
 * @param discordId - Discord snowflake of the session's user.
 * @param generation - The session's generation.
 * @param guildId - The guild a status stream was opened under, or null.
 * @returns True when the stream must not be registered.
 */
function isRefused(sessionId: string, discordId: string, generation: number, guildId: string | null): boolean {
  return isTombstoned(sessionId) || isBelowMinGeneration(discordId, generation) || isStaleGuild(sessionId, guildId);
}

/**
 * Registers a dashboard stream that was just attached, so ending its session closes it. Must run
 * in the same synchronous turn as a successful `attachSseConnection` (no `await` in between): a
 * destroy then either finds the stream registered and closes it, or has already tombstoned the
 * session and the stream is refused here. A refused stream is ended straight away, before any data
 * frame beyond the handshake is sent.
 * @param req - The stream's request, carrying the signed-in session.
 * @param res - The attached SSE response.
 * @param kind - Which dashboard stream this is: a `status` stream is per guild (it is opened under the session's current guild), an `events` stream is not.
 * @returns False when the stream was refused (no signed-in user, a destroyed session, a session signed out by "sign out other sessions", or a status stream opened under a guild the session has since left) and has been ended.
 */
export function registerSessionStream(req: Request, res: Response, kind: SessionStreamKind): boolean {
  const sessionId = req.sessionID;
  const discordId = req.session.user?.discordId;
  const generation = req.session.sessionGeneration ?? 0;
  const guildId = kind === 'status' ? (req.session.user?.currentGuildId ?? null) : null;
  if (!sessionId || !discordId || isRefused(sessionId, discordId, generation, guildId)) {
    closeStream(res, req);
    return false;
  }

  const entry: StreamEntry = { req, res, sessionId, discordId, generation, guildId, timer: null };
  streams.set(res, entry);
  indexAdd(bySession, sessionId, res);
  indexAdd(byUser, discordId, res);

  const endsAt = sessionEndsAt(req.session);
  if (endsAt !== undefined) {
    // unref'd: a timer must never keep the process alive at shutdown. Ending early is safe, since the reconnect re-runs auth.
    // No context-changed frame here: `sessionEndsAt` is a lower bound, and a reload would be a page load that renews a session that may still be alive.
    entry.timer = setTimeout(() => closeStream(res, req), Math.max(0, endsAt - Date.now()));
    entry.timer.unref();
  }

  // attachSseConnection's own listeners run its cleanup; ours cover the same ways a connection ends, and
  // chaining onto its cleanup covers a failed broadcast or keepalive write, which can emit no close event.
  const forget = (): void => unregister(res);
  req.once('close', forget);
  res.once('close', forget);
  res.once('error', forget);
  if (!chainConnectionCleanup(res, forget)) forget();
  return true;
}

/**
 * Closes every dashboard stream a session holds, and remembers the session ID so a stream that is
 * still on its way to registering under it is refused. Called when the session is destroyed or
 * regenerated (see {@link wrapStoreDestroy}).
 * @param sessionId - ID of the destroyed session.
 */
export function closeSessionStreams(sessionId: string): void {
  remember(tombstones, sessionId, Date.now() + TOMBSTONE_TTL_MS);
  for (const res of Array.from(bySession.get(sessionId) ?? [])) closeStream(res, undefined, true);
}

/**
 * Closes a user's dashboard streams from sessions older than `belowGeneration`, and refuses any
 * such stream that registers shortly after. Called by "sign out other sessions" once it has bumped
 * the user's session generation: the sessions signed in at the new generation (none yet, bar a
 * login that raced the bump) keep their streams.
 * @param discordId - Discord snowflake of the user who signed out their other sessions.
 * @param belowGeneration - The user's new session generation; streams from lower generations close.
 * (The frame goes out as the streams close, before the response carrying the new cookie; the browser's 1.5 s settle delay is
 * best-effort and accepted as such, #1164: see `CONTEXT_SETTLE_MS` in public/dashboard-context.js.)
 */
export function closeUserStreams(discordId: string, belowGeneration: number): void {
  const current = minGenerations.get(discordId)?.generation ?? 0;
  remember(minGenerations, discordId, { generation: Math.max(current, belowGeneration), expiresAt: Date.now() + TOMBSTONE_TTL_MS });
  for (const res of Array.from(byUser.get(discordId) ?? [])) {
    if ((streams.get(res)?.generation ?? 0) < belowGeneration) closeStream(res, undefined, true);
  }
}

/**
 * Records that a session picked another guild, so a status stream still on its way to registering under the old guild
 * is refused for a while, and (unless `closeNow` is false) closes the session's status streams opened under any other
 * guild (a status stream is per guild: its snapshot is that guild's). The session's `events` stream is per streamer, so
 * it is left open.
 * @param sessionId - ID of the session that switched guild (from `POST /guild/select`).
 * @param guildId - The guild the session switched to.
 * @param closeNow - False to only record the switch and leave the closing to {@link closeStreamsOutsideGuild}. `POST /guild/select` calls this with the default, after the new guild has been saved (a failed switch records and closes nothing, #1164); false is kept for the registry's own tests.
 */
export function switchSessionGuild(sessionId: string, guildId: string, closeNow = true): void {
  remember(sessionGuilds, sessionId, { guildId, expiresAt: Date.now() + SESSION_GUILD_TTL_MS });
  if (closeNow) closeStreamsOutsideGuild(sessionId, guildId);
}

/**
 * Closes a session's status streams opened under any guild other than `guildId`, with the context-changed frame.
 * @param sessionId - ID of the session that switched guild.
 * @param guildId - The guild the session is now in; its own streams stay open.
 */
export function closeStreamsOutsideGuild(sessionId: string, guildId: string): void {
  for (const res of Array.from(bySession.get(sessionId) ?? [])) {
    const entry = streams.get(res);
    if (entry?.guildId != null && entry.guildId !== guildId) closeStream(res, undefined, true);
  }
}

/**
 * Closes a session's status streams opened under one guild, for a session that lost access to it
 * (`requireGuildContext` dropped a guild the user can no longer act in), and forgets a recorded switch to
 * that guild. Streams under the session's other guilds, its `events` stream and other sessions are left alone.
 * @param sessionId - ID of the session that lost the guild.
 * @param guildId - The guild the session lost.
 */
export function closeSessionStreamsForGuild(sessionId: string, guildId: string): void {
  // The session no longer has this guild, so a recorded switch to it is void: `requireGuildContext` may auto-pick the user's
  // only remaining guild next, and a status stream for that one must not be refused as stale.
  if (sessionGuilds.get(sessionId)?.guildId === guildId) sessionGuilds.delete(sessionId);
  for (const res of Array.from(bySession.get(sessionId) ?? [])) {
    if (streams.get(res)?.guildId === guildId) closeStream(res, undefined, true);
  }
}

/**
 * Hooks a session store so destroying a session (which `regenerate` also does) closes that
 * session's dashboard streams first. Closing comes before the real destroy, so a failing destroy
 * still leaves no stream open; a throw while closing is logged and never stops the destroy. The
 * real `destroy` gets its arguments untouched and its return value (a promise for the MySQL store)
 * is returned unchanged.
 * @param store - The session store whose `destroy` to wrap, in place.
 */
export function wrapStoreDestroy(store: Store): void {
  const original = store.destroy.bind(store) as (...args: unknown[]) => unknown;
  store.destroy = ((sessionId: string, ...rest: unknown[]) => {
    try {
      closeSessionStreams(sessionId);
    } catch (err) {
      log.error('Failed to close the dashboard streams of a destroyed session:', err);
    }
    return original(sessionId, ...rest);
  }) as Store['destroy'];
}

/**
 * Counts of what the registry holds, so tests can prove nothing leaks. Exported for tests.
 * @returns The number of registered streams, each index's session and user keys, and the remembered destroyed sessions, minimum generations and session guild switches.
 */
export function getSessionStreamStats(): { streams: number; bySession: number; byUser: number; tombstones: number; minGenerations: number; sessionGuilds: number } {
  return { streams: streams.size, bySession: bySession.size, byUser: byUser.size, tombstones: tombstones.size, minGenerations: minGenerations.size, sessionGuilds: sessionGuilds.size };
}

/** Empties the registry, the tombstones and their timers. Exported for tests. */
export function resetSessionStreamsForTests(): void {
  for (const res of Array.from(streams.keys())) unregister(res);
  tombstones.clear();
  minGenerations.clear();
  sessionGuilds.clear();
}
