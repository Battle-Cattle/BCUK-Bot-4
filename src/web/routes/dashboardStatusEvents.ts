import { Router } from 'express';
import { DASHBOARD_STATUS_MAX_SSE_PER_GUILD } from '../../shared/config';
import { onStatusChanged } from '../../shared/statusStore';
import { getGuildScopedStatus } from '../guildScopedStatus';
import { attachSseConnection, broadcastToChannel } from './sseChannel';
import { createLogger } from '../../shared/logger';
import { createMutationQueue } from '../../shared/mutationQueue';

const log = createLogger('Web');
const router = Router();

// In-memory map of active SSE connections keyed by guild ID.
export const connections = new Map<string, Set<import('express').Response>>();

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
      broadcastToChannel(connections, key, await getGuildScopedStatus(key));
    } catch (err) {
      log.error(`Failed to push status update for guild ${key}:`, err);
    }
  })));
}

onStatusChanged(pushStatusUpdate);

/**
 * GET /dashboard/status/events — SSE endpoint streaming live `getGuildScopedStatus(guildId)`
 * snapshots for the viewer's current guild, so the dashboard's "Bot Status" cards can update
 * without polling. Mounted behind the parent router's `requireAuth`, so a session user is always
 * present; the guild is taken from the session (never a request param), matching every other
 * guild-scoped route.
 * @param req - Express request; reads `req.session.user.currentGuildId`.
 * @param res - Express response; upgrades to a `text/event-stream` connection kept alive with
 *   periodic pings and torn down on client disconnect; replies 400 if no guild is selected, or
 *   429 if the guild's connection limit is exceeded.
 */
router.get('/status/events', (req, res) => {
  const guildId = req.session.user?.currentGuildId ?? null;
  if (!guildId) {
    res.status(400).end();
    return;
  }

  attachSseConnection(req, res, { connections, key: guildId, maxPerChannel: MAX_SSE_CONNECTIONS_PER_GUILD });
});

export default router;
