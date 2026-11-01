import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import { csrfProtection } from '../csrf';
import { requireAuth } from '../middleware';
import { saveRewardWithVideos, deleteReward } from '../../db';
import { MAX_INT_COLUMN_VALUE, parseIntField, parsePositiveIntId, parseRewardIdParam, trimField, toStringArray } from './validation';
import { requireStreamer } from './viewHelpers';
import { logAndRedirectError } from './errorHandling';
import { NOT_A_STREAMER_REDIRECT } from './overlayAdminShared';

const log = createLogger('OverlayAdminReward');
export const router = Router();

/**
 * Reads each selected video's `weight_<videoId>` field. A blank or missing weight means 1; anything
 * else must be a whole number from 1 up to what the `INT` column holds.
 * @param body - The submitted form body.
 * @param videoIds - The selected video ids.
 * @returns Each video with its weight, or null if any weight isn't a valid whole number.
 */
function parseVideoWeights(
  body: Record<string, string | string[] | undefined>,
  videoIds: number[],
): { videoId: number; weight: number }[] | null {
  const videos: { videoId: number; weight: number }[] = [];
  for (const videoId of videoIds) {
    const raw = body[`weight_${videoId}`];
    const weight = raw === undefined || raw === '' ? 1 : parseIntField(raw, 1, MAX_INT_COLUMN_VALUE);
    if (weight === null) return null;
    videos.push({ videoId, weight });
  }
  return videos;
}

/**
 * POST /overlay/settings/rewards — creates or updates a reward assignment,
 * linking a Twitch custom reward (by UUID) to a weighted set of overlay videos.
 * @param req - Express request; reads `twitch_reward_id`, `video_ids`, and
 *   `weight_<videoId>` fields from `req.body`.
 * @param res - Express response; redirects to `/overlay/settings?success=reward_saved`
 *   on success, or to `/overlay/settings?error=<code>` if the requester isn't a
 *   streamer (`not_a_streamer`), the reward ID isn't a valid UUID
 *   (`invalid_reward_id`), no videos were selected (`no_videos_selected`), a weight
 *   isn't a whole number of at least 1 (`invalid_weight`), or
 *   saving fails (`save_failed`).
 */
router.post('/settings/rewards', requireAuth, csrfProtection, async (req, res) => {
  try {
    const streamer = await requireStreamer(req, res, NOT_A_STREAMER_REDIRECT);
    if (!streamer) return;

    const body = req.body as Record<string, string | string[] | undefined>;
    const rawTwitchRewardId = trimField(body.twitch_reward_id);
    const twitchRewardId = parseRewardIdParam(rawTwitchRewardId);

    if (twitchRewardId === null) {
      return res.redirect('/overlay/settings?error=invalid_reward_id');
    }

    const videoIds = toStringArray(body.video_ids).map(Number).filter((n) => Number.isInteger(n) && n > 0);

    if (videoIds.length === 0) return res.redirect('/overlay/settings?error=no_videos_selected');
    const videos = parseVideoWeights(body, videoIds);
    if (videos === null) return res.redirect('/overlay/settings?error=invalid_weight');

    // One transaction: a failed video replacement (e.g. a tampered video id) also rolls back a
    // newly created reward row instead of leaving it behind with no videos.
    await saveRewardWithVideos(streamer.id, twitchRewardId, videos);

    res.redirect('/overlay/settings?success=reward_saved');
  } catch (err) {
    logAndRedirectError({ res, log, logLabel: 'Overlay reward save error:', err, basePath: '/overlay/settings', errorCode: 'save_failed' });
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
    const streamer = await requireStreamer(req, res, NOT_A_STREAMER_REDIRECT);
    if (!streamer) return;

    const rewardId = parsePositiveIntId(req.params.id);
    if (rewardId === null) return res.redirect('/overlay/settings?error=invalid_id');

    await deleteReward(rewardId, streamer.id);
    res.redirect('/overlay/settings?success=reward_deleted');
  } catch (err) {
    logAndRedirectError({ res, log, logLabel: 'Overlay reward delete error:', err, basePath: '/overlay/settings', errorCode: 'delete_failed' });
  }
});
