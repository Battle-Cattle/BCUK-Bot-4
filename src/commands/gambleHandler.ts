import { createLogger } from '../shared/logger';
import { getLoyaltyPointsBalance, resolveLoyaltyPointsGambleOutcome, getLoyaltyPointsConfig, isExcludedFromLoyaltyPoints, type LoyaltyPointsConfig } from '../db';
import { resolveCommand, extractArgs } from './commandUtils';
import { createRuntimeRegistry } from '../shared/runtimeRegistry';
import type { TwitchSendRuntime } from './twitchRuntime';
import { parseGambleAmount } from './gambleAmount';
import { tryClaimPointsCooldown, getRemainingCooldownSeconds } from './pointsEarnHandler';

const log = createLogger('Gamble');

/** The `!gamble` command token. Exported so `twitchBot.ts` can skip the passive chat-earn
 *  award for a `!gamble` message itself, which would otherwise race `executeGambleCommandForTwitch`
 *  for the same shared points cooldown and almost always win it first (its config lookup is a
 *  cache hit, where gamble's balance lookup is an uncached DB query) — silently dropping the bet. */
export const GAMBLE_COMMAND = '!gamble';
const USAGE_MESSAGE = 'Usage: !gamble <amount>, where <amount> is a number (e.g. 100, 1,000, 5k), a percentage of your balance (e.g. 40%), or "all". The amount must be at least 1 and no more than your current balance.';
const BALANCE_CHANGED_MESSAGE = 'Your balance changed before that bet could be placed — try again.';

// ─── Twitch runtime (registered from index.ts before startTwitchBot) ─────────
//
// Same pattern as pointsHandler.ts/counterHandler.ts to avoid a circular import between
// twitchBot.ts and gambleHandler.ts.

const gambleRuntime = createRuntimeRegistry<TwitchSendRuntime>();

