import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./pool', () => ({ getPool: vi.fn() }));
vi.mock('mysql2/promise', () => ({ default: {} }));

import { getPool } from './pool';
import {
  listCompanionConfirmationRewardIds, isCompanionConfirmationRequired, setCompanionConfirmationRequired,
  recordPendingRedemptionAck, claimRedemptionAck, releaseRedemptionAck, updateRedemptionAckStatus,
  getRedemptionAckStreamerId, listPendingRedemptionAcks, pruneResolvedRedemptionAcks,
} from './redemptionCompanionAck';
import { makeMockPool } from '../test-utils/mockMysqlPool';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('reward_companion_confirmation', () => {
  it('lists a streamer\'s confirmation rewards as a set', async () => {
    const pool = makeMockPool({ rows: [{ twitch_reward_id: 'a' }, { twitch_reward_id: 'b' }] });
    vi.mocked(getPool).mockReturnValue(pool as any);

    await expect(listCompanionConfirmationRewardIds(3)).resolves.toEqual(new Set(['a', 'b']));
    expect(pool.execute.mock.calls[0]![1]).toEqual([3]);
  });

  it('reports whether one reward requires confirmation', async () => {
    vi.mocked(getPool).mockReturnValue(makeMockPool({ rows: [{ 1: 1 }] }) as any);
    await expect(isCompanionConfirmationRequired(3, 'a')).resolves.toBe(true);
    vi.mocked(getPool).mockReturnValue(makeMockPool({ rows: [] }) as any);
    await expect(isCompanionConfirmationRequired(3, 'a')).resolves.toBe(false);
  });

  it('turns confirmation on with a row-alias upsert, and off with a delete', async () => {
    const pool = makeMockPool({ executeResult: [{ affectedRows: 1 }, []] });
    vi.mocked(getPool).mockReturnValue(pool as any);

    await setCompanionConfirmationRequired(3, 'a', true);
    await setCompanionConfirmationRequired(3, 'a', false);

    const [onSql, onParams] = pool.execute.mock.calls[0]!;
    expect(onSql).toContain('INSERT INTO reward_companion_confirmation (streamer_id, twitch_reward_id) VALUES (?, ?) AS new_row');
    expect(onParams).toEqual([3, 'a']);
    const [offSql, offParams] = pool.execute.mock.calls[1]!;
    expect(offSql).toContain('DELETE FROM reward_companion_confirmation WHERE streamer_id = ? AND twitch_reward_id = ?');
    expect(offParams).toEqual([3, 'a']);
  });
});

