import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockLogger } from '../../test-utils/loggerMock';

vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));
vi.mock('../../db', () => ({ getAllEnabledPricingRows: vi.fn() }));
vi.mock('./rewardPricingService', () => ({ applyDecayTick: vi.fn() }));

import { getAllEnabledPricingRows } from '../../db';
import { applyDecayTick } from './rewardPricingService';
import { runDecayTick, startRewardPricingScheduler, stopRewardPricingScheduler } from './rewardPricingScheduler';

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});

afterEach(async () => {
  await stopRewardPricingScheduler();
  vi.useRealTimers();
});

describe('runDecayTick', () => {
  it('calls applyDecayTick for every enabled row', async () => {
    vi.mocked(getAllEnabledPricingRows).mockResolvedValue([
      { streamer_id: 1, twitch_reward_id: 'r1' },
      { streamer_id: 2, twitch_reward_id: 'r2' },
    ] as any);
    vi.mocked(applyDecayTick).mockResolvedValue(undefined);

    await runDecayTick();

    expect(applyDecayTick).toHaveBeenCalledWith(1, 'r1');
    expect(applyDecayTick).toHaveBeenCalledWith(2, 'r2');
  });

  it('continues to the next row when one fails', async () => {
    vi.mocked(getAllEnabledPricingRows).mockResolvedValue([
      { streamer_id: 1, twitch_reward_id: 'r1' },
      { streamer_id: 2, twitch_reward_id: 'r2' },
    ] as any);
    vi.mocked(applyDecayTick).mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(undefined);

    await expect(runDecayTick()).resolves.toBeUndefined();
    expect(applyDecayTick).toHaveBeenCalledTimes(2);
  });

  it('does not throw when loading rows fails', async () => {
    vi.mocked(getAllEnabledPricingRows).mockRejectedValue(new Error('db down'));
    await expect(runDecayTick()).resolves.toBeUndefined();
  });

  it('processes rows concurrently rather than waiting for each to finish in turn', async () => {
    vi.mocked(getAllEnabledPricingRows).mockResolvedValue([
      { streamer_id: 1, twitch_reward_id: 'r1' },
      { streamer_id: 2, twitch_reward_id: 'r2' },
    ] as any);

    let resolveFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { resolveFirst = resolve; });
    let secondStarted = false;

    vi.mocked(applyDecayTick).mockImplementation(async (streamerId) => {
      if (streamerId === 1) {
        await firstGate; // blocks the first row until released below
      } else {
        secondStarted = true; // only reachable if the second row didn't wait for the first
      }
    });

    const tick = runDecayTick();
    await Promise.resolve();
    await Promise.resolve();

    expect(secondStarted).toBe(true); // second row started without waiting for the first to resolve

    resolveFirst();
    await tick;
  });
});

describe('startRewardPricingScheduler / stopRewardPricingScheduler', () => {
  it('fires runDecayTick on the configured interval', async () => {
    vi.mocked(getAllEnabledPricingRows).mockResolvedValue([]);
    startRewardPricingScheduler();

    expect(getAllEnabledPricingRows).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(getAllEnabledPricingRows).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(getAllEnabledPricingRows).toHaveBeenCalledTimes(2);
  });

  it('does not leak the interval when started twice without stopping', async () => {
    vi.mocked(getAllEnabledPricingRows).mockResolvedValue([]);
    startRewardPricingScheduler();
    startRewardPricingScheduler(); // second call should no-op, not replace the tracked handle

    await vi.advanceTimersByTimeAsync(30_000);
    // If the second call had leaked a duplicate interval, this would be 2.
    expect(getAllEnabledPricingRows).toHaveBeenCalledTimes(1);

    await stopRewardPricingScheduler();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(getAllEnabledPricingRows).toHaveBeenCalledTimes(1); // fully stopped, no orphaned timer still firing
  });

  it('stop prevents further ticks', async () => {
    vi.mocked(getAllEnabledPricingRows).mockResolvedValue([]);
    startRewardPricingScheduler();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(getAllEnabledPricingRows).toHaveBeenCalledTimes(1);

    await stopRewardPricingScheduler();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(getAllEnabledPricingRows).toHaveBeenCalledTimes(1);
  });

  it('a reentrancy guard prevents overlapping ticks', async () => {
    let resolveFirst!: () => void;
    const gate = new Promise<void>((resolve) => { resolveFirst = resolve; });
    vi.mocked(getAllEnabledPricingRows).mockImplementation(async () => {
      await gate;
      return [];
    });

    const first = runDecayTick();
    const second = runDecayTick(); // should not trigger a second getAllEnabledPricingRows call

    resolveFirst();
    await Promise.all([first, second]);

    expect(getAllEnabledPricingRows).toHaveBeenCalledTimes(1);
  });
});
