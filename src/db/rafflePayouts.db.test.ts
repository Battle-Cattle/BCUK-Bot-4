import { describe, it, expect } from 'vitest';
import { createRafflePayouts, isRafflePayoutPaid, payRafflePayout } from './rafflePayouts';
import { getBalance } from './loyaltyPoints';
import { insertRow } from '../test-utils/realDbRows';

// The raffle payout ledger against a real MySQL (npm run test:db): a payout credits the winner
// once, a second attempt on the same row (a retry after an ambiguous commit) doesn't pay again,
// and a draw can't record the same winner twice.

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
});
