import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import { CHANNEL_POINTS_MAX_SSE_PER_STREAMER } from '../../shared/config';
import { createStreamerSseEventsHandler, broadcastToChannel } from './sseChannel';

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
  broadcastToChannel(connections, streamerId, event);
}

/**
 * GET /channel-points/events — SSE endpoint streaming live `pushPricingUpdate` price/demand
 * points for the logged-in streamer's own rewards, so the Channel Points admin page's price
 * history charts can update without a manual refresh. Mounted behind the parent router's
 * `requireAuth`, so a session user is always present. Built via
 * {@link createStreamerSseEventsHandler} — see there for the shared resolve/403/500/429
 * lifecycle.
 */
router.get('/events', createStreamerSseEventsHandler({
  connections, maxPerChannel: MAX_SSE_CONNECTIONS_PER_STREAMER, resolveKey: (streamer) => streamer.id, log,
}));

export default router;
