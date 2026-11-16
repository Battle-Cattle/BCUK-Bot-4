// Pushes a reward's recomputed cost to Twitch for the dynamic pricing in `rewardPricingService.ts`:
// resolves the broadcaster's token, rate-limits pushes per reward, and classifies Twitch's errors
// (a 403 disables pricing for the reward, everything else is retried on the next sync).
import { getStreamerById, markPricingUnsupported, type DbStreamerEventSub } from '../../db';
import { getValidToken } from '../twitchUserTokens';
import { updateRewardCost, TwitchRewardUnsupportedError, TwitchRewardAuthError } from '../twitchRewardsApi';
import { createLogger } from '../../shared/logger';

const log = createLogger('RewardPricing');

/**
 * Builds the per-reward key for one streamer's reward: the push rate limiter's key here, and the
 * pricing queue's key in `rewardPricingService.ts`.
 * @param streamerId - Streamer DB row ID.
 * @param twitchRewardId - Twitch custom reward ID.
 * @returns The `streamerId:rewardId` key.
 */
export function rewardKey(streamerId: number, twitchRewardId: string): string {
  return `${streamerId}:${twitchRewardId}`;
}

/** A streamer paired with a currently-valid broadcaster token, as resolved by {@link resolveBroadcasterToken}. */
interface ResolvedBroadcasterToken {
  streamer: DbStreamerEventSub & { twitch_user_id: string };
  token: string;
}

/**
 * Looks up a streamer and their currently-valid broadcaster token together, since every
 * reward-management call needs both. Shared by {@link pushRewardCostUpdate} and
 * `rewardPricingService.ts`'s `resetAndDeletePricing`/`deleteRewardAndPricing`.
 * @param streamerId - DB row ID of the streamer.
 * @returns The streamer (with `twitch_user_id` guaranteed non-null) and their valid token, or
 *   null if the streamer doesn't exist, has no linked Twitch account, or has no usable token.
 */
export async function resolveBroadcasterToken(streamerId: number): Promise<ResolvedBroadcasterToken | null> {
  const streamer = await getStreamerById(streamerId);
  const token = streamer ? await getValidToken(streamer) : null;
  if (!streamer?.twitch_user_id || !token) return null;
  return { streamer: streamer as DbStreamerEventSub & { twitch_user_id: string }, token };
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
 * @returns The `last_pushed_cost` to persist, and whether the reward was marked unsupported (403).
 */
export async function pushRewardCostUpdate(
  streamerId: number, twitchRewardId: string, newCost: number, previousLastPushedCost: number | null,
): Promise<PushCostResult> {
  const key = rewardKey(streamerId, twitchRewardId);
  const lastPush = lastPushedAt.get(key) ?? 0;
  if (Date.now() - lastPush < MIN_PUSH_INTERVAL_MS) {
    return { lastPushedCost: previousLastPushedCost, unsupported: false };
  }
  try {
    const resolved = await resolveBroadcasterToken(streamerId);
    if (!resolved) {
      log.warn(`No valid broadcaster token for streamer ${streamerId} — skipping Twitch price push for reward ${twitchRewardId}`);
      return { lastPushedCost: previousLastPushedCost, unsupported: false };
    }
    await updateRewardCost(resolved.streamer.twitch_user_id, twitchRewardId, newCost, resolved.token);
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
