import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import { csrfProtection } from '../csrf';
import { requireAuth } from '../middleware';
import { getStreamerByDiscordId } from '../../db';
import type { DbStreamerEventSub } from '../../db';
import { getVideosForStreamer, getRewardsForStreamer } from '../../db';
import { PUBLIC_URL } from '../../shared/config';
import { getCustomRewards, TwitchCustomReward } from '../../twitch/twitchApi';
import { getValidToken } from '../../twitch/eventsub/twitchApiEventSub';
import { filterQueryParam } from './shared';
import { router as mutationsRouter, MAX_UPLOAD_MB } from './overlayAdminMutations';
import { router as rewardMutationsRouter } from './overlayAdminRewardMutations';

const log = createLogger('OverlayAdmin');
const router = Router();

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
    const streamer = await getStreamerByDiscordId(req.session.user!.discordId);
    const [videos, rewards, twitchRewards] = streamer
      ? await Promise.all([
          getVideosForStreamer(streamer.id),
          getRewardsForStreamer(streamer.id),
          fetchTwitchRewards(streamer),
        ])
      : [[], [], []];

    res.render('overlayAdmin', {
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
    res.status(500).render('error', { message: 'Failed to load overlay settings.', user: req.session.user ?? null, csrfToken: '' });
  }
});

router.use(mutationsRouter);
router.use(rewardMutationsRouter);

export default router;
