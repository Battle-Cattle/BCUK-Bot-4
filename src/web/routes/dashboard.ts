import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import { getStatus } from '../../shared/statusStore';
import { csrfProtection } from '../csrf';
import {
  getStreamerByDiscordId, getSfxTriggerCount, getCustomCommandCount, getCounterCount, getRecentStreamerEvents,
} from '../../db';
import { hasAuthFailedSubs } from '../../twitch/eventsub/twitchEventSubSubscriptions';
import { renderError, renderView } from './shared';

const log = createLogger('Web');
const router = Router();

// Matches the payload shape pushed live over the /dashboard/events SSE stream, so the
// client can render the initial-load list and live updates with the same code path.
const RECENT_EVENTS_LIMIT = 20;

/**
 * GET / — renders the main dashboard page. Includes overall bot status, usage-stat
 * summary counts, and, for logged-in users with a connected Twitch streamer, their
 * recent activity feed (follows/subs/raids/redemptions) and whether their EventSub
 * subscriptions need reconnecting (auth failed).
 * @param req - Express request; reads `req.session.user` if present.
 * @param res - Express response; renders the `dashboard` view on success, or a
 *   500 error page if loading status/streamer data fails.
 */
router.get('/', csrfProtection, async (req, res) => {
  try {
    const status = getStatus(req.session.user?.currentGuildId ?? null);
    const [sfxCount, commandCount, counterCount] = await Promise.all([
      getSfxTriggerCount(), getCustomCommandCount(), getCounterCount(),
    ]);
    let needsReconnect = false;
    let hasStreamer = false;
    let recentEvents: Array<{ eventType: string; displayName: string; detail: string | null; occurredAt: string }> = [];
    if (req.session.user) {
      const streamer = await getStreamerByDiscordId(req.session.user.discordId);
      needsReconnect = !!(streamer?.eventsub_access_token && streamer.twitch_name && hasAuthFailedSubs(streamer.twitch_name));
      hasStreamer = !!streamer;
      if (streamer) {
        const events = await getRecentStreamerEvents(streamer.id, RECENT_EVENTS_LIMIT);
        recentEvents = events.map((e) => ({
          eventType: e.eventType, displayName: e.displayName, detail: e.detail, occurredAt: e.occurredAt.toISOString(),
        }));
      }
    }
    renderView(res, 'dashboard', {
      user: req.session.user,
      status,
      usageStats: { sfxCount, commandCount, counterCount },
      recentEvents,
      hasStreamer,
      csrfToken: req.csrfToken(),
      needsReconnect,
    });
  } catch (err) {
    log.error('Dashboard error:', err);
    renderError(res, 500, 'Failed to load dashboard data.', req.session.user);
  }
});

export default router;
