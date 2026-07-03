import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import { csrfProtection } from '../csrf';
import { requireAuth } from '../middleware';
import { upsertPricingConfig, saveGlobalPricingSettings } from '../../db';
import { createCustomReward, updateCustomReward, CustomRewardInput } from '../../twitch/twitchApi';
import { getValidToken } from '../../twitch/eventsub/twitchApiEventSub';
import { logAndRedirectError, trimField } from './shared';
import {
  requireStreamer, parsePositiveIntField, parseNonNegativeNumberField, parsePositiveNumberField,
  parseCheckboxField, parseHexColorField,
} from './channelPointsAdminShared';
import { applyDecayTick, resetAndDeletePricing, deleteRewardAndPricing } from '../../twitch/pricing/rewardPricingService';

const log = createLogger('ChannelPointsAdminMutations');
export const router = Router();

const REWARD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TITLE_MAX_LENGTH = 45; // Twitch's own limit for a custom reward's title
const PROMPT_MAX_LENGTH = 200; // Twitch's own limit for a custom reward's prompt

/** Extracts and validates the `:twitchRewardId` route param, or null if malformed/repeated. */
function parseRewardIdParam(value: string | string[]): string | null {
  if (Array.isArray(value)) return null;
  return REWARD_ID_RE.test(value) ? value : null;
}

/**
 * Parses and validates the full set of Twitch custom reward fields shared by the create and
 * edit forms. Returns `null` if any field is invalid — including cross-field rules Twitch
 * itself enforces (a prompt is required when user input is required; a limit's numeric value
 * is required when that limit's "enabled" checkbox is checked).
 */
