import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import { getGuildScopedStatus } from '../guildScopedStatus';
import { csrfProtection } from '../csrf';
import { getStreamerByDiscordId, getSfxTriggerCount, getCustomCommandCount, getCounterCount, getRecentStreamerEvents } from '../../db';
import { hasAuthFailedSubs } from '../../twitch/eventsub/twitchEventSubSubscriptions';
import { renderError, renderView } from './shared';
import { RECENT_EVENTS_LIMIT, type DashboardEvent } from './dashboardEvents';

const log = createLogger('Web');
const router = Router();

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
    const status = await getGuildScopedStatus(req.session.user?.currentGuildId ?? null);
    const [sfxCount, commandCount, counterCount, streamer] = await Promise.all([
      getSfxTriggerCount(), getCustomCommandCount(), getCounterCount(),
      req.session.user ? getStreamerByDiscordId(req.session.user.discordId) : Promise.resolve(null),
    ]);

    const needsReconnect = !!(streamer?.eventsub_access_token && streamer.twitch_name && hasAuthFailedSubs(streamer.twitch_name));
    const hasStreamer = !!streamer;
    let recentEvents: DashboardEvent[] = [];
    if (streamer) {
      const events = await getRecentStreamerEvents(streamer.id, RECENT_EVENTS_LIMIT);
      recentEvents = events.map((e) => ({
        eventType: e.eventType, displayName: e.displayName, detail: e.detail, occurredAt: e.occurredAt.toISOString(),
      }));
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
