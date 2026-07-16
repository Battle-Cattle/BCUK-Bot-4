import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import { requireCompanionKey } from '../middleware';
import { COMPANION_MAX_SSE_PER_TOKEN } from '../../shared/config';
import { attachSseConnection, broadcastToChannel } from './sseChannel';

const log = createLogger('CompanionEvents');
const router = Router();

/** A channel-point reward redemption forwarded to a user's companion app. */
export interface CompanionEvent {
  type: 'channel_points_redemption';
  rewardId: string;
  rewardTitle: string;
  userLogin: string;
  userName: string;
  userInput: string;
  redeemedAt: string;
}

// In-memory map of active SSE connections keyed by Discord ID.
export const connections = new Map<string, Set<import('express').Response>>();

export const MAX_SSE_CONNECTIONS_PER_TOKEN = COMPANION_MAX_SSE_PER_TOKEN;

/** Push a companion event to all of a Discord user's connected companion app instances. */
export function pushCompanionEvent(discordId: string, event: CompanionEvent): void {
  const remaining = broadcastToChannel(connections, discordId, event);
  if (remaining !== null) log.info(`Pushed companion event to ${remaining} client(s) for discord ${discordId}`);
}

/**
 * GET /api/companion/events — SSE endpoint, bearer-token authenticated via
 * `requireCompanionKey`. Streams companion events for the authenticated Discord
 * user until the client disconnects, sending a keepalive ping every 25s and
 * capping concurrent connections per user at `MAX_SSE_CONNECTIONS_PER_TOKEN`.
 * @param req - Express request; `req.companionDiscordId` is set by `requireCompanionKey`.
 * @param res - Express response; upgraded to a `text/event-stream` connection by
 *   `attachSseConnection`, kept alive with periodic pings and torn down on client disconnect.
 */
router.get('/events', requireCompanionKey, (req, res) => {
  const discordId = req.companionDiscordId!;
  attachSseConnection(req, res, { connections, key: discordId, maxPerChannel: MAX_SSE_CONNECTIONS_PER_TOKEN });
});

export default router;
