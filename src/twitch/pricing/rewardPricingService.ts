import { createMutationQueue } from '../../shared/mutationQueue';
import {
  getPricingForReward, recordPricingUpdate, recordPricingHistory, markPricingUnsupported, deletePricingConfig,
  getPricingSettingsForStreamer, getStreamerById, type StreamerPricingSettings,
} from '../../db';
import { getValidToken } from '../eventsub/twitchApiEventSub';
import { updateRewardCost, deleteCustomReward, TwitchRewardUnsupportedError, TwitchRewardAuthError } from '../twitchApi';
import { computePrice, decayDemand, applyRedemption, computeRedemptionIncrement } from './rewardPricingMath';
import { createLogger } from '../../shared/logger';

const log = createLogger('RewardPricing');

/** Runtime hooks injected from index.ts, mirroring the `registerEventSub*Runtime` pattern — avoids a circular import back into `web/routes/channelPointsEvents`. */
interface RewardPricingRuntime {
  pushPricingUpdate: (streamerId: number, event: import('../../web/routes/channelPointsEvents').PricingUpdateEvent) => void;
}
let _runtime: RewardPricingRuntime | null = null;

/** Registers the live-pricing-update push hook. Call once from index.ts after startup. */
export function registerRewardPricingRuntime(runtime: RewardPricingRuntime): void {
  _runtime = runtime;
}

// Serializes read-modify-write cycles per reward, so a redemption and a concurrent
// decay-scheduler tick on the same reward never race each other. Different rewards
// (different keys) run fully concurrently.
const pricingQueue = createMutationQueue<string>();

function queueKey(streamerId: number, twitchRewardId: string): string {
  return `${streamerId}:${twitchRewardId}`;
}

// Caps how often a single reward's cost is actually pushed to Twitch, even if demand keeps
// changing faster than that (e.g. a redemption burst during a raid/hype train) — every
// redemption still updates demand immediately, but the resulting price is coalesced onto
// Twitch at most this often. Skipped pushes aren't lost: since last_pushed_cost is left
// unchanged, the next redemption (once the window has passed) or the next decay tick
// (every 30s, well above this interval) will push the fully caught-up price.
const MIN_PUSH_INTERVAL_MS = 5_000;
const lastPushedAt = new Map<string, number>();

/** Test-only: clears the in-memory last-pushed-at cache so each test starts from a clean slate. */
export function __resetPushRateLimiterForTests(): void {
  lastPushedAt.clear();
}

/** Outcome of {@link pushRewardCostUpdate}. */
interface PushCostResult {
  /** The cost to persist as `last_pushed_cost` — the new cost on success, otherwise unchanged. */
  lastPushedCost: number | null;
  /** True when the reward was found to be permanently unsupported (403) — `markPricingUnsupported` has already run. */
  unsupported: boolean;
}

/**
 * Resolves the streamer's broadcaster token and pushes a recomputed cost to Twitch for one
 * reward, unless `MIN_PUSH_INTERVAL_MS` hasn't yet elapsed since the last successful push for
 * this reward (see `lastPushedAt`), in which case the push is skipped entirely (no DB/token
 * lookups) and `previousLastPushedCost` is returned unchanged. A 403 (the reward was created
 * outside this app and can never be managed by it) is treated as permanent: the row is
 * disabled via `markPricingUnsupported`. A 401 (invalid token, or missing the
 * channel:manage:redemptions scope) is logged with an actionable message but otherwise
 * treated like any other transient failure — the token is shared with other bot features, so
 * it's never cleared from here; reconnecting Twitch in User Settings (to grant the scope, or
 * replace a revoked token) is what actually resolves it. Any other failure is also logged and
 * swallowed. In every failure/rate-limited case, `previousLastPushedCost` is returned
 * unchanged so the price is simply retried on the next redemption/decay tick.
 *
 * @param streamerId - DB row ID of the owning streamer.
 * @param twitchRewardId - Twitch reward UUID.
 * @param newCost - The recomputed cost to push.
 * @param previousLastPushedCost - The reward's current `last_pushed_cost`, returned unchanged on failure.
 */