function parseRewardFields(body: Record<string, string | string[] | undefined>): CustomRewardInput | null {
  const title = trimField(body.title);
  if (title === '' || title.length > TITLE_MAX_LENGTH) return null;

  const cost = parsePositiveIntField(body.cost);
  if (cost === null) return null;

  const prompt = trimField(body.prompt);
  if (prompt.length > PROMPT_MAX_LENGTH) return null;

  const isUserInputRequired = parseCheckboxField(body.is_user_input_required);
  if (isUserInputRequired && prompt === '') return null;

  const backgroundColor = parseHexColorField(body.background_color);
  if (backgroundColor === null) return null; // null = malformed; undefined = not provided (fine)

  const isMaxPerStreamEnabled = parseCheckboxField(body.is_max_per_stream_enabled);
  const maxPerStream = parsePositiveIntField(body.max_per_stream);
  if (isMaxPerStreamEnabled && maxPerStream === null) return null;

  const isMaxPerUserPerStreamEnabled = parseCheckboxField(body.is_max_per_user_per_stream_enabled);
  const maxPerUserPerStream = parsePositiveIntField(body.max_per_user_per_stream);
  if (isMaxPerUserPerStreamEnabled && maxPerUserPerStream === null) return null;

  const isGlobalCooldownEnabled = parseCheckboxField(body.is_global_cooldown_enabled);
  const globalCooldownSeconds = parsePositiveIntField(body.global_cooldown_seconds);
  if (isGlobalCooldownEnabled && globalCooldownSeconds === null) return null;

  return {
    title,
    cost,
    prompt: prompt || undefined,
    is_enabled: parseCheckboxField(body.is_enabled),
    background_color: backgroundColor,
    is_user_input_required: isUserInputRequired,
    is_max_per_stream_enabled: isMaxPerStreamEnabled,
    max_per_stream: isMaxPerStreamEnabled ? maxPerStream! : undefined,
    is_max_per_user_per_stream_enabled: isMaxPerUserPerStreamEnabled,
    max_per_user_per_stream: isMaxPerUserPerStreamEnabled ? maxPerUserPerStream! : undefined,
    is_global_cooldown_enabled: isGlobalCooldownEnabled,
    global_cooldown_seconds: isGlobalCooldownEnabled ? globalCooldownSeconds! : undefined,
    should_redemptions_skip_request_queue: parseCheckboxField(body.should_redemptions_skip_request_queue),
  };
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

    await updateCustomReward(streamer.twitch_user_id, twitchRewardId, token, input);

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
router.post('/rewards/:twitchRewardId/delete', requireAuth, csrfProtection, async (req, res) => {
  try {
    const streamer = await requireStreamer(req, res);
    if (!streamer) return;

    const twitchRewardId = parseRewardIdParam(req.params.twitchRewardId);
    if (twitchRewardId === null) return res.redirect('/channel-points?error=invalid_reward_id');

    await deleteRewardAndPricing(streamer.id, twitchRewardId);

    res.redirect('/channel-points?success=reward_deleted');
  } catch (err) {
    logAndRedirectError({ res, log, logLabel: 'Reward delete error:', err, basePath: '/channel-points', errorCode: 'delete_failed' });
  }
});

/**
 * POST /channel-points/rewards/:twitchRewardId/pricing — creates or updates a reward's dynamic
 * pricing config.
 * @param req - Express request; reads the `twitchRewardId` route param and `enabled`,
 *   `base_cost`, `cooldown_seconds`, `max_multiplier`, `curve` from `req.body`.
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
    const cooldownSeconds = parsePositiveIntField(body.cooldown_seconds);
    const maxMultiplier = parseNonNegativeNumberField(body.max_multiplier);
    const curve = parsePositiveNumberField(body.curve);
    if (baseCost === null || cooldownSeconds === null || maxMultiplier === null || curve === null) {
      return res.redirect('/channel-points?error=invalid_config');
    }

    const enabled = parseCheckboxField(body.enabled);

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
router.post('/rewards/:twitchRewardId/pricing/delete', requireAuth, csrfProtection, async (req, res) => {
  try {
    const streamer = await requireStreamer(req, res);
    if (!streamer) return;

    const twitchRewardId = parseRewardIdParam(req.params.twitchRewardId);
    if (twitchRewardId === null) return res.redirect('/channel-points?error=invalid_reward_id');

    await resetAndDeletePricing(streamer.id, twitchRewardId);

    res.redirect('/channel-points?success=pricing_deleted');
  } catch (err) {
    logAndRedirectError({ res, log, logLabel: 'Pricing config delete error:', err, basePath: '/channel-points', errorCode: 'delete_failed' });
  }
});

/**
 * POST /channel-points/settings/global — updates the bot-wide decay/increment settings shared by
 * every reward's demand calculations. Restricted to the bot owner (`req.session.user.isOwner`)
 * since this setting is not scoped to any single guild or streamer.
 * @param req - Express request; reads `decay_half_life_periods` and `redemption_increment`
 *   from `req.body`.
 * @param res - Express response; redirects to `/channel-points?success=global_settings_saved` on
 *   success, or to `/channel-points?error=<code>` if the requester isn't the bot owner (`not_owner`),
 *   a field is invalid (`invalid_settings`), or saving fails (`save_failed`).
 */
router.post('/settings/global', requireAuth, csrfProtection, async (req, res) => {
  try {
    if (!req.session.user?.isOwner) return res.redirect('/channel-points?error=not_owner');

    const body = req.body as Record<string, string | string[] | undefined>;
    const decayHalfLifePeriods = parsePositiveNumberField(body.decay_half_life_periods);
    const redemptionIncrement = parseNonNegativeNumberField(body.redemption_increment);
    if (decayHalfLifePeriods === null || redemptionIncrement === null || redemptionIncrement > 1) {
      return res.redirect('/channel-points?error=invalid_settings');
    }

    await saveGlobalPricingSettings({
      decay_half_life_periods: decayHalfLifePeriods,
      redemption_increment: redemptionIncrement,
    });

    res.redirect('/channel-points?success=global_settings_saved');
  } catch (err) {
    logAndRedirectError({ res, log, logLabel: 'Global pricing settings save error:', err, basePath: '/channel-points', errorCode: 'save_failed' });
  }
});
