import { Router } from 'express';
import { DASHBOARD_STATUS_MAX_SSE_PER_GUILD } from '../../shared/config';
import { getStatus, onStatusChanged } from '../../shared/statusStore';
import { attachSseConnection, broadcastToChannel } from './sseChannel';

const router = Router();

// In-memory map of active SSE connections keyed by guild ID.
export const connections = new Map<string, Set<import('express').Response>>();

export const MAX_SSE_CONNECTIONS_PER_GUILD = DASHBOARD_STATUS_MAX_SSE_PER_GUILD;

/**
 * Pushes a fresh status snapshot to every dashboard connected for `guildId`, or — when
 * `guildId` is null (a change not scoped to one guild, e.g. Discord ready state or a
 * Twitch/TikTok channel connecting) — to every currently connected guild, each with its own
 * guild-scoped snapshot. Registered once as the {@link onStatusChanged} listener below, so it
 * fires after every `statusStore` mutation.
 * @param guildId - The guild whose voice status changed, or null for a global change.
 */
function pushStatusUpdate(guildId: string | null): void {
  const keys = guildId !== null ? [guildId] : Array.from(connections.keys());
  for (const key of keys) {
    broadcastToChannel(connections, key, getStatus(key));
  }
}

onStatusChanged(pushStatusUpdate);

/**
 * GET /dashboard/status/events — SSE endpoint streaming live `getStatus(guildId)` snapshots
 * for the viewer's current guild, so the dashboard's "Bot Status" cards can update without
 * polling. Mounted behind the parent router's `requireAuth`, so a session user is always
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
