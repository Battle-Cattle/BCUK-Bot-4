import { Router, type Response } from 'express';
import { findUser, getMemberAccessLevel } from '../../db';
import { requireGuildContext } from '../middleware';
import { DASHBOARD_STATUS_MAX_SSE_PER_GUILD } from '../../shared/config';
import { onStatusChanged } from '../../shared/statusStore';
import { getGuildScopedStatus } from '../guildScopedStatus';
import { attachSseConnection, broadcastToChannel } from './sseChannel';
import { createLogger } from '../../shared/logger';
import { createMutationQueue } from '../../shared/mutationQueue';

const log = createLogger('Web');
const router = Router();

// In-memory map of active SSE connections keyed by guild ID.
export const connections = new Map<string, Set<Response>>();

// Which session user opened each connection, so a membership revocation can find and close
// exactly that user's streams (see disconnectGuildStatusConnectionsForMember).
const connectionOwners = new WeakMap<Response, string>();

// Connections still awaiting their post-attach access re-check. They're already registered in
// `connections` (so a concurrent removal can find and close them), but are skipped by status
// broadcasts until the re-check passes, so a just-removed member never receives a push while it runs.
const pendingAccessCheck = new WeakSet<Response>();

/** Whether a connection may receive status broadcasts (i.e. it isn't still awaiting its access re-check). */
const isVerifiedConnection = (res: Response): boolean => !pendingAccessCheck.has(res);

export const MAX_SSE_CONNECTIONS_PER_GUILD = DASHBOARD_STATUS_MAX_SSE_PER_GUILD;

// Serializes each guild's own status pushes so a slower DB round-trip for an older change can
// never resolve after — and clobber the client with stale data behind — a newer one for the same
// guild. Unrelated guilds stay independent, same as the DB-mutation queues this pattern is shared
// with (see src/twitch/twitchChannelMembership.ts).
const statusPushQueue = createMutationQueue<string>();

/**
 * Pushes a fresh status snapshot to every dashboard connected for `guildId`, or — when
 * `guildId` is null (a change not scoped to one guild, e.g. Discord ready state or a
 * Twitch channel connecting) — to every currently connected guild, each with its own
 * guild-scoped snapshot. Registered once as the {@link onStatusChanged} listener below, so it
 * fires after every `statusStore` mutation. Each guild's snapshot is resolved and broadcast
 * independently — one guild's lookup failing doesn't stop the others from receiving theirs —
 * and serialized per guild via {@link statusPushQueue} so same-guild updates always broadcast
 * in the order they were triggered, even if their DB lookups resolve out of order.
 * @param guildId - The guild whose voice status changed, or null for a global change.
 */
async function pushStatusUpdate(guildId: string | null): Promise<void> {
  const keys = guildId !== null ? [guildId] : Array.from(connections.keys());
  await Promise.all(keys.map((key) => statusPushQueue.run(key, async () => {
    try {
      broadcastToChannel(connections, key, await getGuildScopedStatus(key), isVerifiedConnection);
    } catch (err) {
      log.error(`Failed to push status update for guild ${key}:`, err);
    }
  })));
}

onStatusChanged(pushStatusUpdate);

/**
 * Closes every open status stream `discordId` holds for `guildId`, so a member removed from a
 * guild stops receiving its live status immediately rather than whenever their tab happens to
 * disconnect — `requireGuildContext` only guards connection establishment. `res.end()` runs the
 * same `close`-event cleanup `attachSseConnection` wires up, so no separate bookkeeping is needed.
 * Called from `POST /admin/users/remove` after the membership row is deleted.
 * @param guildId - Guild the user was removed from.
 * @param discordId - Discord snowflake of the removed user.
 */
export function disconnectGuildStatusConnectionsForMember(guildId: string, discordId: string): void {
  const clients = connections.get(guildId);
  if (!clients) return;
  for (const res of Array.from(clients)) {
    if (connectionOwners.get(res) !== discordId) continue;
    try {
      res.end();
    } catch (err) {
      log.error(`Failed to close a status connection for discord ${discordId} in guild ${guildId}:`, err);
    }
  }
}

/**
 * Whether `discordId` can still act in `guildId`: a bot owner, or a current `guild_member`.
 * @param guildId - Guild to check.
 * @param discordId - Discord snowflake to check.
 * @returns True when the user still has access to the guild.
 */
async function hasLiveGuildAccess(guildId: string, discordId: string): Promise<boolean> {
  const user = await findUser(discordId);
  if (!user) return false;
  if (user.is_owner) return true;
  return (await getMemberAccessLevel(guildId, discordId)) !== null;
}

/**
 * GET /dashboard/status/events — SSE endpoint streaming live `getGuildScopedStatus(guildId)`
 * snapshots for the viewer's current guild, so the dashboard's "Bot Status" cards can update
 * without polling. Mounted behind the parent router's `requireAuth`, so a session user is always
 * present; the guild is taken from the session (never a request param), matching every other
 * guild-scoped route. Runs `requireGuildContext` first, like those routes, so the session's guild
 * is re-checked against the user's live memberships — a member removed from a guild can't keep
 * subscribing to its voice status off a stale `currentGuildId`. Access is re-checked once more
 * right after attaching, since a removal landing between `requireGuildContext`'s read and the
 * attach would otherwise miss this connection in {@link disconnectGuildStatusConnectionsForMember}
 * (it only closes connections registered when it runs); the connection is ended if access is gone,
 * or if the re-check itself fails (an unconfirmed member shouldn't default to trusted). Until the
 * re-check passes, the connection is skipped by status broadcasts (see `pendingAccessCheck`).
 * @param req - Express request; reads `req.session.user.currentGuildId`.
 * @param res - Express response; upgrades to a `text/event-stream` connection kept alive with
 *   periodic pings and torn down on client disconnect; replies 400 if no guild is selected, or
 *   429 if the guild's connection limit is exceeded.
 */
router.get('/status/events', requireGuildContext, async (req, res) => {
  const user = req.session.user;
  const guildId = user?.currentGuildId ?? null;
  if (!user || !guildId) {
    res.status(400).end();
    return;
  }

  // Marked pending before attaching, so no broadcast can reach it between registration and the re-check.
  pendingAccessCheck.add(res);
  const attached = attachSseConnection(req, res, { connections, key: guildId, maxPerChannel: MAX_SSE_CONNECTIONS_PER_GUILD });
  if (!attached) return;
  connectionOwners.set(res, user.discordId);

  try {
    if (await hasLiveGuildAccess(guildId, user.discordId)) {
      pendingAccessCheck.delete(res);
    } else {
      res.end();
    }
  } catch (err) {
    log.error(`Failed to re-verify guild access for discord ${user.discordId} in guild ${guildId} after connecting:`, err);
    res.end();
  }
});

export default router;
