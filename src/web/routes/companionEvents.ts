import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import { requireCompanionKey } from '../middleware';
import { COMPANION_MAX_SSE_PER_TOKEN } from '../../shared/config';
import type { StreamerEventType } from '../../db';
import { getStreamerByDiscordId, getRecentStreamerEvents, getTokenStatus } from '../../db';
import { RECENT_EVENTS_LIMIT } from './dashboardEvents';
import { attachSseConnection, broadcastToChannel } from './sseChannel';

const log = createLogger('CompanionEvents');
const router = Router();

/** Non-redemption streamer activity types forwarded to the companion app. */
export type CompanionActivityEventType = Exclude<StreamerEventType, 'redemption'>;

/** A channel-point reward redemption forwarded to a user's companion app. */
export interface CompanionRedemptionEvent {
  type: 'channel_points_redemption';
  rewardId: string;
  rewardTitle: string;
  userLogin: string;
  userName: string;
  userInput: string;
  redeemedAt: string;
}

/** A follow/sub/resub/giftsub/raid activity event forwarded to a user's companion app. */
export interface CompanionActivityEvent {
  type: CompanionActivityEventType;
  displayName: string;
  detail: string | null;
  occurredAt: string;
}

/** An event forwarded to a user's companion app over the `/api/companion/events` SSE stream. */
export type CompanionEvent = CompanionRedemptionEvent | CompanionActivityEvent;

// In-memory map of active SSE connections keyed by Discord ID.
export const connections = new Map<string, Set<import('express').Response>>();

export const MAX_SSE_CONNECTIONS_PER_TOKEN = COMPANION_MAX_SSE_PER_TOKEN;

/** Push a companion event to all of a Discord user's connected companion app instances. */
export function pushCompanionEvent(discordId: string, event: CompanionEvent): void {
  const remaining = broadcastToChannel(connections, discordId, event);
  if (remaining !== null) log.info(`Pushed companion event to ${remaining} client(s) for discord ${discordId}`);
}

/**
 * Ends every open companion SSE connection for a Discord user, so a just-revoked token stops
 * receiving events immediately instead of continuing to stream to a connection that was
 * authenticated (via `requireCompanionKey`) before the revoke — auth is only checked once, at
 * connect time, so without this an already-open stream would otherwise keep delivering events
 * until the client happens to disconnect on its own. `res.end()` triggers the same `close`-event
 * cleanup path `attachSseConnection` already wires up (clearing the keepalive, releasing the
 * global connection slot, evicting the entry from `connections`), so no separate bookkeeping is
 * needed here. Called from the `/companion-key/revoke` route after the DB revoke succeeds.
 * @param discordId - Discord snowflake whose companion connections should be torn down.
 */
export function disconnectCompanionConnections(discordId: string): void {
  const clients = connections.get(discordId);
  if (!clients) return;
  for (const res of Array.from(clients)) {
    try {
      res.end();
    } catch (err) {
      log.error(`Failed to close a companion connection for discord ${discordId}:`, err);
    }
  }
}

/**
 * GET /api/companion/events — SSE endpoint, bearer-token authenticated via
 * `requireCompanionKey`. Streams companion events for the authenticated Discord
 * user until the client disconnects, sending a keepalive ping every 25s and
 * capping concurrent connections per user at `MAX_SSE_CONNECTIONS_PER_TOKEN`.
 *
 * `requireCompanionKey`'s token check and this handler's connection admission aren't atomic —
 * a revoke landing in that gap (e.g. via `/companion-key/revoke`, which only closes connections
 * already registered at the moment it runs) would otherwise leave a newly-admitted connection
 * open indefinitely, since nothing re-checks the token afterward. Closes that race by
 * re-verifying the token immediately after attaching, and ending the connection if it was
 * revoked in that window; best-effort (a failed re-check is logged, not fatal to the connection),
 * since it narrows an already-narrow race rather than guarding a required invariant.
 * @param req - Express request; `req.companionDiscordId` is set by `requireCompanionKey`.
 * @param res - Express response; upgraded to a `text/event-stream` connection by
 *   `attachSseConnection`, kept alive with periodic pings and torn down on client disconnect.
 */
router.get('/events', requireCompanionKey, async (req, res) => {
  const discordId = req.companionDiscordId!;
  const attached = attachSseConnection(req, res, { connections, key: discordId, maxPerChannel: MAX_SSE_CONNECTIONS_PER_TOKEN });
  if (!attached) return;

  try {
    const status = await getTokenStatus(discordId);
    if (!status?.hasToken) res.end();
  } catch (err) {
    log.error(`Failed to re-verify companion token for discord ${discordId} after connecting:`, err);
  }
});

/**
 * GET /api/companion/events/recent — JSON fallback used after an SSE reconnect to resync any
 * activity events missed while disconnected (the SSE handshake itself sends no state, only a
 * live push on the next new event). Bearer-token authenticated via `requireCompanionKey`.
 * Redemptions are excluded: `streamer_event_log` only retains a plain display name/detail for
 * them, not the richer fields (`rewardId`, `userInput`, etc.) the live
 * `channel_points_redemption` push carries, so replaying them would require a third, degraded
 * shape distinct from the live one.
 * Always sends `Cache-Control: no-store`, since the response is identity-scoped activity data.
 * @param req - Express request; `req.companionDiscordId` is set by `requireCompanionKey`.
 * @param res - Express response; JSON `{ ok: true, events }` (empty if the Discord user has no
 *   linked streamer) on success, or 500 (logged) if the streamer or recent-events lookup fails.
 */
router.get('/events/recent', requireCompanionKey, async (req, res) => {
  // Identity-scoped activity data — never let a shared/browser cache reuse one user's response
  // for another (or for the same user after they revoke/reissue their companion token).
  res.set('Cache-Control', 'no-store');

  const discordId = req.companionDiscordId!;
  let streamer;
  try {
    streamer = await getStreamerByDiscordId(discordId);
  } catch (err) {
    log.error('Failed to resolve streamer for companion recent events:', err);
    res.status(500).json({ ok: false });
    return;
  }
  if (!streamer) {
    res.json({ ok: true, events: [] });
    return;
  }

  try {
    const events = await getRecentStreamerEvents(streamer.id, RECENT_EVENTS_LIMIT);
    const companionEvents: CompanionActivityEvent[] = events
      .filter((e) => e.eventType !== 'redemption')
      .map((e) => ({
        type: e.eventType as CompanionActivityEventType, displayName: e.displayName, detail: e.detail, occurredAt: e.occurredAt.toISOString(),
      }));
    res.json({ ok: true, events: companionEvents });
  } catch (err) {
    log.error('Failed to load recent companion events:', err);
    res.status(500).json({ ok: false });
  }
});

export default router;