async function pushRewardCostUpdate(
  streamerId: number, twitchRewardId: string, newCost: number, previousLastPushedCost: number | null,
): Promise<PushCostResult> {
  const key = queueKey(streamerId, twitchRewardId);
  const lastPush = lastPushedAt.get(key) ?? 0;
  if (Date.now() - lastPush < MIN_PUSH_INTERVAL_MS) {
    return { lastPushedCost: previousLastPushedCost, unsupported: false };
  }
  try {
    const streamer = await getStreamerById(streamerId);
    const token = streamer ? await getValidToken(streamer) : null;
    if (!streamer?.twitch_user_id || !token) {
      log.warn(`No valid broadcaster token for streamer ${streamerId} — skipping Twitch price push for reward ${twitchRewardId}`);
      return { lastPushedCost: previousLastPushedCost, unsupported: false };
    }
    await updateRewardCost(streamer.twitch_user_id, twitchRewardId, newCost, token);
    lastPushedAt.set(key, Date.now());
    return { lastPushedCost: newCost, unsupported: false };
  } catch (err) {
    if (err instanceof TwitchRewardUnsupportedError) {
      log.warn(`Reward ${twitchRewardId} (streamer ${streamerId}) can't be managed by this app — disabling dynamic pricing:`, err);
      await markPricingUnsupported(streamerId, twitchRewardId);
      return { lastPushedCost: previousLastPushedCost, unsupported: true };
    }
    if (err instanceof TwitchRewardAuthError) {
      log.warn(`Broadcaster token for streamer ${streamerId} is invalid or missing the channel:manage:redemptions scope — reconnect Twitch in User Settings to fix reward ${twitchRewardId}:`, err);
    } else {
      log.error(`Failed to push new price for reward ${twitchRewardId}:`, err);
    }
    return { lastPushedCost: previousLastPushedCost, unsupported: false };
  }
}

/**
 * Recomputes demand and price for one reward and persists the result, pushing the new
 * cost to Twitch only when it differs from the last pushed cost — since `newCost` is
 * already rounded to `row.round_to_nearest` (see `computePrice`), this comparison (and
 * therefore the Twitch push) naturally only fires when the *rounded* price changes, not
 * on every sub-step fluctuation in demand. No-ops entirely (no DB
 * write, no Twitch call) when the reward has no pricing config or dynamic pricing is
 * disabled for it — this is where "optional per reward" is enforced. Demand is always
 * persisted, even when the Twitch push fails, so the price is simply retried on the next
 * redemption/decay tick — except when the reward turns out to be permanently unsupported
 * (see {@link pushRewardCostUpdate}), in which case demand is intentionally not persisted
 * since the row won't be read again until re-enabled. On every successful sync, also logs a
 * price-history point (best-effort; a failure here is logged and swallowed rather than
 * affecting the pricing update itself) and pushes a live update to any open Channel Points
 * admin pages for this streamer, so the price history graph updates without a page refresh.
 *
 * @param streamerId - DB row ID of the owning streamer.
 * @param twitchRewardId - Twitch reward UUID.
 * @param applyIncrement - True for a redemption (decay + increment); false for a decay-only tick.
 * @param settingsHint - Optional pre-fetched settings, passed by the decay scheduler when it has
 *   already loaded a streamer's settings once for this tick — avoids re-querying the same row for
 *   every one of that streamer's enabled rewards. Fetched fresh when omitted.
 */
