import { createLogger } from '../../shared/logger';
import { Router, Request, Response } from 'express';
import { csrfProtection } from '../csrf';
import { requireAuth } from '../middleware';
import {
  upsertPricingConfig, savePricingSettingsForStreamer, getPricingForReward, updatePricingCooldownForReward,
  DEFAULT_PRICING_COOLDOWN_SECONDS, DbStreamerEventSub,
} from '../../db';
import { createCustomReward, updateCustomReward, getCustomRewards } from '../../twitch/twitchApi';
import { getValidToken } from '../../twitch/eventsub/twitchApiEventSub';
import { logAndRedirectError } from './shared';
import {
  requireStreamer, parsePositiveIntField, parseNonNegativeNumberField, parsePositiveNumberField,
  parseCheckboxField, parseRewardIdParam, parseRewardFields, effectiveCooldownSeconds,
} from './channelPointsAdminShared';
import { applyDecayTick, resetAndDeletePricing, deleteRewardAndPricing } from '../../twitch/pricing/rewardPricingService';

const log = createLogger('ChannelPointsAdminMutations');
export const router = Router();

/**
 * Shared body for the two reward-scoped "delete" routes: resolves the requester's streamer
 * record and the `:twitchRewardId` route param, runs `action`, then redirects to
 * `/channel-points` with `success=<successCode>` or (on a thrown error) `error=<errorCode>`
 * via `logAndRedirectError`.
 */
async function handleRewardDeleteAction(
  req: Request,
  res: Response,
  action: (streamer: DbStreamerEventSub, twitchRewardId: string) => Promise<void>,
  opts: { successCode: string; errorLogLabel: string; errorCode: string },
): Promise<void> {
  try {
    const streamer = await requireStreamer(req, res);
    if (!streamer) return;

    const twitchRewardId = parseRewardIdParam(req.params.twitchRewardId);
    if (twitchRewardId === null) return res.redirect('/channel-points?error=invalid_reward_id');

    await action(streamer, twitchRewardId);

    res.redirect(`/channel-points?success=${opts.successCode}`);
  } catch (err) {
    logAndRedirectError({ res, log, logLabel: opts.errorLogLabel, err, basePath: '/channel-points', errorCode: opts.errorCode });
  }
}

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
    { successCode: 'reward_deleted', errorLogLabel: 'Reward delete error:', errorCode: 'delete_failed' },
  ));

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
    { successCode: 'pricing_deleted', errorLogLabel: 'Pricing config delete error:', errorCode: 'delete_failed' },
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
