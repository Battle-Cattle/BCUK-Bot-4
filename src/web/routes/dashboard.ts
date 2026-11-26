import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import { getGuildScopedStatus } from '../guildScopedStatus';
import { getLiveAccessForRequest } from '../guildAccess';
import { normalizeTwitchChannelName } from '../../twitch/twitchChannelName';
import { csrfProtection } from '../csrf';
import { getStreamerByDiscordId, getSfxTriggerCount, getCustomCommandCount, getCounterCount, getRecentStreamerEvents } from '../../db';
import { hasAuthFailedSubs } from '../../twitch/eventsub/twitchEventSubCreate';
import { renderView } from './viewHelpers';
import { renderOrError } from './errorHandling';
import { RECENT_EVENTS_LIMIT, type DashboardEvent } from './dashboardEvents';

const log = createLogger('Web');
const router = Router();

/**
 * GET / — renders the main dashboard page. Includes overall bot status, usage-stat
 * summary counts, and, for logged-in users with a connected Twitch streamer, their
 * recent activity feed (follows/subs/raids/redemptions) and whether their EventSub
 * subscriptions need reconnecting (auth failed). Also passes the signed-in user's own
 * normalised Twitch login (`ownChannel`) so the page can tell "Your channel" from the others
 * in Stream Overview; that login is the user's own, already visible to the guild in the status payload.
 * @param req - Express request; reads `req.session.user` if present.
 * @param res - Express response; renders the `dashboard` view on success, or a
 *   500 error page if loading status/streamer data fails.
 */
router.get('/', csrfProtection, async (req, res) => {
  await renderOrError({ res, log, logLabel: 'Dashboard error:', sessionUser: req.session.user, errorMessage: 'Failed to load dashboard data.' }, async () => {
    const currentGuildId = req.session.user?.currentGuildId ?? null;
    const [status, sfxCount, commandCount, counterCount, streamer, access] = await Promise.all([
      getGuildScopedStatus(currentGuildId),
      getSfxTriggerCount(), getCustomCommandCount(),
      // Counters are per-guild (unlike SFX/custom commands, which are global) — 0 when no
      // guild is selected (e.g. not logged in) rather than querying with a null guild id.
      currentGuildId ? getCounterCount(currentGuildId) : Promise.resolve(0),
      req.session.user ? getStreamerByDiscordId(req.session.user.discordId) : Promise.resolve(null),
      // The live user row requireAuth already read for this request (memoised per request, so no extra query). Its
      // twitch_name is used rather than the streamer record's, which a member with a twitch_name but no streamer row lacks.
      req.session.user ? getLiveAccessForRequest(req, req.session.user.discordId) : Promise.resolve(null),
    ]);
    const ownChannel = access?.dbUser.twitch_name ? normalizeTwitchChannelName(access.dbUser.twitch_name) : null;

    const needsReconnect = !!(streamer?.eventsub_access_token && streamer.twitch_name && hasAuthFailedSubs(streamer.twitch_name));
    const hasStreamer = !!streamer;
    let recentEvents: DashboardEvent[] = [];
    if (streamer) {
      const events = await getRecentStreamerEvents(streamer.id, RECENT_EVENTS_LIMIT);
      recentEvents = events.map((e) => ({
        id: e.id, eventType: e.eventType, displayName: e.displayName, detail: e.detail, occurredAt: e.occurredAt.toISOString(),
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
      ownChannel,
    });
  });
});

export default router;
