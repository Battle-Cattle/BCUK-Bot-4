import { createLogger } from '../shared/logger';
import { getLoyaltyPointsBalance, getLoyaltyPointsLeaderboard, getLoyaltyPointsConfig } from '../db';
import { resolveCommand, extractArgs } from './commandUtils';
import { createRuntimeRegistry } from '../shared/runtimeRegistry';
import type { TwitchSendRuntime } from './twitchRuntime';

const log = createLogger('Points');

/** The `!points` command token. Exported so `twitchBot.ts` can skip the passive chat-earn award
 *  for a `!points` message itself — `!points` has no cooldown of its own, but chat-earn and
 *  `!gamble` share one cooldown, so without this exemption checking your balance would silently
 *  claim that shared cooldown and block an immediately-following `!gamble` for up to its full
 *  duration, with no feedback. */
export const POINTS_COMMAND = '!points';
const LEADERBOARD_SIZE = 5;
const LEADERBOARD_SUBCOMMANDS = new Set(['leaderboard', 'top']);

// ─── Twitch runtime (registered from index.ts before startTwitchBot) ─────────
//
// Same pattern as counterHandler.ts to avoid a circular import between twitchBot.ts and
// pointsHandler.ts.

const pointsRuntime = createRuntimeRegistry<TwitchSendRuntime>();

/** Stores the Twitch chat runtime used to send points responses. Call once from index.ts after the Twitch bot is ready. */
export function registerPointsTwitchRuntime(runtime: TwitchSendRuntime): void {
  pointsRuntime.register(runtime);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Formats the leaderboard as a single-line, rank-numbered chat message. */
function formatLeaderboard(entries: { twitchUsername: string; balance: number }[]): string {
  if (entries.length === 0) return 'No one has earned any points yet.';
  return entries.map((entry, index) => `${index + 1}. ${entry.twitchUsername} (${entry.balance})`).join(', ');
}

/**
 * Builds the `!points` response for a viewer: either the channel's points leaderboard
 * (`!points leaderboard`/`!points top`) or the caller's own balance (`!points`/`!points
 * balance`, or any other/no subcommand). Intentionally has no cooldown — every viewer can
 * check their balance or the leaderboard at any time, since both are cheap reads with no
 * side effects.
 *
 * @param streamerId - The streamer's `streamer.id`.
 * @param twitchUsername - The requesting viewer's Twitch login.
 * @param args - The text following `!points`, used to pick the subcommand.
 * @returns The chat message to send.
 */
async function buildPointsResponse(streamerId: number, twitchUsername: string, args: string): Promise<string> {
  const subcommand = args.split(/\s+/)[0]?.toLowerCase() ?? '';
  if (LEADERBOARD_SUBCOMMANDS.has(subcommand)) {
    return formatLeaderboard(await getLoyaltyPointsLeaderboard(streamerId, LEADERBOARD_SIZE));
  }

  const balance = await getLoyaltyPointsBalance(streamerId, twitchUsername);
  return `@${twitchUsername} has ${balance} point${balance === 1 ? '' : 's'}.`;
}

/**
 * Handles a Twitch chat message that may be a `!points` command: checks the caller's balance
 * or the channel's leaderboard, and sends the result via the registered Twitch runtime. No-ops
 * silently if the streamer hasn't opted into Loyalty Points for their channel.
 *
 * @param channel - Twitch channel the message was sent in (also the send target).
 * @param streamerId - The channel's linked `streamer.id`, resolved by the caller — no-ops
 *   without one, since points are per-streamer and there's nothing to look up otherwise.
 * @param rawMessage - Raw chat message text.
 * @param username - Twitch login of the sender; no-ops without one.
 * @param precomputedCommand - Already-parsed command token from the caller's single
 *   `extractCommand` call for this message, or omit to parse `rawMessage` here.
 * @returns Resolves once the send (or a no-op) has completed.
 */
export async function executePointsCommandForTwitch(
  channel: string,
  streamerId: number | null,
  rawMessage: string,
  username?: string | null,
  precomputedCommand?: string | null,
): Promise<void> {
  const command = resolveCommand(rawMessage, precomputedCommand);
  if (command !== POINTS_COMMAND) return;
  if (!streamerId || !username) return;

  const config = await getLoyaltyPointsConfig(streamerId);
  if (!config?.enabled) return;

  const response = await buildPointsResponse(streamerId, username, extractArgs(rawMessage));

  const runtime = pointsRuntime.get();
  if (runtime) {
    try {
      await runtime.send(channel, response);
      log.info(`[Twitch] Sent points response in ${channel}.`);
    } catch (err) {
      log.error(`[Twitch] Failed to send points response in ${channel}:`, err);
    }
  }
}
