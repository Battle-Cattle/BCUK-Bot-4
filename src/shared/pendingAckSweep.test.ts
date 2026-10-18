import { describe, it, expect, vi } from 'vitest';
import { sweepPendingAcks } from './pendingAckSweep';

describe('sweepPendingAcks', () => {
  it('refunds untracked ids, counts the ones it resolved, and hands failures on without stopping', async () => {
    const onFailure = vi.fn();
    const refund = vi.fn(async (id: string) => {
      if (id === 'boom') throw new Error('db down');
      return id !== 'already';
    });

    const resolved = await sweepPendingAcks({
      pendingIds: ['a', 'tracked', 'boom', 'already', 'b'],
      isTracked: (id) => id === 'tracked',
      refund,
      onFailure,
    });

    expect(resolved).toBe(2);
    expect(refund.mock.calls.map(([id]) => id)).toEqual(['a', 'boom', 'already', 'b']);
    expect(onFailure).toHaveBeenCalledWith('boom', expect.any(Error));
  });
});
