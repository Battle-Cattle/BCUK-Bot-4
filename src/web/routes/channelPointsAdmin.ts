import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import { csrfProtection } from '../csrf';
import { requireAuth } from '../middleware';
import { getStreamerByDiscordId } from '../../db';
import type { DbStreamerEventSub } from '../../db';
import { getPricingConfigsForStreamer, getGlobalPricingSettings } from '../../db';
import type { RewardPricingRow } from '../../db';
import { getCustomRewards, TwitchCustomReward } from '../../twitch/twitchApi';
import { getValidToken } from '../../twitch/eventsub/twitchApiEventSub';
import { hasAuthFailedSubs } from '../../twitch/eventsub/twitchEventSubSubscriptions';
import { computePrice } from '../../twitch/pricing/rewardPricingMath';
import { filterQueryParam, renderError, renderView } from './shared';
import { router as channelPointsMutationsRouter } from './channelPointsAdminMutations';

const log = createLogger('ChannelPointsAdmin');
const router = Router();

const KNOWN_ERRORS = new Set([
  'not_a_streamer', 'invalid_reward_id', 'invalid_config', 'save_failed',
  'delete_failed', 'not_owner', 'invalid_settings', 'invalid_reward_fields', 'create_failed', 'update_failed',
]);
const KNOWN_SUCCESSES = new Set([
  'pricing_saved', 'pricing_deleted', 'global_settings_saved', 'reward_created', 'reward_updated', 'reward_deleted',
]);

/** One row on the Channel Points page: a live Twitch reward, an "unlinked" orphaned pricing config, or both merged. */
interface ChannelPointRewardRow {
  rewardId: string;
  twitchReward: TwitchCustomReward | null;
  config: RewardPricingRow | null;
  previewPrice: number | null;
}

/** Computes the live preview price for a reward's current demand, from its pricing config. */
function previewPriceFor(config: RewardPricingRow): number {
  return computePrice(config.demand, {
    baseCost: config.base_cost,
    cooldownSeconds: config.cooldown_seconds,
    maxMultiplier: config.max_multiplier,
    curve: config.curve,
  });
}

/** Fetches the streamer's live Twitch custom rewards, or an empty list if not connected or on any failure. */
async function fetchTwitchRewards(streamer: DbStreamerEventSub): Promise<TwitchCustomReward[]> {
  if (!streamer.twitch_user_id) return [];
  try {
    const token = await getValidToken(streamer);
    if (!token) return [];
    return await getCustomRewards(streamer.twitch_user_id, token);
  } catch (err) {
    log.warn('Failed to fetch Twitch custom rewards:', err);
    return [];
  }
}

/**
 * GET /channel-points — renders the Channel Points management page: the streamer's live
 * Twitch rewards (creatable/editable/deletable from here) merged with any existing dynamic
 * pricing config (including a live price preview), and — only for the bot owner — the
 * bot-wide pricing decay/increment settings. Shows a reconnect prompt instead of the reward
 * list when the streamer isn't connected, or their connection has started failing with an
 * auth error (mirrors the same check on `/user/settings`).
 * @param req - Express request; reads `req.session.user`, `error`, and `success` query params.
 * @param res - Express response; renders the `channelPointsAdmin` view, or a 500 error page on failure.
 */
router.get('/', requireAuth, csrfProtection, async (req, res) => {
  try {
    const streamer = await getStreamerByDiscordId(req.session.user!.discordId);
    const isConnected = !!streamer?.eventsub_access_token;
    const needsReconnect = isConnected && !!streamer?.twitch_name && hasAuthFailedSubs(streamer.twitch_name);

    const [pricingConfigs, twitchRewards] = streamer && isConnected && !needsReconnect
      ? await Promise.all([getPricingConfigsForStreamer(streamer.id), fetchTwitchRewards(streamer)])
      : [[], []];

    const configByRewardId = new Map(pricingConfigs.map((c) => [c.twitch_reward_id, c]));
    const matchedRewardIds = new Set(twitchRewards.map((tr) => tr.id));

    const rewards: ChannelPointRewardRow[] = twitchRewards.map((tr) => {
      const config = configByRewardId.get(tr.id) ?? null;
      return { rewardId: tr.id, twitchReward: tr, config, previewPrice: config ? previewPriceFor(config) : null };
    });

    // Configs whose reward no longer appears on Twitch (deleted, or the streamer's token
    // lacks the scope to list it) still get processed by the decay scheduler — surface them
    // as "unlinked" rows so they aren't invisible/unmanageable from this page.
    for (const config of pricingConfigs) {
      if (matchedRewardIds.has(config.twitch_reward_id)) continue;
      rewards.push({ rewardId: config.twitch_reward_id, twitchReward: null, config, previewPrice: previewPriceFor(config) });
    }

    const isOwner = req.session.user?.isOwner ?? false;
    const globalSettings = isOwner ? await getGlobalPricingSettings() : null;

    renderView(res, 'channelPointsAdmin', {
      user: req.session.user,
      csrfToken: req.csrfToken(),
      streamer: streamer ?? null,
      isConnected,
      needsReconnect,
      rewards,
      isOwner,
      globalSettings,
      error: filterQueryParam(req.query.error, KNOWN_ERRORS),
      success: filterQueryParam(req.query.success, KNOWN_SUCCESSES),
    });
  } catch (err) {
    log.error('Channel Points page error:', err);
    renderError(res, 500, 'Failed to load Channel Points settings.', req.session.user);
  }
});

router.use(channelPointsMutationsRouter);

export default router;
