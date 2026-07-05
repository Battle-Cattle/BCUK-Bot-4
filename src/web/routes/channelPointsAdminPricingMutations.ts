import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import { csrfProtection } from '../csrf';
import { requireAuth } from '../middleware';
import {
  upsertPricingConfig, savePricingSettingsForStreamer, getPricingForReward,
  DEFAULT_PRICING_COOLDOWN_SECONDS, DbStreamerEventSub,
} from '../../db';
import { getCustomRewards } from '../../twitch/twitchApi';
import { getValidToken } from '../../twitch/eventsub/twitchApiEventSub';
import { logAndRedirectError } from './shared';
import {
  requireStreamer, parsePositiveIntField, parseNonNegativeNumberField, parsePositiveNumberField,
  parseCheckboxField, parseRewardIdParam, effectiveCooldownSeconds, handleRewardDeleteAction,
} from './channelPointsAdminShared';
import { applyDecayTick, resetAndDeletePricing } from '../../twitch/pricing/rewardPricingService';

const log = createLogger('ChannelPointsAdminPricingMutations');
export const router = Router();

/**
 * Determines the `cooldown_seconds` a saved pricing config should use: the reward's live Twitch
 * global cooldown when it can be looked up, otherwise the reward's existing pricing config
 * cooldown (if any), otherwise the fallback default. Never throws — a lookup failure just
 * falls through to the next source, so saving a pricing config never fails on a Twitch hiccup.
 * Keeps pricing's cooldown mirroring the reward's real Twitch cooldown instead of a
 * separately-edited value.
 */
async function resolveCooldownSecondsForPricing(streamer: DbStreamerEventSub, twitchRewardId: string): Promise<number> {
  try {
    const token = streamer.twitch_user_id ? await getValidToken(streamer) : null;
    if (streamer.twitch_user_id && token) {
      const rewards = await getCustomRewards(streamer.twitch_user_id, token);
      const reward = rewards.find((r) => r.id === twitchRewardId);
      if (reward) return effectiveCooldownSeconds(reward);
    }
  } catch (err) {
    log.warn('Failed to look up live Twitch cooldown while saving pricing config:', err);
  }
  const existing = await getPricingForReward(streamer.id, twitchRewardId);
  return existing?.cooldown_seconds ?? DEFAULT_PRICING_COOLDOWN_SECONDS;
}

/**
 * POST /channel-points/rewards/:twitchRewardId/pricing — creates or updates a reward's dynamic
 * pricing config. `cooldown_seconds` is not a form field — it's always derived from the
 * reward's live Twitch global cooldown (see {@link resolveCooldownSecondsForPricing}), so it
 * can never drift from the reward's actual Twitch-enforced cooldown.
 * @param req - Express request; reads the `twitchRewardId` route param and `enabled`,
 *   `base_cost`, `max_multiplier`, `curve` from `req.body`.
 * @param res - Express response; redirects to `/channel-points?success=pricing_saved` on success,
 *   or to `/channel-points?error=<code>` if the requester isn't a streamer (`not_a_streamer`),
 *   the reward ID isn't a valid UUID (`invalid_reward_id`), any config field is invalid
 *   (`invalid_config`), or saving fails (`save_failed`).
 */
router.post('/rewards/:twitchRewardId/pricing', requireAuth, csrfProtection, async (req, res) => {
  try {
    const streamer = await requireStreamer(req, res);
    if (!streamer) return;

    const twitchRewardId = parseRewardIdParam(req.params.twitchRewardId);
    if (twitchRewardId === null) return res.redirect('/channel-points?error=invalid_reward_id');

    const body = req.body as Record<string, string | string[] | undefined>;
    const baseCost = parsePositiveIntField(body.base_cost);
    const maxMultiplier = parseNonNegativeNumberField(body.max_multiplier);
    const curve = parsePositiveNumberField(body.curve);
    if (baseCost === null || maxMultiplier === null || curve === null) {
      return res.redirect('/channel-points?error=invalid_config');
    }

    const enabled = parseCheckboxField(body.enabled);
    const cooldownSeconds = await resolveCooldownSecondsForPricing(streamer, twitchRewardId);

    await upsertPricingConfig(streamer.id, twitchRewardId, {
      enabled, base_cost: baseCost, cooldown_seconds: cooldownSeconds, max_multiplier: maxMultiplier, curve,
    });

    // Best-effort immediate resync so the reward's Twitch-side cost reflects the new
    // config right away instead of waiting for the next redemption/decay tick.
    try {
      await applyDecayTick(streamer.id, twitchRewardId);
    } catch (err) {
      log.warn('Immediate pricing resync after save failed:', err);
    }

    res.redirect('/channel-points?success=pricing_saved');
  } catch (err) {
    logAndRedirectError({ res, log, logLabel: 'Pricing config save error:', err, basePath: '/channel-points', errorCode: 'save_failed' });
  }
});

/**
 * POST /channel-points/rewards/:twitchRewardId/pricing/delete — turns off dynamic pricing for
 * a reward while keeping the reward itself on Twitch (see `resetAndDeletePricing`, which
 * best-effort resets the Twitch-side cost back to `base_cost` first).
 * @param req - Express request; reads the `twitchRewardId` route param.
 * @param res - Express response; redirects to `/channel-points?success=pricing_deleted` on success,
 *   or to `/channel-points?error=<code>` if the requester isn't a streamer (`not_a_streamer`),
 *   the reward ID isn't a valid UUID (`invalid_reward_id`), or the delete fails (`delete_failed`).
 */
router.post('/rewards/:twitchRewardId/pricing/delete', requireAuth, csrfProtection, (req, res) =>
  handleRewardDeleteAction(
    req, res,
    (streamer, twitchRewardId) => resetAndDeletePricing(streamer.id, twitchRewardId),
    { log, successCode: 'pricing_deleted', errorLogLabel: 'Pricing config delete error:', errorCode: 'delete_failed' },
  ));

/**
 * POST /channel-points/settings/pricing — updates the streamer's own dynamic-pricing settings
 * (decay half-life and time-to-max-demand multiplier), shared by every one of their rewards'
 * demand calculations.
 * @param req - Express request; reads `half_life_minutes` and `time_to_max_multiplier` from `req.body`.
 * @param res - Express response; redirects to `/channel-points?success=pricing_settings_saved` on
 *   success, or to `/channel-points?error=<code>` if the requester isn't a streamer
 *   (`not_a_streamer`), a field is invalid (`invalid_settings`), or saving fails (`save_failed`).
 */
router.post('/settings/pricing', requireAuth, csrfProtection, async (req, res) => {
  try {
    const streamer = await requireStreamer(req, res);
    if (!streamer) return;

    const body = req.body as Record<string, string | string[] | undefined>;
    const halfLifeMinutes = parsePositiveNumberField(body.half_life_minutes);
    const timeToMaxMultiplier = parsePositiveNumberField(body.time_to_max_multiplier);
    if (halfLifeMinutes === null || timeToMaxMultiplier === null) {
      return res.redirect('/channel-points?error=invalid_settings');
    }

    await savePricingSettingsForStreamer(streamer.id, {
      half_life_seconds: Math.round(halfLifeMinutes * 60),
      time_to_max_multiplier: timeToMaxMultiplier,
    });

    res.redirect('/channel-points?success=pricing_settings_saved');
  } catch (err) {
    logAndRedirectError({ res, log, logLabel: 'Pricing settings save error:', err, basePath: '/channel-points', errorCode: 'save_failed' });
  }
});
