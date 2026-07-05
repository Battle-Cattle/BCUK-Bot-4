import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import { csrfProtection } from '../csrf';
import { requireAuth } from '../middleware';
import { updatePricingCooldownForReward } from '../../db';
import { createCustomReward, updateCustomReward } from '../../twitch/twitchApi';
import { getValidToken } from '../../twitch/eventsub/twitchApiEventSub';
import { logAndRedirectError } from './shared';
import {
  requireStreamer, parseRewardIdParam, parseRewardFields, effectiveCooldownSeconds, handleRewardDeleteAction,
} from './channelPointsAdminShared';
import { deleteRewardAndPricing } from '../../twitch/pricing/rewardPricingService';
import { router as pricingMutationsRouter } from './channelPointsAdminPricingMutations';

const log = createLogger('ChannelPointsAdminMutations');
export const router = Router();

/**
 * POST /channel-points/rewards — creates a new custom reward on Twitch.
 * @param req - Express request; reads the full reward field set (see `parseRewardFields`) from `req.body`.
 * @param res - Express response; redirects to `/channel-points?success=reward_created` on success,
 *   or to `/channel-points?error=<code>` if the requester isn't a streamer (`not_a_streamer`),
 *   a field is invalid (`invalid_reward_fields`), or creation fails (`create_failed`, including
 *   a 403/401 from Twitch — e.g. channel points unavailable, or the connection needs reconnecting).
 */
router.post('/rewards', requireAuth, csrfProtection, async (req, res) => {
  try {
    const streamer = await requireStreamer(req, res);
    if (!streamer) return;

    const input = parseRewardFields(req.body as Record<string, string | string[] | undefined>);
    if (!input) return res.redirect('/channel-points?error=invalid_reward_fields');

    const token = streamer.twitch_user_id ? await getValidToken(streamer) : null;
    if (!streamer.twitch_user_id || !token) return res.redirect('/channel-points?error=create_failed');

    await createCustomReward(streamer.twitch_user_id, token, input);

    res.redirect('/channel-points?success=reward_created');
  } catch (err) {
    logAndRedirectError({ res, log, logLabel: 'Reward create error:', err, basePath: '/channel-points', errorCode: 'create_failed' });
  }
});

/**
 * POST /channel-points/rewards/:twitchRewardId — updates an existing custom reward's fields
 * on Twitch. Only succeeds for rewards created by this app — Twitch returns 403 otherwise.
 * @param req - Express request; reads the `twitchRewardId` route param and the full reward
 *   field set (see `parseRewardFields`) from `req.body`.
 * @param res - Express response; redirects to `/channel-points?success=reward_updated` on success,
 *   or to `/channel-points?error=<code>` if the requester isn't a streamer (`not_a_streamer`),
 *   the reward ID isn't a valid UUID (`invalid_reward_id`), a field is invalid
 *   (`invalid_reward_fields`), or the update fails (`update_failed`, including a 403 for a
 *   reward this app didn't create, or a 401 needing reconnection).
 */
router.post('/rewards/:twitchRewardId', requireAuth, csrfProtection, async (req, res) => {
  try {
    const streamer = await requireStreamer(req, res);
    if (!streamer) return;

    const twitchRewardId = parseRewardIdParam(req.params.twitchRewardId);
    if (twitchRewardId === null) return res.redirect('/channel-points?error=invalid_reward_id');

    const input = parseRewardFields(req.body as Record<string, string | string[] | undefined>);
    if (!input) return res.redirect('/channel-points?error=invalid_reward_fields');

    const token = streamer.twitch_user_id ? await getValidToken(streamer) : null;
    if (!streamer.twitch_user_id || !token) return res.redirect('/channel-points?error=update_failed');

    const updated = await updateCustomReward(streamer.twitch_user_id, twitchRewardId, token, input);

    // Best-effort: if the reward's Twitch cooldown changed, keep any existing pricing config's
    // cooldown_seconds mirroring it (no-ops if no pricing config exists for this reward).
    try {
      await updatePricingCooldownForReward(streamer.id, twitchRewardId, effectiveCooldownSeconds(updated));
    } catch (err) {
      log.warn('Failed to sync pricing cooldown after reward edit:', err);
    }

    res.redirect('/channel-points?success=reward_updated');
  } catch (err) {
    logAndRedirectError({ res, log, logLabel: 'Reward update error:', err, basePath: '/channel-points', errorCode: 'update_failed' });
  }
});

/**
 * POST /channel-points/rewards/:twitchRewardId/delete — deletes a custom reward from Twitch
 * entirely (see `deleteRewardAndPricing`), along with any dynamic pricing config for it. Only
 * succeeds for rewards created by this app — Twitch returns 403 otherwise. Use
 * `/rewards/:twitchRewardId/pricing/delete` instead to turn off dynamic pricing while keeping
 * the reward itself on Twitch.
 * @param req - Express request; reads the `twitchRewardId` route param.
 * @param res - Express response; redirects to `/channel-points?success=reward_deleted` on success,
 *   or to `/channel-points?error=<code>` if the requester isn't a streamer (`not_a_streamer`),
 *   the reward ID isn't a valid UUID (`invalid_reward_id`), or the delete fails (`delete_failed`).
 */
router.post('/rewards/:twitchRewardId/delete', requireAuth, csrfProtection, (req, res) =>
  handleRewardDeleteAction(
    req, res,
    (streamer, twitchRewardId) => deleteRewardAndPricing(streamer.id, twitchRewardId),
    { log, successCode: 'reward_deleted', errorLogLabel: 'Reward delete error:', errorCode: 'delete_failed' },
  ));

// Pricing config and pricing-settings routes live in their own module to keep this file scoped
// to reward CRUD — see channelPointsAdminPricingMutations.ts.
router.use(pricingMutationsRouter);
