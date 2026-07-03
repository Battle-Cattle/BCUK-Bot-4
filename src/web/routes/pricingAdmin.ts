import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import { csrfProtection } from '../csrf';
import { requireAuth } from '../middleware';
import { getStreamerByDiscordId } from '../../db';
import type { DbStreamerEventSub } from '../../db';
import { getPricingConfigsForStreamer, getGlobalPricingSettings } from '../../db';
import { getCustomRewards, TwitchCustomReward } from '../../twitch/twitchApi';
import { getValidToken } from '../../twitch/eventsub/twitchApiEventSub';
import { computePrice } from '../../twitch/pricing/rewardPricingMath';
import { filterQueryParam, renderError, renderView } from './shared';
import { router as pricingMutationsRouter } from './pricingAdminMutations';

const log = createLogger('PricingAdmin');
const router = Router();

const KNOWN_ERRORS = new Set([
  'not_a_streamer', 'invalid_reward_id', 'invalid_config', 'save_failed', 'invalid_id',
  'delete_failed', 'not_owner', 'invalid_settings',
]);
const KNOWN_SUCCESSES = new Set(['pricing_saved', 'pricing_deleted', 'global_settings_saved']);

/** Fetches the streamer's live Twitch custom rewards, or an empty list if not connected. */
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
 * GET /pricing — renders the dynamic pricing admin page: the streamer's live Twitch
 * rewards merged with any existing pricing config (including a live price preview),
 * and — only for the bot owner — the bot-wide decay/increment settings.
 * @param req - Express request; reads `req.session.user`, `error`, and `success` query params.
 * @param res - Express response; renders the `pricingAdmin` view, or a 500 error page on failure.
 */
router.get('/', requireAuth, csrfProtection, async (req, res) => {
  try {
    const streamer = await getStreamerByDiscordId(req.session.user!.discordId);
    const [pricingConfigs, twitchRewards] = streamer
      ? await Promise.all([getPricingConfigsForStreamer(streamer.id), fetchTwitchRewards(streamer)])
      : [[], []];

    const configByRewardId = new Map(pricingConfigs.map((c) => [c.twitch_reward_id, c]));
    const rewards = twitchRewards.map((tr) => {
      const config = configByRewardId.get(tr.id) ?? null;
      const previewPrice = config
        ? computePrice(config.demand, {
            baseCost: config.base_cost,
            cooldownSeconds: config.cooldown_seconds,
            maxMultiplier: config.max_multiplier,
            curve: config.curve,
          })
        : null;
      return { twitchReward: tr, config, previewPrice };
    });

    const isOwner = req.session.user?.isOwner ?? false;
    const globalSettings = isOwner ? await getGlobalPricingSettings() : null;

    renderView(res, 'pricingAdmin', {
      user: req.session.user,
      csrfToken: req.csrfToken(),
      streamer: streamer ?? null,
      rewards,
      isOwner,
      globalSettings,
      error: filterQueryParam(req.query.error, KNOWN_ERRORS),
      success: filterQueryParam(req.query.success, KNOWN_SUCCESSES),
    });
  } catch (err) {
    log.error('Pricing settings page error:', err);
    renderError(res, 500, 'Failed to load pricing settings.', req.session.user);
  }
});

router.use(pricingMutationsRouter);

export default router;
