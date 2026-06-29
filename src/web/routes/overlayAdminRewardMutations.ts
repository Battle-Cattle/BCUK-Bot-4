import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import { csrfProtection } from '../csrf';
import { requireAuth } from '../middleware';
import { upsertReward, setRewardVideos, deleteReward } from '../../db';
import { parsePositiveIntId } from './shared';
import { requireStreamer, toStringArray, parseWeight } from './overlayAdminShared';

const log = createLogger('OverlayAdminReward');
export const router = Router();

/**
 * POST /overlay/settings/rewards — creates or updates a reward assignment,
 * linking a Twitch custom reward (by UUID) to a weighted set of overlay videos.
 * @param req - Express request; reads `twitch_reward_id`, `video_ids`, and
 *   `weight_<videoId>` fields from `req.body`.
 * @param res - Express response; redirects to `/overlay/settings?success=reward_saved`
 *   on success, or to `/overlay/settings?error=<code>` if the requester isn't a
 *   streamer (`not_a_streamer`), the reward ID isn't a valid UUID
 *   (`invalid_reward_id`), no videos were selected (`no_videos_selected`), or
 *   saving fails (`save_failed`).
 */
router.post('/settings/rewards', requireAuth, csrfProtection, async (req, res) => {
  try {
    const streamer = await requireStreamer(req, res);
    if (!streamer) return;

    const body = req.body as Record<string, string | string[] | undefined>;
    const twitchRewardId = (typeof body.twitch_reward_id === 'string' ? body.twitch_reward_id : '').trim();

    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(twitchRewardId)) {
      return res.redirect('/overlay/settings?error=invalid_reward_id');
    }

    const videoIds = toStringArray(body.video_ids).map(Number).filter((n) => Number.isInteger(n) && n > 0);

    if (videoIds.length === 0) return res.redirect('/overlay/settings?error=no_videos_selected');

    const rewardId = await upsertReward(streamer.id, twitchRewardId);
    await setRewardVideos(
      rewardId,
      streamer.id,
      videoIds.map((videoId) => ({ videoId, weight: parseWeight(body[`weight_${videoId}`]) })),
    );

    res.redirect('/overlay/settings?success=reward_saved');
  } catch (err) {
    log.error('Overlay reward save error:', err);
    res.redirect('/overlay/settings?error=save_failed');
  }
});

/**
 * POST /overlay/settings/rewards/:id/delete — deletes a reward assignment
 * belonging to the requesting streamer.
 * @param req - Express request; reads the `id` route param.
 * @param res - Express response; redirects to `/overlay/settings?success=reward_deleted`
 *   on success, or to `/overlay/settings?error=<code>` if the requester isn't a
 *   streamer (`not_a_streamer`), `id` is malformed (`invalid_id`), or the delete
 *   fails (`delete_failed`).
 */
router.post('/settings/rewards/:id/delete', requireAuth, csrfProtection, async (req, res) => {
  try {
    const streamer = await requireStreamer(req, res);
    if (!streamer) return;

    const rewardId = parsePositiveIntId(req.params.id);
    if (rewardId === null) return res.redirect('/overlay/settings?error=invalid_id');

    await deleteReward(rewardId, streamer.id);
    res.redirect('/overlay/settings?success=reward_deleted');
  } catch (err) {
    log.error('Overlay reward delete error:', err);
    res.redirect('/overlay/settings?error=delete_failed');
  }
});
