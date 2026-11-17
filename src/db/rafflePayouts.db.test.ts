import { describe, it, expect } from 'vitest';
import { createRafflePayouts, isRafflePayoutPaid, payRafflePayout } from './rafflePayouts';
import { getBalance } from './loyaltyPoints';
import { insertRow } from '../test-utils/realDbRows';
import { getPool } from './pool';

// The raffle payout ledger against a real MySQL (npm run test:db): a payout credits the winner
// once, a second attempt on the same row (a retry after an ambiguous commit) doesn't pay again,
// and a draw can't record the same winner twice. isRafflePayoutPaid's locking read waits for a
// credit still in flight on another connection (the lost-reply case), which only a real server shows.

/**
 * Starts a transaction on its own connection that marks `payoutId` paid and holds the row lock
 * until the returned `finish` commits or rolls it back.
 */
async function holdPaidUpdate(payoutId: string) {
  const conn = await getPool().getConnection();
  await conn.beginTransaction();
  await conn.execute('UPDATE raffle_payout SET paid_at = CURRENT_TIMESTAMP WHERE id = ?', [payoutId]);
  return async (outcome: 'commit' | 'rollback') => {
    try {
      await (outcome === 'commit' ? conn.commit() : conn.rollback());
    } finally {
      conn.release();
    }
  };
}

/** Creates one unpaid payout row and returns its id. */
async function newPayoutId(raffleId: string): Promise<string> {
  const streamerId = Number((await insertRow('streamer')).id);
  return (await createRafflePayouts(raffleId, streamerId, ['a'], 10))[0]!.id;
}

describe('raffle payouts (real MySQL)', () => {
  it('credits each winner exactly once, however often the payout is retried', async () => {
    const streamerId = Number((await insertRow('streamer')).id);
    const payouts = await createRafflePayouts('11111111-1111-4111-8111-111111111111', streamerId, ['a', 'b'], 40);
    expect(payouts.map((p) => p.twitchUsername)).toEqual(['a', 'b']);

    expect(await isRafflePayoutPaid(payouts[0]!.id)).toBe(false);
    expect(await payRafflePayout(payouts[0]!.id)).toBe('paid');
    expect(await isRafflePayoutPaid(payouts[0]!.id)).toBe(true);
    expect(await payRafflePayout(payouts[0]!.id)).toBe('already_paid');
    expect(await getBalance(streamerId, 'a')).toBe(40);
    expect(await getBalance(streamerId, 'b')).toBe(0);

    expect(await payRafflePayout(payouts[1]!.id)).toBe('paid');
    expect(await getBalance(streamerId, 'b')).toBe(40);
  });

  it('refuses a second row for the same winner of the same draw', async () => {
    const streamerId = Number((await insertRow('streamer')).id);
    const raffleId = '22222222-2222-4222-8222-222222222222';
    await createRafflePayouts(raffleId, streamerId, ['a'], 10);
    await expect(createRafflePayouts(raffleId, streamerId, ['a'], 10)).rejects.toMatchObject({ code: 'ER_DUP_ENTRY' });
  });

  it('waits for an in-flight credit and reports paid once it commits', async () => {
    const payoutId = await newPayoutId('33333333-3333-4333-8333-333333333333');
    const finish = await holdPaidUpdate(payoutId);
    const check = isRafflePayoutPaid(payoutId);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await finish('commit');
    expect(await check).toBe(true);
  });

  it('waits for an in-flight credit and reports unpaid once it rolls back', async () => {
    const payoutId = await newPayoutId('44444444-4444-4444-8444-444444444444');
    const finish = await holdPaidUpdate(payoutId);
    const check = isRafflePayoutPaid(payoutId);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await finish('rollback');
    expect(await check).toBe(false);
  });

  it('gives up with a lock wait timeout if the in-flight credit never finishes', async () => {
    const payoutId = await newPayoutId('55555555-5555-4555-8555-555555555555');
    const finish = await holdPaidUpdate(payoutId);
    try {
      await expect(isRafflePayoutPaid(payoutId)).rejects.toMatchObject({ code: 'ER_LOCK_WAIT_TIMEOUT' });
    } finally {
      await finish('rollback');
    }
  }, 15_000);
});
