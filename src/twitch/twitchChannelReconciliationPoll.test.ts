import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockLog = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('../shared/logger', () => ({ createLogger: () => mockLog }));
vi.mock('./twitchChannelMembership', () => ({ reconcileJoinedChannels: vi.fn() }));

import { startChannelReconciliationPoll, stopChannelReconciliationPoll } from './twitchChannelReconciliationPoll';
import { reconcileJoinedChannels } from './twitchChannelMembership';

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.mocked(reconcileJoinedChannels).mockResolvedValue(undefined);
});

afterEach(() => {
  stopChannelReconciliationPoll();
  vi.useRealTimers();
});

describe('startChannelReconciliationPoll / stopChannelReconciliationPoll', () => {
  it('fires reconcileJoinedChannels on the configured interval and stops on request', async () => {
    startChannelReconciliationPoll();

    expect(reconcileJoinedChannels).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reconcileJoinedChannels).toHaveBeenCalledTimes(1);

    stopChannelReconciliationPoll();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reconcileJoinedChannels).toHaveBeenCalledTimes(1);
  });

  it('does not leak the interval when started twice without stopping', async () => {
    startChannelReconciliationPoll();
    startChannelReconciliationPoll();

    await vi.advanceTimersByTimeAsync(60_000);

    // A duplicate interval would have fired reconcileJoinedChannels twice in this window.
    expect(reconcileJoinedChannels).toHaveBeenCalledTimes(1);
  });

  it('logs and does not throw when reconcileJoinedChannels rejects', async () => {
    vi.mocked(reconcileJoinedChannels).mockRejectedValueOnce(new Error('reconcile boom'));
    startChannelReconciliationPoll();

    await vi.advanceTimersByTimeAsync(60_000);

    expect(mockLog.error).toHaveBeenCalledWith('Periodic channel reconciliation error:', expect.any(Error));
  });

  it('is a no-op when the poll was never started', () => {
    expect(() => stopChannelReconciliationPoll()).not.toThrow();
  });
});
