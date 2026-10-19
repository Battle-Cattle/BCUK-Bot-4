import { getLoyaltyPointsConfig, adjustLoyaltyPointsBalance, isExcludedFromLoyaltyPoints, type LoyaltyPointsConfig } from '../db';
import { createPerViewerCooldown } from './perViewerCooldown';

// Passive chat-earn's own per-(streamer, viewer) cooldown. Deliberately separate from `!gamble`'s
// (see gambleHandler.ts): chatting or running other commands must never put `!gamble` on cooldown.
const chatEarnCooldown = createPerViewerCooldown();

/** Test-only: clears every recorded chat-earn cooldown claim, so tests don't bleed state into
 *  each other through this module-level state. */
export function clearPointsCooldowns(): void {
  chatEarnCooldown.clear();
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
  if (!chatEarnCooldown.tryClaim(streamerId, twitchUsername, config.cooldownSeconds)) return;
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
