import { describe, it, expect } from 'vitest';
import { adjustBalance, MAX_BALANCE } from './loyaltyPoints';
import { insertRow } from '../test-utils/realDbRows';

// adjustBalance's upsert against a real MySQL (npm run test:db): the first adjustment inserts the
// row, later ones add to it, the balance is clamped to [0, MAX_BALANCE] either way, and the new
// balance comes back through LAST_INSERT_ID(…), which only a real server evaluates.

describe('adjustBalance (real MySQL)', () => {
  it('inserts on the first adjustment and adds on later ones, returning the new balance', async () => {
    const streamerId = Number((await insertRow('streamer')).id);

    expect(await adjustBalance(streamerId, 'viewer', 50)).toBe(50);
    expect(await adjustBalance(streamerId, 'viewer', 25)).toBe(75);
    expect(await adjustBalance(streamerId, 'viewer', -30)).toBe(45);
  });

  it('clamps the balance at zero and at the maximum, on insert and on update', async () => {
    const streamerId = Number((await insertRow('streamer')).id);

    expect(await adjustBalance(streamerId, 'spender', -10)).toBe(0);
    expect(await adjustBalance(streamerId, 'spender', -10)).toBe(0);
    expect(await adjustBalance(streamerId, 'hoarder', MAX_BALANCE)).toBe(MAX_BALANCE);
    expect(await adjustBalance(streamerId, 'hoarder', 1)).toBe(MAX_BALANCE);
  });

  it('keeps balances per streamer and viewer', async () => {
    const first = Number((await insertRow('streamer')).id);
    const second = Number((await insertRow('streamer')).id);
    await adjustBalance(first, 'viewer', 10);

    expect(await adjustBalance(second, 'viewer', 1)).toBe(1);
    expect(await adjustBalance(first, 'other', 2)).toBe(2);
  });
});
