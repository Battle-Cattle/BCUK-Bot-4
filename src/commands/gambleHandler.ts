import { createLogger } from '../shared/logger';
import { getLoyaltyPointsBalance, adjustLoyaltyPointsBalance, getLoyaltyPointsConfig, DEFAULT_POINTS_COOLDOWN_SECONDS } from '../db';
import { resolveCommand, extractArgs } from './commandUtils';
import { createRuntimeRegistry } from '../shared/runtimeRegistry';
import type { TwitchSendRuntime } from './twitchRuntime';
import { parseGambleAmount } from './gambleAmount';
import { tryClaimPointsCooldown } from './pointsEarnHandler';

const log = createLogger('Gamble');

const GAMBLE_COMMAND = '!gamble';
const USAGE_MESSAGE = 'Usage: !gamble <amount>, where <amount> is a number (e.g. 100, 1,000, 5k), a percentage of your balance (e.g. 40%), or "all". The amount must be at least 1 and no more than your current balance.';

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
 * Flips a 50/50 coin for a validated bet — winning credits the bet amount (doubling it net),
 * losing debits it — and formats the resulting chat reply.
 * @param streamerId - The streamer's `streamer.id`.
 * @param twitchUsername - The gambling viewer's Twitch login.
 * @param bet - The already-validated bet amount.
 * @returns The chat reply describing the outcome and new balance.
 */
async function resolveGamble(streamerId: number, twitchUsername: string, bet: number): Promise<string> {
  const won = Math.random() < 0.5;
  const newBalance = await adjustLoyaltyPointsBalance(streamerId, twitchUsername, won ? bet : -bet);

  return won
    ? `@${twitchUsername} won ${bet} points! New balance: ${newBalance}`
    : `@${twitchUsername} lost ${bet} points. New balance: ${newBalance}`;
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
 * cooldown), and sends the result via the registered Twitch runtime. An invalid amount gets a
 * usage reply without consuming the cooldown — only an actual gamble does that.
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

  const bet = await resolveBet(streamerId, username, extractArgs(rawMessage));
  if (bet === null) {
    await sendGambleMessage(channel, USAGE_MESSAGE);
    return;
  }

  const config = await getLoyaltyPointsConfig(streamerId);
  const cooldownSeconds = config?.cooldownSeconds ?? DEFAULT_POINTS_COOLDOWN_SECONDS;
  if (!tryClaimPointsCooldown(streamerId, username, cooldownSeconds)) return;

  await sendGambleMessage(channel, await resolveGamble(streamerId, username, bet));
}
