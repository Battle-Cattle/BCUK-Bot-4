// `raffle_payout`: one row per raffle winner, the ledger that makes each winner's credit happen at
// most once. Rows are written before any points move; `paid_at` is set in the same transaction as
// the `loyalty_points` credit, so retrying a credit whose commit was ambiguous can't pay twice.
import mysql from 'mysql2/promise';
import { getPool, runInTransaction, withTransaction } from './pool';
import { withShortLockTimeout } from './shortLockTimeout';
import { adjustBalanceOnConn } from './loyaltyPoints';

/** One winner's pending payout, as returned by {@link createRafflePayouts}. */
export interface RafflePayout {
  /** `raffle_payout.id`; {@link payRafflePayout} takes it. */
  id: string;
  twitchUsername: string;
}

/** Outcome of {@link payRafflePayout}: `paid` by this call, or `already_paid` by an earlier one. */
export type RafflePayoutResult = 'paid' | 'already_paid';

/**
 * Records one unpaid payout row per winner of a raffle draw, in a single statement.
 * @param raffleId - UUID of the draw, shared by its rows.
 * @param streamerId - The streamer's `streamer.id` the points belong to.
 * @param winners - Distinct Twitch logins of the winners; must not be empty.
 * @param amount - Points each winner is owed; at least 1.
 * @returns Each winner's payout row, in the order given.
 */
export async function createRafflePayouts(
  raffleId: string,
  streamerId: number,
  winners: readonly string[],
  amount: number,
): Promise<RafflePayout[]> {
  const placeholders = winners.map(() => '(?, ?, ?, ?)').join(', ');
  const params = winners.flatMap((winner) => [raffleId, streamerId, winner, amount]);
  await getPool().execute<mysql.ResultSetHeader>(
    `INSERT INTO raffle_payout (raffle_id, streamer_id, twitch_username, amount) VALUES ${placeholders}`,
    params,
  );
  // Read the ids back by the draw's key rather than relying on consecutive AUTO_INCREMENT values.
  // `id` is a BIGINT, so it comes back as a string (bigNumberStrings) and stays one.
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    'SELECT id, twitch_username FROM raffle_payout WHERE raffle_id = ?',
    [raffleId],
  );
  const ids = new Map(rows.map((row) => [row.twitch_username as string, String(row.id)]));
  return winners.map((winner) => {
    const id = ids.get(winner);
    if (!id) throw new Error(`raffle_payout row for ${winner} missing after insert`);
    return { id, twitchUsername: winner };
  });
}

/**
 * Whether a payout row has been paid. Used to settle a credit whose last attempt failed, since
 * that attempt may have committed even though its reply never arrived. A locking read
 * (`FOR SHARE`), so if that attempt's transaction is still finishing on the server this waits for
 * its commit or rollback instead of reading the row as it was before; a plain `SELECT` would see
 * the old unpaid version. The wait is capped at 5s, after which this throws (lock wait timeout).
 * @param payoutId - `raffle_payout.id` of the row.
 * @returns True if `paid_at` is set.
 */
export async function isRafflePayoutPaid(payoutId: string): Promise<boolean> {
  return withShortLockTimeout((conn) => runInTransaction(conn, async () => {
    const [rows] = await conn.execute<mysql.RowDataPacket[]>(
      'SELECT paid_at FROM raffle_payout WHERE id = ? FOR SHARE',
      [payoutId],
    );
    const row = rows[0];
    if (!row) throw new Error(`raffle_payout ${payoutId} not found`);
    return row.paid_at !== null;
  }));
}

/**
 * Credits one winner's payout, at most once: locks the row, and only if it's still unpaid adds its
 * amount to the winner's balance and sets `paid_at`, both in one transaction. Safe to retry after
 * a failure, including one where the commit reached the server but its reply didn't.
 * @param payoutId - `raffle_payout.id` of the row to pay.
 * @returns `paid` if this call credited the winner, `already_paid` if an earlier call had.
 */
export async function payRafflePayout(payoutId: string): Promise<RafflePayoutResult> {
  return withTransaction(async (conn) => {
    const [rows] = await conn.execute<mysql.RowDataPacket[]>(
      'SELECT streamer_id, twitch_username, amount, paid_at FROM raffle_payout WHERE id = ? FOR UPDATE',
      [payoutId],
    );
    const row = rows[0];
    if (!row) throw new Error(`raffle_payout ${payoutId} not found`);
    if (row.paid_at !== null) return 'already_paid';
    await adjustBalanceOnConn(conn, row.streamer_id, row.twitch_username, row.amount);
    await conn.execute('UPDATE raffle_payout SET paid_at = CURRENT_TIMESTAMP WHERE id = ?', [payoutId]);
    return 'paid';
  });
}
