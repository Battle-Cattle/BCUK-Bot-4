import { Router, type Response } from 'express';
import { findUser, getGuildsForMember } from '../../db';
import { DASHBOARD_STREAM_STATS_MAX_SSE_PER_USER } from '../../shared/config';
import { createLogger } from '../../shared/logger';
import { normalizeTwitchChannelName } from '../../twitch/twitchChannelName';
import { getStreamStats, onStreamStatsUpdated } from '../../twitch/monitor/streamStatsStore';
import { getLiveAccessForRequest } from '../guildAccess';
import { requireGuildContext } from '../middleware';
import { registerSessionStream, CONTEXT_CHANGED_FRAME } from '../sessionStreams';
import { attachSseConnection, broadcastToChannel } from './sseChannel';

// "Your channel" live stats (#1182, #1183): the signed-in user's OWN channel only. The login is always read from the
// user's own row, never from the request, so no query string or header can point these routes at another channel.

const log = createLogger('DashboardStreamStats');
const router = Router();

/** Open stats streams, keyed by the Discord snowflake of the user they belong to (not by login: a login can change). */
export const connections = new Map<string, Set<Response>>();

/** The normalised login each connection was opened for, so a push reaches only streams for the channel that changed. */
const connectionLogins = new WeakMap<Response, string>();

/** Connections still awaiting their post-attach access re-check: skipped by pushes and sent nothing until it passes. */
const pendingAccessCheck = new WeakSet<Response>();

/**
 * Whether a connection may be sent stats (it has passed its access re-check).
 * @param res - The SSE connection's response.
 * @returns True once the re-check has passed.
 */
const isVerifiedConnection = (res: Response): boolean => !pendingAccessCheck.has(res);

/**
 * The stats payload for one login, in the shape both routes send. Missing fields are absent, never made up; the browser
 * works out uptime and age from `startedAt`, `checkedAt` and `serverTime`, not from its own clock alone.
 * @param login - The user's own normalised Twitch login.
 * @param now - The time the payload is built.
 * @returns `tracked: false` when the monitor doesn't watch the login (or hasn't checked it yet), else the recorded stats.
 */
function buildPayload(login: string, now: Date = new Date()): Record<string, unknown> {
  const stats = getStreamStats(login);
  const serverTime = now.toISOString();
  return stats ? { ok: true, tracked: true, serverTime, ...stats } : { ok: true, tracked: false, serverTime };
}

/**
 * The signed-in user's own normalised Twitch login, from their live user row.
 * @param login - The user row's `twitch_name`.
 * @returns The normalised login, or null when the user has none.
 */
const ownLoginOf = (login: string | null | undefined): string | null => (login ? normalizeTwitchChannelName(login) : null);

/**
 * GET /dashboard/stream/stats — the signed-in user's own channel's last-known stats as JSON. Mounted behind the parent
 * router's `requireAuth`; `requireGuildContext` runs first, as on the other dashboard routes. Every query parameter is
 * ignored.
 * @param req - Express request; reads `req.session.user`.
 * @param res - Express response; JSON the stats payload, 403 when the user has no linked Twitch account, or 500 (logged)
 *   when the lookup fails.
 */
router.get('/stream/stats', requireGuildContext, async (req, res) => {
  try {
    const discordId = req.session.user?.discordId;
    const access = discordId ? await getLiveAccessForRequest(req, discordId) : null;
    const login = ownLoginOf(access?.dbUser.twitch_name);
    if (!login) {
      res.status(403).json({ ok: false, error: 'no_channel' });
      return;
    }
    res.json(buildPayload(login));
  } catch (err) {
    log.error('Failed to load own-channel stream stats:', err);
    res.status(500).json({ ok: false });
  }
});

/**
 * Whether the user may still hold a stats stream for `login`: their row still exists, they still have panel access (the
 * bot owner, or a member of a guild) and their account still links the same channel.
 * @param discordId - Discord snowflake of the stream's user.
 * @param login - The normalised login the stream was opened for.
 * @returns True when access and channel are unchanged.
 */
