import { getLoyaltyPointsConfig, adjustLoyaltyPointsBalance, isExcludedFromLoyaltyPoints, type LoyaltyPointsConfig } from '../db';

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
 * Returns how many whole seconds remain before a (streamer, viewer) pair is off the shared points
 * cooldown, without claiming it. Used to give `!gamble` a concrete "try again in Ns" reply when
 * {@link tryClaimPointsCooldown} has just failed for it — the claim time this reads is whatever a
 * prior claim (passive chat-earn, or an earlier `!gamble`) left behind, since a failed claim never
 * writes to `lastEarnedAt`.
 * @param streamerId - The streamer's `streamer.id`.
 * @param twitchUsername - The viewer's Twitch login.
 * @param cooldownSeconds - The streamer's configured (or default) cooldown length.
 * @returns Whole seconds remaining, rounded up; 0 if the pair is already off cooldown.
 */
export function getRemainingCooldownSeconds(streamerId: number, twitchUsername: string, cooldownSeconds: number): number {
  const key = cooldownKey(streamerId, twitchUsername);
  const elapsedMs = Date.now() - (lastEarnedAt.get(key) ?? 0);
  const remainingMs = cooldownSeconds * 1000 - elapsedMs;
  return remainingMs > 0 ? Math.ceil(remainingMs / 1000) : 0;
}

/**
 * Looks up the streamer's config for an award, returning it only if the streamer has opted into
 * Loyalty Points and the recipient isn't on their "Exclude bot" list. Every award path goes
 * through this, so an excluded bot never earns points from chat, subs, or gift subs.
 * @param streamerId - The streamer's `streamer.id`.
 * @param twitchUsername - The recipient's Twitch login.
 * @returns The streamer's config, or null if no award should be made.
 */
async function getConfigIfEligible(streamerId: number, twitchUsername: string): Promise<LoyaltyPointsConfig | null> {
  const config = await getLoyaltyPointsConfig(streamerId);
  if (!config?.enabled) return null;
  if (await isExcludedFromLoyaltyPoints(streamerId, twitchUsername)) return null;
  return config;
}

/**
 * Awards passive chat-earn loyalty points to a viewer if they're off cooldown, using the
 * streamer's configured rate/cooldown. No-ops silently if the streamer hasn't opted into Loyalty
 * Points (no config row, or `enabled: false`), if the viewer is an excluded bot, or if the viewer
 * is still on cooldown.
 * @param streamerId - The streamer's `streamer.id`.
 * @param twitchUsername - The viewer's Twitch login.
 * @returns Resolves once the award (or no-op) completes.
 */
export async function awardPointsForChatMessage(streamerId: number, twitchUsername: string): Promise<void> {
  const config = await getConfigIfEligible(streamerId, twitchUsername);
  if (!config) return;
  if (!tryClaimPointsCooldown(streamerId, twitchUsername, config.cooldownSeconds)) return;
  await adjustLoyaltyPointsBalance(streamerId, twitchUsername, config.pointsPerMessage);
}

/**
 * Awards a sub/resub loyalty-points bonus, using the streamer's configured amount. No-ops
 * silently if the streamer hasn't opted into Loyalty Points or the subscriber is an excluded bot.
 * Unlike passive chat-earn, this has
 * no cooldown — Twitch itself already rate-limits how often a viewer can sub/resub.
 * @param streamerId - The streamer's `streamer.id`.
 * @param twitchUsername - The subscribing viewer's Twitch login.
 * @returns Resolves once the award (or no-op) completes.
 */
export async function awardPointsForSub(streamerId: number, twitchUsername: string): Promise<void> {
  const config = await getConfigIfEligible(streamerId, twitchUsername);
  if (!config) return;
  await adjustLoyaltyPointsBalance(streamerId, twitchUsername, config.pointsPerSub);
}

/**
 * Awards a gift-sub loyalty-points bonus to the gifter, scaled by the number of subs gifted,
 * using the streamer's configured per-sub amount. No-ops silently if the streamer hasn't opted
 * into Loyalty Points or the gifter is an excluded bot.
 * @param streamerId - The streamer's `streamer.id`.
 * @param gifterUsername - The gifter's Twitch login.
 * @param count - Number of subs gifted.
 * @returns Resolves once the award (or no-op) completes.
 */
export async function awardPointsForGiftSub(streamerId: number, gifterUsername: string, count: number): Promise<void> {
  const config = await getConfigIfEligible(streamerId, gifterUsername);
  if (!config) return;
  await adjustLoyaltyPointsBalance(streamerId, gifterUsername, config.pointsPerGiftSub * count);
}
