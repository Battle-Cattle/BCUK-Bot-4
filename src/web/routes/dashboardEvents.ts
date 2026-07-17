import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import type { StreamerEventType } from '../../db';
import { DASHBOARD_EVENTS_MAX_SSE_PER_STREAMER } from '../../shared/config';
import { createStreamerSseEventsHandler, broadcastToChannel } from './sseChannel';

const log = createLogger('DashboardEvents');
const router = Router();

/** A live streamer activity event, pushed to the dashboard's "Recent Events" feed. */
export interface DashboardEvent {
  eventType: StreamerEventType;
  displayName: string;
  detail: string | null;
  occurredAt: string;
}

// In-memory map of active SSE connections keyed by streamer DB ID.
export const connections = new Map<number, Set<import('express').Response>>();

export const MAX_SSE_CONNECTIONS_PER_STREAMER = DASHBOARD_EVENTS_MAX_SSE_PER_STREAMER;

/** Push a streamer activity event to every open dashboard page for this streamer. */
export function pushDashboardEvent(streamerId: number, event: DashboardEvent): void {
  broadcastToChannel(connections, streamerId, event);
}

/**
 * GET /dashboard/events — SSE endpoint streaming live `pushDashboardEvent` activity (follows,
 * subs, raids, redemptions) for the logged-in streamer's own channel, so the dashboard's
 * "Recent Events" feed can update without a manual refresh. Mounted behind the parent router's
 * `requireAuth`, so a session user is always present. Built via
 * {@link createStreamerSseEventsHandler} — see there for the shared resolve/403/500/429
 * lifecycle.
 */
router.get('/events', createStreamerSseEventsHandler({
  connections, maxPerChannel: MAX_SSE_CONNECTIONS_PER_STREAMER, resolveKey: (streamer) => streamer.id, log,
}));

export default router;