async function syncRewardPrice(
  streamerId: number, twitchRewardId: string, applyIncrement: boolean, settingsHint?: StreamerPricingSettings,
): Promise<void> {
  const row = await getPricingForReward(streamerId, twitchRewardId);
  if (!row || !row.enabled) return;

  const settings = settingsHint ?? await getPricingSettingsForStreamer(streamerId);
  const now = Date.now();
  const elapsedSeconds = Math.max(0, (now - Number(row.demand_updated_at)) / 1000);
  const newDemand = applyIncrement
    ? applyRedemption(
        row.demand, elapsedSeconds, settings.half_life_seconds,
        computeRedemptionIncrement(row.cooldown_seconds, settings.half_life_seconds, settings.time_to_max_multiplier),
      )
    : decayDemand(row.demand, elapsedSeconds, settings.half_life_seconds);

  const newCost = computePrice(newDemand, {
    baseCost: row.base_cost,
    maxMultiplier: row.max_multiplier,
    curve: row.curve,
    roundToNearest: row.round_to_nearest,
  });

  let lastPushedCost = row.last_pushed_cost;
  if (newCost !== row.last_pushed_cost) {
    const result = await pushRewardCostUpdate(streamerId, twitchRewardId, newCost, row.last_pushed_cost);
    if (result.unsupported) return; // markPricingUnsupported already disabled the row; no need to also record demand.
    lastPushedCost = result.lastPushedCost;
  }

  await recordPricingUpdate(streamerId, twitchRewardId, newDemand, now, lastPushedCost);

  try {
    await recordPricingHistory(row.id, newCost, newDemand, now);
  } catch (err) {
    log.warn(`Failed to record price history for reward ${twitchRewardId}:`, err);
  }

  try {
    _runtime?.pushPricingUpdate(streamerId, { rewardId: twitchRewardId, cost: newCost, demand: newDemand, recordedAt: now });
  } catch (err) {
    log.warn(`Failed to push live price update for reward ${twitchRewardId}:`, err);
  }
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
 * @param settingsHint - Optional pre-fetched settings for this streamer; see {@link syncRewardPrice}.
 */
export async function applyDecayTick(streamerId: number, twitchRewardId: string, settingsHint?: StreamerPricingSettings): Promise<void> {
  await pricingQueue.run(queueKey(streamerId, twitchRewardId), () => syncRewardPrice(streamerId, twitchRewardId, false, settingsHint));
}

/**
 * Resets a reward's Twitch-side cost to its base_cost, then deletes its pricing config —
 * both inside the same queued operation as `applyRedemptionPricing`/`applyDecayTick` for this
 * reward, so a concurrent redemption or decay tick can never push a new price into the gap
 * between the reset and the delete (which would otherwise leave Twitch at a stale cost with
 * no config left to ever reconcile it). Skips the reset (but still deletes) when the reward
 * was marked unsupported, since Twitch would just reject the reset too. No-ops entirely if
 * no pricing config exists for this reward. Use this to turn dynamic pricing off while
 * keeping the reward itself on Twitch — see `deleteRewardAndPricing` to delete the reward too.
 *
 * @param streamerId - DB row ID of the owning streamer.
 * @param twitchRewardId - Twitch reward UUID.
 */
export async function resetAndDeletePricing(streamerId: number, twitchRewardId: string): Promise<void> {
  await pricingQueue.run(queueKey(streamerId, twitchRewardId), async () => {
    const row = await getPricingForReward(streamerId, twitchRewardId);
    if (!row) return;
    if (!row.twitch_unsupported) {
      try {
        const streamer = await getStreamerById(streamerId);
        const token = streamer ? await getValidToken(streamer) : null;
        if (streamer?.twitch_user_id && token) {
          await updateRewardCost(streamer.twitch_user_id, twitchRewardId, row.base_cost, token);
        }
      } catch (err) {
        log.warn(`Failed to reset Twitch reward cost before deleting pricing config for reward ${twitchRewardId}:`, err);
      }
    }
    await deletePricingConfig(row.id, streamerId);
  });
}

/**
 * Deletes a reward entirely from Twitch — only succeeds for rewards created by this app
 * (Twitch returns a 403 otherwise, which propagates to the caller) — then removes any local
 * pricing config for it. Runs inside the same queued operation as
 * `applyRedemptionPricing`/`applyDecayTick`/`resetAndDeletePricing` for this reward, so a
 * concurrent redemption or decay tick can't race a reward being deleted. Unlike
 * `resetAndDeletePricing`, this does not attempt a cost reset first — the reward won't exist
 * to have a cost once this completes.
 *
 * @param streamerId - DB row ID of the owning streamer.
 * @param twitchRewardId - Twitch reward UUID to delete.
 * @throws When the streamer has no valid broadcaster token, or Twitch rejects the delete
 *   (e.g. `TwitchRewardUnsupportedError` for a reward this app didn't create).
 */
export async function deleteRewardAndPricing(streamerId: number, twitchRewardId: string): Promise<void> {
  await pricingQueue.run(queueKey(streamerId, twitchRewardId), async () => {
    const streamer = await getStreamerById(streamerId);
    const token = streamer ? await getValidToken(streamer) : null;
    if (!streamer?.twitch_user_id || !token) {
      throw new Error(`No valid broadcaster token for streamer ${streamerId} — cannot delete reward ${twitchRewardId}`);
    }
    await deleteCustomReward(streamer.twitch_user_id, twitchRewardId, token);

    const row = await getPricingForReward(streamerId, twitchRewardId);
    if (row) await deletePricingConfig(row.id, streamerId);
  });
}
