import {
  getLoyaltyPointsConfig,
  adjustLoyaltyPointsBalance,
  DEFAULT_POINTS_PER_MESSAGE,
  DEFAULT_POINTS_COOLDOWN_SECONDS,
  DEFAULT_POINTS_PER_SUB,
  DEFAULT_POINTS_PER_GIFT_SUB,
} from '../db';

// A per-(streamer, viewer) last-earn timestamp, used by both the passive chat-earn path and
// `!gamble`'s shared cooldown (see tryClaimPointsCooldown below). Unlike `cooldownGate.ts`'s
// `createCooldownGate()`, this cooldown's duration must be configurable per streamer
// (`LoyaltyPointsConfig.cooldownSeconds`), which `createCooldownGate()` doesn't support — it's
// hardcoded to the fixed `GLOBAL_COOLDOWN_MS` constant.
const lastEarnedAt = new Map<string, number>();

/** Builds this cooldown's composite key: earning is per-streamer, so the same viewer chatting
 *  on two different streamers' channels must never share a cooldown. */
function cooldownKey(streamerId: number, twitchUsername: string): string {
  return `${streamerId}:${twitchUsername}`;
}

/**
 * Claims the shared points cooldown for a (streamer, viewer) pair if they're currently off
 * cooldown, recording the claim time. Used by both passive chat-earn and `!gamble`, so a viewer
 * can't alternate between the two to bypass either one's cooldown.
 * @param streamerId - The streamer's `streamer.id`.
 * @param twitchUsername - The viewer's Twitch login.
 * @param cooldownSeconds - The streamer's configured (or default) cooldown length.
 * @returns True if the claim succeeded (caller may proceed); false if still on cooldown.
 */
export function tryClaimPointsCooldown(streamerId: number, twitchUsername: string, cooldownSeconds: number): boolean {
  const key = cooldownKey(streamerId, twitchUsername);
  const now = Date.now();
  if (now - (lastEarnedAt.get(key) ?? 0) < cooldownSeconds * 1000) return false;
  lastEarnedAt.set(key, now);
  return true;
}

/** Test-only: clears every recorded points cooldown claim, so tests don't bleed state into
 *  each other through this module-level map. */
export function clearPointsCooldowns(): void {
  lastEarnedAt.clear();
}

/**
 * Awards passive chat-earn loyalty points to a viewer if they're off cooldown, using the
 * streamer's configured rate/cooldown (or the app's defaults if unconfigured). No-ops silently
 * if the viewer is still on cooldown.
 * @param streamerId - The streamer's `streamer.id`.
 * @param twitchUsername - The viewer's Twitch login.
 * @returns Resolves once the award (or no-op) completes.
 */
export async function awardPointsForChatMessage(streamerId: number, twitchUsername: string): Promise<void> {
  const config = await getLoyaltyPointsConfig(streamerId);
  const cooldownSeconds = config?.cooldownSeconds ?? DEFAULT_POINTS_COOLDOWN_SECONDS;
  if (!tryClaimPointsCooldown(streamerId, twitchUsername, cooldownSeconds)) return;
  await adjustLoyaltyPointsBalance(streamerId, twitchUsername, config?.pointsPerMessage ?? DEFAULT_POINTS_PER_MESSAGE);
}

/**
 * Awards a sub/resub loyalty-points bonus, using the streamer's configured amount (or the app's
 * default if unconfigured). Unlike passive chat-earn, this has no cooldown — Twitch itself
 * already rate-limits how often a viewer can sub/resub.
 * @param streamerId - The streamer's `streamer.id`.
 * @param twitchUsername - The subscribing viewer's Twitch login.
 * @returns Resolves once the award completes.
 */
export async function awardPointsForSub(streamerId: number, twitchUsername: string): Promise<void> {
  const config = await getLoyaltyPointsConfig(streamerId);
  await adjustLoyaltyPointsBalance(streamerId, twitchUsername, config?.pointsPerSub ?? DEFAULT_POINTS_PER_SUB);
}

/**
 * Awards a gift-sub loyalty-points bonus to the gifter, scaled by the number of subs gifted,
 * using the streamer's configured per-sub amount (or the app's default if unconfigured).
 * @param streamerId - The streamer's `streamer.id`.
 * @param gifterUsername - The gifter's Twitch login.
 * @param count - Number of subs gifted.
 * @returns Resolves once the award completes.
 */
export async function awardPointsForGiftSub(streamerId: number, gifterUsername: string, count: number): Promise<void> {
  const config = await getLoyaltyPointsConfig(streamerId);
  await adjustLoyaltyPointsBalance(streamerId, gifterUsername, (config?.pointsPerGiftSub ?? DEFAULT_POINTS_PER_GIFT_SUB) * count);
}