describe('redemption_companion_ack', () => {
  const ROW = {
    redemption_id: 'r1', streamer_id: 3, twitch_reward_id: 'a', reward_title: 'Lights', user_login: 'alice', redeemed_at_ms: '1700000000000',
  };

  it('records a pending redemption, leaving an existing row alone, and reports it pending', async () => {
    const pool = makeMockPool();
    pool.execute.mockResolvedValueOnce([{ affectedRows: 1 }, []]).mockResolvedValueOnce([[{ status: 'pending' }], []]);
    vi.mocked(getPool).mockReturnValue(pool as any);

    await expect(recordPendingRedemptionAck({
      redemptionId: 'r1', streamerId: 3, twitchRewardId: 'a', rewardTitle: 'Lights', userLogin: 'alice', redeemedAtMs: 5,
    })).resolves.toBe(true);

    const [sql, params] = pool.execute.mock.calls[0]!;
    expect(sql).toContain('ON DUPLICATE KEY UPDATE redemption_id = new_row.redemption_id');
    expect(params).toEqual(['r1', 3, 'a', 'Lights', 'alice', 5]);
    expect(pool.execute.mock.calls[1]![1]).toEqual(['r1']);
  });

  // affectedRows is 1 for a no-op duplicate-key update too (mysql2 sets CLIENT_FOUND_ROWS), so it
  // must never decide: only the stored status does.
  it.each([
    ['pending', 0, true],
    ['refunded', 0, false],
    ['refunded', 1, false],
    ['refund_failed', 1, false],
    ['fulfilled', 1, false],
  ])('on a retry, reports an existing %s row (affectedRows %i) as pending only if it is', async (status, affectedRows, expected) => {
    const pool = makeMockPool();
    pool.execute.mockResolvedValueOnce([{ affectedRows }, []]).mockResolvedValueOnce([[{ status }], []]);
    vi.mocked(getPool).mockReturnValue(pool as any);

    await expect(recordPendingRedemptionAck({
      redemptionId: 'r1', streamerId: 3, twitchRewardId: 'a', rewardTitle: 'Lights', userLogin: 'alice', redeemedAtMs: 5,
    })).resolves.toBe(expected);
  });

  it('claims a pending row and returns it, with the BIGINT timestamp as a number', async () => {
    const pool = makeMockPool();
    pool.execute
      .mockResolvedValueOnce([{ affectedRows: 1 }, []])
      .mockResolvedValueOnce([[ROW], []]);
    vi.mocked(getPool).mockReturnValue(pool as any);

    await expect(claimRedemptionAck('r1', { status: 'refunded', refundReason: 'no_ack', errorMessage: 'x'.repeat(300) })).resolves.toEqual({
      redemptionId: 'r1', streamerId: 3, twitchRewardId: 'a', rewardTitle: 'Lights', userLogin: 'alice', redeemedAtMs: 1700000000000,
    });
    const [sql, params] = pool.execute.mock.calls[0]!;
    expect(sql).toContain("WHERE redemption_id = ? AND status = 'pending'");
    expect(params).toEqual(['refunded', 'no_ack', 'x'.repeat(255), 'r1']);
  });

  it('returns null when the row was no longer pending', async () => {
    const pool = makeMockPool({ executeResult: [{ affectedRows: 0 }, []] });
    vi.mocked(getPool).mockReturnValue(pool as any);

    await expect(claimRedemptionAck('r1', { status: 'fulfilled' })).resolves.toBeNull();
    expect(pool.execute).toHaveBeenCalledTimes(1);
  });

  it('returns null if the claimed row disappeared before it could be read', async () => {
    const pool = makeMockPool();
    pool.execute.mockResolvedValueOnce([{ affectedRows: 1 }, []]).mockResolvedValueOnce([[], []]);
    vi.mocked(getPool).mockReturnValue(pool as any);

    await expect(claimRedemptionAck('r1', { status: 'fulfilled' })).resolves.toBeNull();
  });

  it('releases a claim back to pending and updates a status', async () => {
    const pool = makeMockPool({ executeResult: [{ affectedRows: 1 }, []] });
    vi.mocked(getPool).mockReturnValue(pool as any);

    await releaseRedemptionAck('r1');
    await updateRedemptionAckStatus('r1', 'refund_failed', 'nope');

    expect(pool.execute.mock.calls[0]![0]).toContain("SET status = 'pending'");
    expect(pool.execute.mock.calls[0]![1]).toEqual(['r1']);
    expect(pool.execute.mock.calls[1]![1]).toEqual(['refund_failed', 'nope', 'r1']);
  });

  it('looks up the owning streamer', async () => {
    vi.mocked(getPool).mockReturnValue(makeMockPool({ rows: [{ streamer_id: 3 }] }) as any);
    await expect(getRedemptionAckStreamerId('r1')).resolves.toBe(3);
    vi.mocked(getPool).mockReturnValue(makeMockPool({ rows: [] }) as any);
    await expect(getRedemptionAckStreamerId('r1')).resolves.toBeNull();
  });

  it('lists pending redemption ids', async () => {
    vi.mocked(getPool).mockReturnValue(makeMockPool({ rows: [{ redemption_id: 'r1' }, { redemption_id: 'r2' }] }) as any);
    await expect(listPendingRedemptionAcks()).resolves.toEqual(['r1', 'r2']);
  });

  it('prunes only resolved rows older than the retention', async () => {
    const pool = makeMockPool({ executeResult: [{ affectedRows: 4 }, []] });
    vi.mocked(getPool).mockReturnValue(pool as any);

    await expect(pruneResolvedRedemptionAcks(1500)).resolves.toBe(4);
    const [sql, params] = pool.execute.mock.calls[0]!;
    expect(sql).toContain("status <> 'pending'");
    expect(params).toEqual([2]);
  });
});
