import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../shared/logger', () => ({ createLogger: () => ({ info: vi.fn(), error: vi.fn() }) }));
vi.mock('../shared/config', () => ({ GLOBAL_COOLDOWN_MS: 3_000 }));

import {
  executeCountdownForTwitch,
  registerCountdownTwitchRuntime,
} from './countdownHandler';

const mockRuntime = { send: vi.fn() };

// Base time far in the future, advanced further each test so any cooldown claim left over
// from a previous test (same channel key) has already expired — matches the pattern in
// counterHandler.test.ts.
const COOLDOWN_MS = 3_000;
let mockNow = 1_000_000_000_000;

beforeEach(() => {
  mockNow += COOLDOWN_MS + 1_000;
  vi.useFakeTimers();
  vi.setSystemTime(mockNow);
  vi.clearAllMocks();
  mockRuntime.send.mockResolvedValue(undefined);
  registerCountdownTwitchRuntime(mockRuntime);
});

afterEach(() => vi.useRealTimers());

describe('executeCountdownForTwitch', () => {
  it('does nothing for commands other than !321', async () => {
    await executeCountdownForTwitch('#chan', '!other');
    expect(mockRuntime.send).not.toHaveBeenCalled();
  });

  it('sends all four countdown steps in order with 1s delays', async () => {
    const promise = executeCountdownForTwitch('#chan', '!321');

    // First step sent immediately
    await vi.advanceTimersByTimeAsync(0);
    expect(mockRuntime.send).toHaveBeenNthCalledWith(1, '#chan', '3');

    // Second step after 1s
    await vi.advanceTimersByTimeAsync(1000);
    expect(mockRuntime.send).toHaveBeenNthCalledWith(2, '#chan', '2');

    // Third step after another 1s
    await vi.advanceTimersByTimeAsync(1000);
    expect(mockRuntime.send).toHaveBeenNthCalledWith(3, '#chan', '1');

    // Final step after another 1s
    await vi.advanceTimersByTimeAsync(1000);
    expect(mockRuntime.send).toHaveBeenNthCalledWith(4, '#chan', 'Go!');

    await promise;
    expect(mockRuntime.send).toHaveBeenCalledTimes(4);
  });

  it('stops sending when a step fails', async () => {
    mockRuntime.send
      .mockResolvedValueOnce(undefined) // '3' succeeds
      .mockRejectedValueOnce(new Error('Rate limited')); // '2' fails

    const promise = executeCountdownForTwitch('#chan', '!321');

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    await promise;

    // Only '3' and the failed '2' were attempted; '1' and 'Go!' never sent
    expect(mockRuntime.send).toHaveBeenCalledTimes(2);
  });

  it('does nothing when no runtime is registered', async () => {
    registerCountdownTwitchRuntime(null as any);
    await executeCountdownForTwitch('#chan', '!321');
    expect(mockRuntime.send).not.toHaveBeenCalled();
  });
});

describe('countdown cooldown', () => {
  it('blocks a second !321 in the same channel within the cooldown window', async () => {
    // Both calls claim/check the cooldown synchronously before their first await, so issuing
    // them back-to-back deterministically exercises the claim vs. blocked-claim paths.
    const first = executeCountdownForTwitch('#chan', '!321');
    const second = executeCountdownForTwitch('#chan', '!321');

    await vi.advanceTimersByTimeAsync(3000);
    await Promise.all([first, second]);

    // Only the first call's 4 steps were sent; the second was blocked by cooldown.
    expect(mockRuntime.send).toHaveBeenCalledTimes(4);

    // Once the cooldown window has elapsed, the channel can claim again.
    await vi.advanceTimersByTimeAsync(COOLDOWN_MS + 1);
    const retry = executeCountdownForTwitch('#chan', '!321');
    await vi.advanceTimersByTimeAsync(3000);
    await retry;
    expect(mockRuntime.send).toHaveBeenCalledTimes(8);
  });

  it("does not apply one channel's cooldown to another channel", async () => {
    const chanA = executeCountdownForTwitch('#chan-a', '!321');
    const chanB = executeCountdownForTwitch('#chan-b', '!321');

    await vi.advanceTimersByTimeAsync(3000);
    await Promise.all([chanA, chanB]);

    expect(mockRuntime.send).toHaveBeenCalledTimes(8);
  });

  it('blocks a second !321 while the first countdown is still running, even after the cooldown expires', async () => {
    // Make the first countdown's sends slow so it outlasts the 3s cooldown window.
    mockRuntime.send.mockImplementation(() => new Promise<void>((resolve) => setTimeout(resolve, 500)));

    const first = executeCountdownForTwitch('#chan-slow', '!321');
    await vi.advanceTimersByTimeAsync(COOLDOWN_MS + 1);
    // Cooldown has elapsed but the first countdown hasn't sent 'Go!' yet.
    expect(mockRuntime.send).toHaveBeenCalledTimes(3);
    const second = executeCountdownForTwitch('#chan-slow', '!321');

    await vi.advanceTimersByTimeAsync(5_000);
    await Promise.all([first, second]);
    expect(mockRuntime.send).toHaveBeenCalledTimes(4);

    // Once the first finished (and the cooldown has passed), a new countdown can start.
    await vi.advanceTimersByTimeAsync(COOLDOWN_MS + 1);
    const third = executeCountdownForTwitch('#chan-slow', '!321');
    await vi.advanceTimersByTimeAsync(10_000);
    await third;
    expect(mockRuntime.send).toHaveBeenCalledTimes(8);
  });

  it('releases the in-progress guard when a step fails', async () => {
    mockRuntime.send.mockRejectedValueOnce(new Error('boom'));
    await executeCountdownForTwitch('#chan-fail', '!321');
    expect(mockRuntime.send).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(COOLDOWN_MS + 1);
    const retry = executeCountdownForTwitch('#chan-fail', '!321');
    await vi.advanceTimersByTimeAsync(3000);
    await retry;
    expect(mockRuntime.send).toHaveBeenCalledTimes(5);
  });
});
