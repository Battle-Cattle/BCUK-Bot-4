import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import { csrfProtection } from '../csrf';
import { requireAuth } from '../middleware';
import {
  upsertPricingConfig, deletePricingConfig, getPricingConfigById, saveGlobalPricingSettings,
} from '../../db';
import { logAndRedirectError, parsePositiveIntId } from './shared';
import {
  requireStreamer, parsePositiveIntField, parseNonNegativeNumberField, parsePositiveNumberField,
} from './pricingAdminShared';
import { applyDecayTick, resetAndDeletePricing } from '../../twitch/pricing/rewardPricingService';

const log = createLogger('PricingAdminMutations');
export const router = Router();

const REWARD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * POST /pricing/settings/rewards — creates or updates a reward's dynamic pricing config.
 * @param req - Express request; reads `twitch_reward_id`, `enabled`, `base_cost`,
 *   `cooldown_seconds`, `max_multiplier`, and `curve` from `req.body`.
 * @param res - Express response; redirects to `/pricing?success=pricing_saved` on success,
 *   or to `/pricing?error=<code>` if the requester isn't a streamer (`not_a_streamer`),
 *   the reward ID isn't a valid UUID (`invalid_reward_id`), any config field is invalid
 *   (`invalid_config`), or saving fails (`save_failed`).
 */
router.post('/settings/rewards', requireAuth, csrfProtection, async (req, res) => {
  try {
    const streamer = await requireStreamer(req, res);
    if (!streamer) return;

    const body = req.body as Record<string, string | string[] | undefined>;
    const twitchRewardId = (typeof body.twitch_reward_id === 'string' ? body.twitch_reward_id : '').trim();
    if (!REWARD_ID_RE.test(twitchRewardId)) return res.redirect('/pricing?error=invalid_reward_id');

    const baseCost = parsePositiveIntField(body.base_cost);
    const cooldownSeconds = parsePositiveIntField(body.cooldown_seconds);
    const maxMultiplier = parseNonNegativeNumberField(body.max_multiplier);
    const curve = parsePositiveNumberField(body.curve);
    if (baseCost === null || cooldownSeconds === null || maxMultiplier === null || curve === null) {
      return res.redirect('/pricing?error=invalid_config');
    }

    const enabled = !Array.isArray(body.enabled) && body.enabled === 'on';

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

    res.redirect('/pricing?success=pricing_saved');
  } catch (err) {
    logAndRedirectError({ res, log, logLabel: 'Pricing config save error:', err, basePath: '/pricing', errorCode: 'save_failed' });
  }
});

/**
 * POST /pricing/settings/rewards/:id/delete — deletes a reward's pricing config
 * belonging to the requesting streamer. Best-effort resets the reward's Twitch-side
 * cost back to its base_cost first (skipped if the reward was marked unsupported),
 * since deleting the DB row alone would otherwise leave Twitch permanently stuck at
 * whatever price dynamic pricing last pushed. The reset and delete run inside the
 * same queued pricing operation as a concurrent redemption/decay tick for this
 * reward, so neither can race the other into leaving a stale, unreconcilable cost.
 * @param req - Express request; reads the `id` route param.
 * @param res - Express response; redirects to `/pricing?success=pricing_deleted` on success,
 *   or to `/pricing?error=<code>` if the requester isn't a streamer (`not_a_streamer`),
 *   `id` is malformed (`invalid_id`), or the delete fails (`delete_failed`).
 */
router.post('/settings/rewards/:id/delete', requireAuth, csrfProtection, async (req, res) => {
  try {
    const streamer = await requireStreamer(req, res);
    if (!streamer) return;

    const id = parsePositiveIntId(req.params.id);
    if (id === null) return res.redirect('/pricing?error=invalid_id');

    const config = await getPricingConfigById(id, streamer.id);
    if (config) {
      await resetAndDeletePricing(id, streamer.id, config.twitch_reward_id);
    } else {
      await deletePricingConfig(id, streamer.id);
    }

    res.redirect('/pricing?success=pricing_deleted');
  } catch (err) {
    logAndRedirectError({ res, log, logLabel: 'Pricing config delete error:', err, basePath: '/pricing', errorCode: 'delete_failed' });
  }
});

/**
 * POST /pricing/settings/global — updates the bot-wide decay/increment settings shared by
 * every reward's demand calculations. Restricted to the bot owner (`req.session.user.isOwner`)
 * since this setting is not scoped to any single guild or streamer.
 * @param req - Express request; reads `decay_half_life_periods` and `redemption_increment`
 *   from `req.body`.
 * @param res - Express response; redirects to `/pricing?success=global_settings_saved` on
 *   success, or to `/pricing?error=<code>` if the requester isn't the bot owner (`not_owner`),
 *   a field is invalid (`invalid_settings`), or saving fails (`save_failed`).
 */
router.post('/settings/global', requireAuth, csrfProtection, async (req, res) => {
  try {
    if (!req.session.user?.isOwner) return res.redirect('/pricing?error=not_owner');

    const body = req.body as Record<string, string | string[] | undefined>;
    const decayHalfLifePeriods = parsePositiveNumberField(body.decay_half_life_periods);
    const redemptionIncrement = parseNonNegativeNumberField(body.redemption_increment);
    if (decayHalfLifePeriods === null || redemptionIncrement === null || redemptionIncrement > 1) {
      return res.redirect('/pricing?error=invalid_settings');
    }

    await saveGlobalPricingSettings({
      decay_half_life_periods: decayHalfLifePeriods,
      redemption_increment: redemptionIncrement,
    });

    res.redirect('/pricing?success=global_settings_saved');
  } catch (err) {
    logAndRedirectError({ res, log, logLabel: 'Global pricing settings save error:', err, basePath: '/pricing', errorCode: 'save_failed' });
  }
});
