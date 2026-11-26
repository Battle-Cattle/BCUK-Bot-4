// Pays raffle winners through the `raffle_payout` ledger, so each winner is credited at most once
// even when a credit is retried after a commit whose reply never arrived, and tells the streamer
// (on the dashboard's "Recent Events" feed) about any winner who may not have been paid.
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { createLogger } from '../../shared/logger';
import {
  createRafflePayouts, fitStreamerEventText, isRafflePayoutPaid, payRafflePayout, recordStreamerEvent, type RafflePayout,
} from '../../db';
import { dashboardEventRuntimeRegistry } from '../../twitch/eventsub/twitchEventSubRuntime';

const log = createLogger('Raffle');

/** Delays before each retry of a failed credit; one more attempt than there are entries here. */
export const RAFFLE_PAYOUT_RETRY_DELAYS_MS: readonly number[] = [1_000, 3_000];

/** How one winner's payout ended. */
type PayoutStatus = 'paid' | 'unpaid' | 'unconfirmed';

/** Which winners of a draw were credited, which weren't, and which couldn't be confirmed either way. */
export interface RafflePayoutOutcome {
  /** Winners whose points were added, in draw order. */
  paid: string[];
  /** Winners whose points weren't added, in draw order. */
  unpaid: string[];
  /** Winners whose last credit attempt failed and whose ledger row couldn't then be read, in draw order. */
  unconfirmed: string[];
}

/**
 * Settles a payout whose last credit attempt failed. That attempt may still have committed (its
 * reply lost), so the ledger row decides: paid, unpaid, or unconfirmed if it can't be read either.
 * @param streamerId - The streamer's `streamer.id`, for the log.
 * @param payout - The winner's ledger row.
 * @param err - The last credit attempt's error.
 * @returns The winner's payout status.
 */
async function settleFailedPayout(streamerId: number, payout: RafflePayout, err: unknown): Promise<PayoutStatus> {
  const label = `raffle winner ${payout.twitchUsername} (streamer ${streamerId}, payout ${payout.id})`;
  try {
    if (await isRafflePayoutPaid(payout.id)) {
      log.warn(`Last credit attempt for ${label} reported an error but had committed:`, err);
      return 'paid';
    }
    log.error(`Failed to pay ${label}:`, err);
    return 'unpaid';
  } catch (checkErr) {
    log.error(`Failed to pay ${label}, and couldn't check whether the last attempt committed:`, err, checkErr);
    return 'unconfirmed';
  }
}

/**
 * Credits one ledger row, retrying a failure after each of {@link RAFFLE_PAYOUT_RETRY_DELAYS_MS}.
 * The ledger makes a retry safe: a credit that committed on an earlier attempt reports
 * `already_paid` instead of paying again. Once `signal` aborts (shutdown) no further attempt
 * starts; the payout is settled from the ledger instead.
 * @param streamerId - The streamer's `streamer.id`, for the log.
 * @param payout - The winner's ledger row.
 * @param signal - Aborted when the bot is shutting down, to skip any remaining retries.
 * @returns The winner's payout status.
 */
async function payWithRetries(streamerId: number, payout: RafflePayout, signal: AbortSignal): Promise<PayoutStatus> {
  for (let attempt = 0; ; attempt++) {
    try {
      await payRafflePayout(payout.id);
      return 'paid';
    } catch (err) {
      const delay = RAFFLE_PAYOUT_RETRY_DELAYS_MS[attempt];
      if (delay === undefined || signal.aborted) return settleFailedPayout(streamerId, payout, err);
      log.warn(`Raffle payout ${payout.id} failed (attempt ${attempt + 1}); retrying in ${delay}ms:`, err);
      try {
        await sleep(delay, undefined, { signal });
      } catch {
        return settleFailedPayout(streamerId, payout, err);
      }
    }
  }
}

/**
 * Records a "raffle prize not paid" entry on the streamer's dashboard feed and pushes it to any
 * open dashboard. Each is attempted even if the other fails, so an open dashboard still hears of
 * it during a database outage. Best-effort: failures are logged.
 * @param streamerId - The streamer's `streamer.id`.
 * @param winner - Twitch login of the winner.
 * @param detail - What happened, e.g. `100 points couldn't be added`.
 */
async function notifyStreamerOfFailedPayout(streamerId: number, winner: string, detail: string): Promise<void> {
  const fitted = fitStreamerEventText(winner, detail);
  let eventId: number | null = null;
  try {
    eventId = await recordStreamerEvent(streamerId, 'raffle_payout_failed', fitted.displayName, fitted.detail);
  } catch (err) {
    log.error(`Failed to record unpaid raffle winner ${winner} for streamer ${streamerId}:`, err);
  }
  try {
    dashboardEventRuntimeRegistry.get()?.pushDashboardEvent(streamerId, {
      // No id when the row couldn't be recorded: the page then shows the push without de-duplicating it.
      ...(eventId === null ? {} : { id: eventId }), eventType: 'raffle_payout_failed', ...fitted, occurredAt: new Date().toISOString(),
    });
  } catch (err) {
    log.error(`Failed to push unpaid raffle winner ${winner} to streamer ${streamerId}'s dashboard:`, err);
  }
}

/**
 * Pays each winner `share` points: writes one ledger row per winner, then credits them in
 * parallel, each with its own retries. If the ledger can't be written nobody is paid (paying
 * without it would make retries unsafe). Every winner not confirmed paid is reported on the
 * streamer's dashboard.
 * @param streamerId - The streamer's `streamer.id` the points belong to.
 * @param winners - Distinct Twitch logins of the winners, in draw order.
 * @param share - Points each winner gets; at least 1 when there are winners.
 * @param signal - Aborted when the bot is shutting down, to skip any remaining retries.
 * @returns Which winners were paid, which weren't, and which couldn't be confirmed.
 */
export async function payRaffleWinners(
  streamerId: number,
  winners: readonly string[],
  share: number,
  signal: AbortSignal,
): Promise<RafflePayoutOutcome> {
  const outcome: RafflePayoutOutcome = { paid: [], unpaid: [], unconfirmed: [] };
  if (winners.length === 0) return outcome;
  let statuses: PayoutStatus[];
  try {
    const payouts = await createRafflePayouts(randomUUID(), streamerId, winners, share);
    statuses = await Promise.all(payouts.map((payout) => payWithRetries(streamerId, payout, signal)));
  } catch (err) {
    log.error(`Failed to record raffle payouts for streamer ${streamerId}; nobody was paid:`, err);
    statuses = winners.map(() => 'unpaid');
  }
  const points = share.toLocaleString('en-GB');
  await Promise.all(winners.map(async (winner, i) => {
    const status = statuses[i]!; // one status per winner, in the same order
    outcome[status].push(winner);
    if (status === 'unpaid') await notifyStreamerOfFailedPayout(streamerId, winner, `${points} points couldn't be added`);
    if (status === 'unconfirmed') await notifyStreamerOfFailedPayout(streamerId, winner, `${points} points may not have been added`);
  }));
  return outcome;
}
