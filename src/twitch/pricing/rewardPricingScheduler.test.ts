import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/** Hoisted so the `vi.mock('../../shared/logger', ...)` factory below can safely reference it — `vi.mock` factories are hoisted above imports, so a plain imported binding could throw `ReferenceError` depending on import order. */
const { mockLogger } = vi.hoisted(() => ({
  mockLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

/** Mocks the shared logger so the scheduler's log calls don't produce real output during tests. */
vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));
vi.mock('../../db', () => ({ getAllEnabledPricingRows: vi.fn(), getPricingSettingsForStreamer: vi.fn() }));
vi.mock('./rewardPricingService', () => ({ applyDecayTick: vi.fn() }));

import { getAllEnabledPricingRows, getPricingSettingsForStreamer } from '../../db';
import { applyDecayTick } from './rewardPricingService';
import { runDecayTick, startRewardPricingScheduler, stopRewardPricingScheduler } from './rewardPricingScheduler';

const settings = { half_life_seconds: 1800, time_to_max_multiplier: 2 };

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.mocked(getPricingSettingsForStreamer).mockResolvedValue(settings);
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

    expect(applyDecayTick).toHaveBeenCalledWith(1, 'r1', settings);
    expect(applyDecayTick).toHaveBeenCalledWith(2, 'r2', settings);
  });

  it('fetches settings once per distinct streamer, not once per reward', async () => {
    vi.mocked(getAllEnabledPricingRows).mockResolvedValue([
      { streamer_id: 1, twitch_reward_id: 'r1' },
      { streamer_id: 1, twitch_reward_id: 'r2' },
      { streamer_id: 2, twitch_reward_id: 'r3' },
    ] as any);
    vi.mocked(applyDecayTick).mockResolvedValue(undefined);

    await runDecayTick();

    expect(getPricingSettingsForStreamer).toHaveBeenCalledTimes(2);
    expect(getPricingSettingsForStreamer).toHaveBeenCalledWith(1);
    expect(getPricingSettingsForStreamer).toHaveBeenCalledWith(2);
    expect(applyDecayTick).toHaveBeenCalledWith(1, 'r1', settings);
    expect(applyDecayTick).toHaveBeenCalledWith(1, 'r2', settings);
    expect(applyDecayTick).toHaveBeenCalledWith(2, 'r3', settings);
  });

  it('falls back to an undefined settings hint for a streamer whose settings prefetch fails, without blocking other streamers', async () => {
    vi.mocked(getAllEnabledPricingRows).mockResolvedValue([
      { streamer_id: 1, twitch_reward_id: 'r1' },
      { streamer_id: 2, twitch_reward_id: 'r2' },
    ] as any);
    vi.mocked(getPricingSettingsForStreamer).mockImplementation(async (streamerId) => {
      if (streamerId === 1) throw new Error('settings db down');
      return settings;
    });
    vi.mocked(applyDecayTick).mockResolvedValue(undefined);

    await expect(runDecayTick()).resolves.toBeUndefined();

    expect(applyDecayTick).toHaveBeenCalledWith(1, 'r1', undefined);
    expect(applyDecayTick).toHaveBeenCalledWith(2, 'r2', settings);
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
    // Flush microtasks until the second row starts (or give up after a bounded number of
    // ticks) — the batched per-streamer settings prefetch now adds a variable number of
    // hops before applyDecayTick is reached, so a fixed tick count is too fragile here.
    for (let i = 0; i < 20 && !secondStarted; i++) {
      await Promise.resolve();
    }

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

  it('pauses polling when the DB server itself is shutting down, and resumes once it recovers', async () => {
    const shutdownError = Object.assign(new Error('Server shutdown in progress'), { code: 'ER_SERVER_SHUTDOWN', errno: 1053 });
    vi.mocked(getAllEnabledPricingRows).mockRejectedValueOnce(shutdownError);
    startRewardPricingScheduler();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(getAllEnabledPricingRows).toHaveBeenCalledTimes(1);

    // Regular 30s cadence should not fire again — polling is paused.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(getAllEnabledPricingRows).toHaveBeenCalledTimes(1);

    // The DB recovers before the 60s probe fires.
    vi.mocked(getAllEnabledPricingRows).mockResolvedValue([]);
    await vi.advanceTimersByTimeAsync(30_000); // completes the 60s probe delay
    expect(getAllEnabledPricingRows).toHaveBeenCalledTimes(2);

    // Normal cadence resumes.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(getAllEnabledPricingRows).toHaveBeenCalledTimes(3);
  });

  it('keeps retrying every 60s while the DB server stays down', async () => {
    const shutdownError = Object.assign(new Error('Server shutdown in progress'), { code: 'ER_SERVER_SHUTDOWN', errno: 1053 });
    vi.mocked(getAllEnabledPricingRows).mockRejectedValue(shutdownError);
    startRewardPricingScheduler();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(getAllEnabledPricingRows).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(getAllEnabledPricingRows).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(getAllEnabledPricingRows).toHaveBeenCalledTimes(3);
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
