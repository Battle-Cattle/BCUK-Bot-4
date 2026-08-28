import { createLogger } from '../../shared/logger';
import { Router, type Response } from 'express';
import { csrfProtection } from '../csrf';
import { requireAuth } from '../middleware';
import { getSessionUser } from '../session';
import { getStreamerByDiscordId } from '../../db';
import type { DbStreamerEventSub } from '../../db';
import { getVideosForStreamer, getRewardsForStreamer } from '../../db';
import { PUBLIC_URL, OVERLAY_STATUS_MAX_SSE_PER_STREAMER } from '../../shared/config';
import { getCustomRewards, TwitchCustomReward } from '../../twitch/twitchApi';
import { getValidToken } from '../../twitch/eventsub/twitchApiEventSub';
import { filterQueryParam } from './validation';
import { renderError, renderView } from './viewHelpers';
import { router as mutationsRouter, MAX_UPLOAD_MB } from './overlayAdminMutations';
import { router as rewardMutationsRouter } from './overlayAdminRewardMutations';
import { connections as overlaySourceConnections } from './overlaySource';
import { attachSseConnection, broadcastToChannel } from './sseChannel';

const log = createLogger('OverlayAdmin');
const router = Router();

// How often the settings-page SSE stream re-checks whether the overlay browser source is open.
const STATUS_POLL_INTERVAL_MS = 3000;

// In-memory map of active `/settings/events` SSE connections, keyed by streamer ID.
export const statusConnections = new Map<number, Set<Response>>();

const KNOWN_ERRORS = new Set([
  'not_a_streamer', 'invalid_file', 'upload_failed', 'delete_failed',
  'invalid_reward_id', 'no_videos_selected', 'save_failed', 'invalid_id', 'invalid_path',
  'file_too_large',
]);
const KNOWN_SUCCESSES = new Set([
  'video_uploaded', 'video_deleted', 'reward_saved', 'reward_deleted',
]);

async function fetchTwitchRewards(streamer: DbStreamerEventSub): Promise<TwitchCustomReward[]> {
  if (!streamer.twitch_user_id) return [];
  const token = await getValidToken(streamer);
  if (!token) return [];
  try {
    return await getCustomRewards(streamer.twitch_user_id, token);
  } catch (err) {
    log.warn('Failed to fetch Twitch custom rewards:', err);
    return [];
  }
}

/**
 * GET /overlay/settings — renders the overlay settings page with the user's
 * uploaded videos, configured rewards, and live Twitch custom rewards (if the
 * user is a streamer).
 * @param req - Express request; reads `req.session.user`, `error`, and
 *   `success` query params.
 * @param res - Express response; renders the `overlayAdmin` view, or a 500
 *   error page if loading settings fails.
 */
router.get('/settings', requireAuth, csrfProtection, async (req, res) => {
  try {
    const streamer = await getStreamerByDiscordId(getSessionUser(req).discordId);
    const [videos, rewards, twitchRewards] = streamer
      ? await Promise.all([
          getVideosForStreamer(streamer.id),
          getRewardsForStreamer(streamer.id),
          fetchTwitchRewards(streamer),
        ])
      : [[], [], []];

    renderView(res, 'overlayAdmin', {
      user: req.session.user,
      csrfToken: req.csrfToken(),
      streamer: streamer ?? null,
      videos,
      rewards,
      twitchRewards,
      baseUrl: PUBLIC_URL,
      maxFileMb: MAX_UPLOAD_MB,
      error:   filterQueryParam(req.query.error,   KNOWN_ERRORS),
      success: filterQueryParam(req.query.success, KNOWN_SUCCESSES),
    });
  } catch (err) {
    log.error('Overlay settings page error:', err);
    renderError(res, 500, 'Failed to load overlay settings.', req.session.user);
  }
});

/**
 * GET /overlay/controller/settings — renders the controller overlay info page
 * (the OBS browser-source URL and setup notes for the gamepad overlay).
 * @param req - Express request; reads `req.session.user`.
 * @param res - Express response; renders the `controllerAdmin` view.
 */
router.get('/controller/settings', requireAuth, csrfProtection, (req, res) => {
  renderView(res, 'controllerAdmin', {
    user: req.session.user,
    csrfToken: req.csrfToken(),
    baseUrl: PUBLIC_URL,
  });
});

/**
 * GET /overlay/settings/events — SSE endpoint streaming `{ connected: boolean }` snapshots of
 * whether the logged-in user's own reward-video browser source currently has an open connection,
 * so the settings page can show a live status dot instead of the user only finding out something's
 * wrong when a reward video never plays. Polls the shared `overlaySource` connections map on an
 * interval rather than reacting to a push event, since opening/closing that overlay's SSE
 * connection has no existing event to subscribe to.
 * @param req - Express request; reads `req.session.user`.
 * @param res - Express response; upgrades to a `text/event-stream` connection kept alive with
 *   periodic pings and torn down (including the status-poll interval) on client disconnect;
 *   replies 403 if the user isn't a monitored streamer with a linked Twitch channel, 500 (logged)
 *   if the streamer lookup fails, or 429 if the connection limit is exceeded.
 */
router.get('/settings/events', requireAuth, async (req, res) => {
  let streamer: DbStreamerEventSub | null;
  try {
    streamer = await getStreamerByDiscordId(getSessionUser(req).discordId);
  } catch (err) {
    log.error('Failed to resolve streamer for overlay status SSE:', err);
    res.status(500).end();
    return;
  }
  if (!streamer || !streamer.twitch_name) {
    res.status(403).end();
    return;
  }

  const attached = attachSseConnection(req, res, {
    connections: statusConnections,
    key: streamer.id,
    maxPerChannel: OVERLAY_STATUS_MAX_SSE_PER_STREAMER,
  });
  if (!attached) return;

  const streamerId = streamer.id;
  const login = streamer.twitch_name.toLowerCase();
  let lastConnected: boolean | null = null;

  const check = (): void => {
    const isConnected = (overlaySourceConnections.get(login)?.size ?? 0) > 0;
    if (isConnected === lastConnected) return;
    lastConnected = isConnected;
    broadcastToChannel(statusConnections, streamerId, { connected: isConnected });
  };

  check();
  const interval = setInterval(check, STATUS_POLL_INTERVAL_MS);
  req.on('close', () => clearInterval(interval));
});

router.use(mutationsRouter);
router.use(rewardMutationsRouter);

export default router;
