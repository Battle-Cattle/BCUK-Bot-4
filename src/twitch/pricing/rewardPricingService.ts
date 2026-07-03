import { createMutationQueue } from '../../shared/mutationQueue';
import {
  getPricingForReward, recordPricingUpdate, getGlobalPricingSettings, getStreamerById,
} from '../../db';
import { getValidToken } from '../eventsub/twitchApiEventSub';
import { updateRewardCost } from '../twitchApi';
import { computePrice, decayDemand, applyRedemption } from './rewardPricingMath';
import { createLogger } from '../../shared/logger';

const log = createLogger('RewardPricing');

// Serializes read-modify-write cycles per reward, so a redemption and a concurrent
// decay-scheduler tick on the same reward never race each other. Different rewards
// (different keys) run fully concurrently.
const pricingQueue = createMutationQueue<string>();

function queueKey(streamerId: number, twitchRewardId: string): string {
  return `${streamerId}:${twitchRewardId}`;
}

/**
 * Recomputes demand and price for one reward and persists the result, pushing the new
 * cost to Twitch only when it differs from the last pushed cost. No-ops entirely (no DB
 * write, no Twitch call) when the reward has no pricing config or dynamic pricing is
 * disabled for it — this is where "optional per reward" is enforced. A failure resolving
 * the streamer's token or pushing to Twitch is caught and logged; the recalculated demand
 * is still persisted so the price is simply retried on the next redemption/decay tick.
 *
 * @param streamerId - DB row ID of the owning streamer.
 * @param twitchRewardId - Twitch reward UUID.
 * @param applyIncrement - True for a redemption (decay + increment); false for a decay-only tick.
 */
async function syncRewardPrice(streamerId: number, twitchRewardId: string, applyIncrement: boolean): Promise<void> {
  const row = await getPricingForReward(streamerId, twitchRewardId);
  if (!row || !row.enabled) return;

  const settings = await getGlobalPricingSettings();
  const elapsedSeconds = Math.max(0, (Date.now() - Number(row.demand_updated_at)) / 1000);
  const newDemand = applyIncrement
    ? applyRedemption(row.demand, elapsedSeconds, row.cooldown_seconds, settings.decay_half_life_periods, settings.redemption_increment)
    : decayDemand(row.demand, elapsedSeconds, row.cooldown_seconds, settings.decay_half_life_periods);

  const newCost = computePrice(newDemand, {
    baseCost: row.base_cost,
    cooldownSeconds: row.cooldown_seconds,
    maxMultiplier: row.max_multiplier,
    curve: row.curve,
  });

  let lastPushedCost = row.last_pushed_cost;
  if (newCost !== row.last_pushed_cost) {
    try {
      const streamer = await getStreamerById(streamerId);
      const token = streamer ? await getValidToken(streamer) : null;
      if (streamer?.twitch_user_id && token) {
        await updateRewardCost(streamer.twitch_user_id, twitchRewardId, newCost, token);
        lastPushedCost = newCost;
      } else {
        log.warn(`No valid broadcaster token for streamer ${streamerId} — skipping Twitch price push for reward ${twitchRewardId}`);
      }
    } catch (err) {
      log.error(`Failed to push new price for reward ${twitchRewardId}:`, err);
    }
  }

  await recordPricingUpdate(streamerId, twitchRewardId, newDemand, Date.now(), lastPushedCost);
}

/**
 * Applies a single redemption to a reward's dynamic pricing: decays for elapsed time,
 * adds the global redemption increment, and pushes the new price to Twitch if it changed.
 * Called from the EventSub redemption handler.
 *
 * @param streamerId - DB row ID of the owning streamer.
 * @param twitchRewardId - Twitch reward UUID that was redeemed.
 */
export async function applyRedemptionPricing(streamerId: number, twitchRewardId: string): Promise<void> {
  await pricingQueue.run(queueKey(streamerId, twitchRewardId), () => syncRewardPrice(streamerId, twitchRewardId, true));
}

/**
 * Applies decay-only (no redemption increment) to a reward's dynamic pricing and pushes
 * the new price to Twitch if it changed. Called by the periodic decay scheduler, and as a
 * best-effort immediate resync after an admin edits a reward's pricing config.
 *
 * @param streamerId - DB row ID of the owning streamer.
 * @param twitchRewardId - Twitch reward UUID.
 */
export async function applyDecayTick(streamerId: number, twitchRewardId: string): Promise<void> {
  await pricingQueue.run(queueKey(streamerId, twitchRewardId), () => syncRewardPrice(streamerId, twitchRewardId, false));
}