async function stillEntitled(discordId: string, login: string): Promise<boolean> {
  const dbUser = await findUser(discordId);
  if (!dbUser || ownLoginOf(dbUser.twitch_name) !== login) return false;
  return dbUser.is_owner || (await getGuildsForMember(discordId)).length > 0;
}

/**
 * GET /dashboard/stream/events — SSE stream of the signed-in user's own channel stats: one snapshot once the stream is
 * verified, then one after each poll that checked the channel. Keyed by the user, and registered with
 * {@link registerSessionStream} straight after attaching (nothing awaited between) so it closes when the session ends, as
 * the other dashboard streams do. Access and the linked channel are re-checked once after attaching; until that passes the
 * stream receives nothing, and it is ended if access is gone or the re-check fails. Not tied to a guild: the stats belong
 * to the user's own channel, so a guild switch leaves it open.
 * @param req - Express request; reads `req.session.user`.
 * @param res - Express response; upgrades to `text/event-stream`, or 403 when the user has no linked Twitch account, or 429
 *   at the per-user or process-wide connection limit.
 */
router.get('/stream/events', requireGuildContext, async (req, res) => {
  const discordId = req.session.user?.discordId;
  let access;
  try {
    access = discordId ? await getLiveAccessForRequest(req, discordId) : null;
  } catch (err) {
    log.error('Failed to resolve the channel for a stats stream:', err);
    res.status(500).end();
    return;
  }
  const login = ownLoginOf(access?.dbUser.twitch_name);
  if (!discordId || !login) {
    res.status(403).end();
    return;
  }

  pendingAccessCheck.add(res);
  connectionLogins.set(res, login);
  if (!attachSseConnection(req, res, { connections, key: discordId, maxPerChannel: DASHBOARD_STREAM_STATS_MAX_SSE_PER_USER })) return;
  // Straight after attaching, before the re-check's await: a sign-out then closes this stream, and a session destroyed
  // while this request was in flight refuses it here (#1112).
  if (!registerSessionStream(req, res, 'stats')) return;

  try {
    if (!(await stillEntitled(discordId, login))) {
      res.end();
      return;
    }
    pendingAccessCheck.delete(res);
    broadcastToChannel(connections, discordId, buildPayload(login), (client) => client === res);
  } catch (err) {
    log.error(`Failed to re-verify access for discord ${discordId} after connecting a stats stream:`, err);
    res.end();
  }
});

/**
 * Ends every stats stream a user holds, telling the page to reload first, because the channel it was opened for may no
 * longer be theirs (an admin changed their linked Twitch account) or their access is gone. Never throws.
 * @param discordId - Discord snowflake of the user.
 */
export function closeStreamStatsForUser(discordId: string): void {
  for (const res of Array.from(connections.get(discordId) ?? [])) {
    try {
      if (!res.writableEnded && !res.destroyed) res.write(CONTEXT_CHANGED_FRAME);
      res.end();
    } catch (err) {
      log.error(`Failed to close a stats stream for discord ${discordId}:`, err);
    }
  }
}

/**
 * Sends the fresh stats to every verified stream whose channel was just checked. Each user's streams are sent the payload
 * for the login they were opened with, so one user's stream never receives another channel's stats.
 * @param logins - The lowercased logins whose stats were just written.
 */
function pushStatsForLogins(logins: readonly string[]): void {
  const changed = new Set(logins);
  const now = new Date();
  for (const [discordId, clients] of Array.from(connections)) {
    const seen = new Set<string>();
    for (const res of clients) {
      const login = connectionLogins.get(res);
      if (!login || !changed.has(login) || seen.has(login) || !isVerifiedConnection(res)) continue;
      seen.add(login);
      broadcastToChannel(connections, discordId, buildPayload(login, now), (client) => isVerifiedConnection(client) && connectionLogins.get(client) === login);
    }
  }
}

onStreamStatsUpdated(pushStatsForLogins);

export default router;
