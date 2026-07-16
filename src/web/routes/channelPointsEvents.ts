import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import { getStreamerByDiscordId } from '../../db';
import { CHANNEL_POINTS_MAX_SSE_PER_STREAMER } from '../../shared/config';
import { getSessionUser } from '../session';
import { attachSseConnection } from './sseChannel';

const log = createLogger('ChannelPointsEvents');
const router = Router();

/** A live price/demand update for one reward, pushed to the Channel Points admin page. */
export interface PricingUpdateEvent {
  rewardId: string;
  cost: number;
  demand: number;
  recordedAt: number;
}

// In-memory map of active SSE connections keyed by streamer DB ID.
export const connections = new Map<number, Set<import('express').Response>>();

export const MAX_SSE_CONNECTIONS_PER_STREAMER = CHANNEL_POINTS_MAX_SSE_PER_STREAMER;

/** Push a reward price/demand update to every open Channel Points admin page for this streamer. */
export function pushPricingUpdate(streamerId: number, event: PricingUpdateEvent): void {
  const clients = connections.get(streamerId);
  if (!clients || clients.size === 0) return;
  const payload = JSON.stringify(event);
  const dead: import('express').Response[] = [];
  for (const res of clients) {
    try {
      res.write(`data: ${payload}\n\n`);
    } catch {
      dead.push(res);
    }
  }
  for (const res of dead) clients.delete(res);
  if (clients.size === 0) connections.delete(streamerId);
}

/**
 * GET /channel-points/events — SSE endpoint streaming live `pushPricingUpdate` price/demand
 * points for the logged-in streamer's own rewards, so the Channel Points admin page's price
 * history charts can update without a manual refresh. Mounted behind the parent router's
 * `requireAuth`, so a session user is always present; still resolves the streamer row here
 * (rather than trusting a cached id) so a revoked streamer record takes effect immediately.
 * @param req - Express request; reads `req.session.user`.
 * @param res - Express response; upgrades to a `text/event-stream` connection kept alive with
 *   periodic pings and torn down on client disconnect; replies 403 if the session user isn't a
 *   monitored streamer, 429 if the streamer's connection limit is exceeded, or 500 on an
 *   unexpected lookup failure (also logged, unlike a plain unhandled rejection).
 */
router.get('/events', async (req, res) => {
  let streamer;
  try {
    streamer = await getStreamerByDiscordId(getSessionUser(req).discordId);
  } catch (err) {
    log.error('Failed to resolve streamer for SSE events:', err);
    res.status(500).end();
    return;
  }
  if (!streamer) {
    res.status(403).end();
    return;
  }

  attachSseConnection(req, res, { connections, key: streamer.id, maxPerChannel: MAX_SSE_CONNECTIONS_PER_STREAMER });
});

export default router;
