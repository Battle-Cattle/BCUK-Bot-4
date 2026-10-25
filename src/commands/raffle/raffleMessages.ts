/** How long a raffle accepts entries, in seconds. */
export const RAFFLE_DURATION_SECONDS = 60;

/** Usage reply for a `!raffle` with a missing or invalid amount. */
export const RAFFLE_USAGE_MESSAGE = 'Usage: !raffle <amount>, e.g. !raffle 100 or !raffle 1K';

/**
 * Formats a points amount with thousands separators (`1,000`).
 * @param amount - Points amount to format.
 * @returns The amount as display text.
 */
function formatPoints(amount: number): string {
  return amount.toLocaleString('en-GB');
}

/**
 * Builds the announcement posted when a raffle starts. During a shared-chat session it adds that
 * entries from shared chat don't count, because the bot only reads `!join` in the broadcaster's own chat.
 * @param channel - Twitch login of the broadcaster's channel.
 * @param amount - Total points up for grabs.
 * @param sharedChat - Whether the channel is in a shared-chat session right now.
 * @returns The chat message.
 */
export function buildRaffleStartMessage(channel: string, amount: number, sharedChat: boolean): string {
  const warning = sharedChat ? ' Entries from shared chat don\'t count.' : '';
  return `🎟️ RAFFLE! ${formatPoints(amount)} points up for grabs. Type !join here in ${channel}'s chat in the next `
    + `${RAFFLE_DURATION_SECONDS}s to enter.${warning}`;
}

/**
 * Builds the reminder posted every 15 seconds while a raffle is open, with the shared-chat
 * warning during a shared-chat session.
 * @param channel - Twitch login of the broadcaster's channel.
 * @param amount - Total points up for grabs.
 * @param secondsLeft - Seconds until the raffle closes.
 * @param entries - Number of viewers entered so far.
 * @param sharedChat - Whether the channel is in a shared-chat session right now.
 * @returns The chat message.
 */
export function buildRaffleReminderMessage(
  channel: string,
  amount: number,
  secondsLeft: number,
  entries: number,
  sharedChat: boolean,
): string {
  const warning = sharedChat ? ' (shared chat doesn\'t count)' : '';
  return `⏰ ${secondsLeft}s left in the ${formatPoints(amount)}-point raffle. Type !join in ${channel}'s own chat to enter`
    + `${warning}. Entries so far: ${entries}.`;
}

/**
 * Builds the reply to a `!raffle` while another raffle is still open in the channel.
 * @param secondsLeft - Seconds until the open raffle closes.
 * @returns The chat message.
 */
export function buildRaffleAlreadyRunningMessage(secondsLeft: number): string {
  return `A raffle is already running. It ends in ${secondsLeft}s.`;
}

/**
 * Joins names into readable English: `a`, `a and b`, `a, b and c`.
 * @param names - Names to join.
 * @returns The joined text.
 */
function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * Builds the result announcement once a raffle closes.
 * @param entries - Number of viewers who entered.
 * @param winners - Twitch logins of the winners, in draw order.
 * @param share - Points each winner received.
 * @returns The chat message.
 */
export function buildRaffleResultMessage(entries: number, winners: readonly string[], share: number): string {
  if (winners.length === 0) return 'Raffle over. Nobody entered, so no points were given out.';
  const entryText = `${entries} ${entries === 1 ? 'entry' : 'entries'}`;
  const tagged = joinNames(winners.map((w) => `@${w}`));
  if (winners.length === 1) return `🎉 Raffle over! ${entryText}, 1 winner: ${tagged} wins ${formatPoints(share)} points!`;
  return `🎉 Raffle over! ${entryText}, ${winners.length} winners: ${tagged} win ${formatPoints(share)} points each!`;
}
