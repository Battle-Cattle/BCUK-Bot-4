// Pays raffle winners through the `raffle_payout` ledger, so each winner is credited at most once
// even when a credit is retried after a commit whose reply never arrived, and tells the streamer
// (on the dashboard's "Recent Events" feed) about any winner whose points couldn't be added.
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { createLogger } from '../../shared/logger';
import { createRafflePayouts, fitStreamerEventText, payRafflePayout, recordStreamerEvent, type RafflePayout } from '../../db';
import { dashboardEventRuntimeRegistry } from '../../twitch/eventsub/twitchEventSubRuntime';

const log = createLogger('Raffle');

/** Delays before each retry of a failed credit; one more attempt than there are entries here. */
export const RAFFLE_PAYOUT_RETRY_DELAYS_MS: readonly number[] = [1_000, 3_000];

/** Which winners of a draw were credited and which weren't. */
export interface RafflePayoutOutcome {
  /** Winners whose points were added, in draw order. */
  paid: string[];
  /** Winners whose points couldn't be added, in draw order. */
  unpaid: string[];
}

/**
 * Credits one ledger row, retrying a failure after each of {@link RAFFLE_PAYOUT_RETRY_DELAYS_MS}.
 * The ledger makes a retry safe: a credit that committed on an earlier attempt reports
 * `already_paid` instead of paying again. Stops retrying once `signal` aborts (shutdown).
 * @param streamerId - The streamer's `streamer.id`, for the log.
 * @param payout - The winner's ledger row.
 * @param signal - Aborted when the bot is shutting down, to skip any remaining retries.
 * @returns True if the winner has been paid, by this call or an earlier one.
 */
async function payWithRetries(streamerId: number, payout: RafflePayout, signal: AbortSignal): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    try {
      await payRafflePayout(payout.id);
      return true;
    } catch (err) {
      const delay = RAFFLE_PAYOUT_RETRY_DELAYS_MS[attempt];
      if (delay === undefined || signal.aborted) {
        log.error(`Failed to pay raffle winner ${payout.twitchUsername} (streamer ${streamerId}, payout ${payout.id}):`, err);
        return false;
      }
      log.warn(`Raffle payout ${payout.id} failed (attempt ${attempt + 1}); retrying in ${delay}ms:`, err);
      try {
        await sleep(delay, undefined, { signal });
      } catch {
        // Aborted mid-wait: the next attempt is the last one.
      }
    }
  }
}

/**
 * Records a "raffle prize not paid" entry on the streamer's dashboard feed and pushes it to any
 * open dashboard. Best-effort: a failure is logged, since the chat message already said so.
 * @param streamerId - The streamer's `streamer.id`.
 * @param winner - Twitch login of the winner who wasn't paid.
 * @param share - Points the winner was owed.
 */
async function notifyStreamerOfUnpaidWinner(streamerId: number, winner: string, share: number): Promise<void> {
  const fitted = fitStreamerEventText(winner, `${share.toLocaleString('en-GB')} points couldn't be added`);
  try {
    await recordStreamerEvent(streamerId, 'raffle_payout_failed', fitted.displayName, fitted.detail);
    dashboardEventRuntimeRegistry.get()?.pushDashboardEvent(streamerId, {
      eventType: 'raffle_payout_failed', ...fitted, occurredAt: new Date().toISOString(),
    });
  } catch (err) {
    log.error(`Failed to record unpaid raffle winner ${winner} for streamer ${streamerId}:`, err);
  }
}

/**
 * Pays each winner `share` points: writes one ledger row per winner, then credits them in
 * parallel, each with its own retries. If the ledger can't be written nobody is paid (paying
 * without it would make retries unsafe). Every unpaid winner is reported on the streamer's dashboard.
 * @param streamerId - The streamer's `streamer.id` the points belong to.
 * @param winners - Distinct Twitch logins of the winners, in draw order.
 * @param share - Points each winner gets; at least 1 when there are winners.
 * @param signal - Aborted when the bot is shutting down, to skip any remaining retries.
 * @returns Which winners were paid and which weren't.
 */
export async function payRaffleWinners(
  streamerId: number,
  winners: readonly string[],
  share: number,
  signal: AbortSignal,
): Promise<RafflePayoutOutcome> {
  if (winners.length === 0) return { paid: [], unpaid: [] };
  let payouts: RafflePayout[];
  try {
    payouts = await createRafflePayouts(randomUUID(), streamerId, winners, share);
  } catch (err) {
    log.error(`Failed to record raffle payouts for streamer ${streamerId}; nobody was paid:`, err);
    payouts = [];
  }
  const results = await Promise.all(payouts.map((payout) => payWithRetries(streamerId, payout, signal)));
  const paid = payouts.filter((_payout, i) => results[i]).map((payout) => payout.twitchUsername);
  const unpaid = winners.filter((winner) => !paid.includes(winner));
  await Promise.all(unpaid.map((winner) => notifyStreamerOfUnpaidWinner(streamerId, winner, share)));
  return { paid, unpaid };
}