/** Stores the Twitch chat runtime used to send gamble results. Call once from index.ts after the Twitch bot is ready. */
export function registerGambleTwitchRuntime(runtime: TwitchSendRuntime): void {
  gambleRuntime.register(runtime);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Parses and validates a `!gamble` bet amount against the caller's current balance.
 * @param streamerId - The streamer's `streamer.id`.
 * @param twitchUsername - The gambling viewer's Twitch login.
 * @param amountToken - The raw bet-amount text following `!gamble`.
 * @returns The validated bet amount, or null if it didn't parse/validate.
 */
async function resolveBet(streamerId: number, twitchUsername: string, amountToken: string): Promise<number | null> {
  const balance = await getLoyaltyPointsBalance(streamerId, twitchUsername);
  return parseGambleAmount(amountToken, balance);
}

/**
 * Flips a 50/50 coin for a validated bet and formats the resulting chat reply. The coin flip
 * happens first, then the stake debit and (on a win) the payout credit happen together in one
 * atomic call (via {@link resolveLoyaltyPointsGambleOutcome}), rather than trusting the balance
 * `bet` was validated against and rather than two separate writes — without the first guard, two
 * concurrent bets (e.g. two `!gamble all` messages) could both validate against the same pre-bet
 * balance and both proceed; without the second, a debit could commit and a separate payout credit
 * then fail, leaving the viewer's stake gone with no winnings.
 * @param streamerId - The streamer's `streamer.id`.
 * @param twitchUsername - The gambling viewer's Twitch login.
 * @param bet - The already-validated bet amount.
 * @returns The chat reply describing the outcome and new balance, or null if the stake couldn't
 *   be debited (the balance changed since `bet` was validated against it).
 */
async function resolveGamble(streamerId: number, twitchUsername: string, bet: number): Promise<string | null> {
  const won = Math.random() < 0.5;
  const newBalance = await resolveLoyaltyPointsGambleOutcome(streamerId, twitchUsername, bet, won);
  if (newBalance === null) return null;

  if (!won) return `@${twitchUsername} lost ${bet} points. New balance: ${newBalance}`;
  return `@${twitchUsername} won ${bet} points! New balance: ${newBalance}`;
}

/**
 * Looks up the streamer's config for a `!gamble`, returning it only if the streamer has opted into
 * Loyalty Points and the sender isn't on their "Exclude bot" list.
 * @param streamerId - The streamer's `streamer.id`.
 * @param twitchUsername - The gambling viewer's Twitch login.
 * @returns The streamer's config, or null if this gamble should be silently ignored.
 */
async function getConfigIfAllowedToGamble(streamerId: number, twitchUsername: string): Promise<LoyaltyPointsConfig | null> {
  const config = await getLoyaltyPointsConfig(streamerId);
  if (!config || !config.enabled) return null;
  if (await isExcludedFromLoyaltyPoints(streamerId, twitchUsername)) return null;
  return config;
}

/** Sends `message` to `channel` via the registered Twitch runtime, logging (rather than
 *  throwing) on failure. No-ops if no runtime has been registered yet. */
async function sendGambleMessage(channel: string, message: string): Promise<void> {
  const runtime = gambleRuntime.get();
  if (!runtime) return;
  try {
    await runtime.send(channel, message);
    log.info(`[Twitch] Sent gamble result in ${channel}.`);
  } catch (err) {
    log.error(`[Twitch] Failed to send gamble result in ${channel}:`, err);
  }
}

/**
 * Handles a Twitch chat message that may be a `!gamble` command: parses the bet amount (a plain
 * number, `1,000`, `5k`, `40%`, or `all`), enforces the shared points cooldown (the same one
 * passive chat-earn uses, so a viewer can't alternate between the two to dodge either one's
 * cooldown), and sends the result via the registered Twitch runtime. No-ops silently if the
 * streamer hasn't opted into Loyalty Points, or if the sender is on the streamer's "Exclude bot"
 * list (an excluded bot keeps whatever balance it had, but can't gamble it). An invalid amount gets a usage reply without
 * consuming the cooldown — only an actual gamble does that. A bet still on cooldown gets a
 * "try again in Ns" reply rather than silence, since the cooldown can be claimed by something
 * other than the viewer's own prior `!gamble` (passive chat-earn, including other commands —
 * see `twitchBot.ts`'s chat-earn dispatch), which was confusing with no feedback at all.
 *
 * @param channel - Twitch channel the message was sent in (also the send target).
 * @param streamerId - The channel's linked `streamer.id`, resolved by the caller — no-ops
 *   without one, since points are per-streamer and there's nothing to gamble against otherwise.
 * @param rawMessage - Raw chat message text.
 * @param username - Twitch login of the sender; no-ops without one.
 * @param precomputedCommand - Already-parsed command token from the caller's single
 *   `extractCommand` call for this message, or omit to parse `rawMessage` here.
 * @returns Resolves once the send (or a no-op) has completed.
 */
export async function executeGambleCommandForTwitch(
  channel: string,
  streamerId: number | null,
  rawMessage: string,
  username?: string | null,
  precomputedCommand?: string | null,
): Promise<void> {
  const command = resolveCommand(rawMessage, precomputedCommand);
  if (command !== GAMBLE_COMMAND) return;
  if (!streamerId || !username) return;

  const config = await getConfigIfAllowedToGamble(streamerId, username);
  if (!config) return;

  const bet = await resolveBet(streamerId, username, extractArgs(rawMessage));
  if (bet === null) {
    await sendGambleMessage(channel, USAGE_MESSAGE);
    return;
  }

  if (!tryClaimPointsCooldown(streamerId, username, config.cooldownSeconds)) {
    const remaining = getRemainingCooldownSeconds(streamerId, username, config.cooldownSeconds);
    await sendGambleMessage(channel, `@${username} still on cooldown — try again in ${remaining}s.`);
    return;
  }

  const result = await resolveGamble(streamerId, username, bet);
  await sendGambleMessage(channel, result ?? BALANCE_CHANGED_MESSAGE);
}
