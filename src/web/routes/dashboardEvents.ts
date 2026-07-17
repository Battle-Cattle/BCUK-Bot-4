import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import type { StreamerEventType } from '../../db';
import { getStreamerByDiscordId, getRecentStreamerEvents } from '../../db';
import { DASHBOARD_EVENTS_MAX_SSE_PER_STREAMER } from '../../shared/config';
import { getSessionUser } from '../session';
import { createStreamerSseEventsHandler, broadcastToChannel } from './sseChannel';

const log = createLogger('DashboardEvents');
const router = Router();

// Dashboard only ever displays the latest ~20 events — shared by dashboard.ts's initial-load
// query and this file's own reconnect-recovery fallback below, so both stay in sync.
export const RECENT_EVENTS_LIMIT = 20;

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

/**
 * GET /dashboard/events/recent — JSON fallback for the "Recent Events" feed's live client,
 * used after an SSE reconnect to resync any events missed while disconnected (the SSE
 * handshake itself sends no state, only a live push on the next new event). Mounted behind
 * the parent router's `requireAuth`, so a session user is always present.
 * @param req - Express request; reads `req.session.user`.
 * @param res - Express response; JSON `{ ok: true, events }` on success, 403 if the session
 *   user isn't a monitored streamer, or 500 (logged) on an unexpected lookup failure.
 */
router.get('/events/recent', async (req, res) => {
  let streamer;
  try {
    streamer = await getStreamerByDiscordId(getSessionUser(req).discordId);
  } catch (err) {
    log.error('Failed to resolve streamer for recent events:', err);
    res.status(500).json({ ok: false });
    return;
  }
  if (!streamer) {
    res.status(403).json({ ok: false });
    return;
  }

  const events = await getRecentStreamerEvents(streamer.id, RECENT_EVENTS_LIMIT);
  const dashboardEvents: DashboardEvent[] = events.map((e) => ({
    eventType: e.eventType, displayName: e.displayName, detail: e.detail, occurredAt: e.occurredAt.toISOString(),
  }));
  res.json({ ok: true, events: dashboardEvents });
});

export default router;
