import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./logger', () => ({ createLogger: () => ({ info: vi.fn(), error: vi.fn() }) }));

import {
  executeCountdownForTwitch,
  registerCountdownTwitchRuntime,
} from './countdownHandler';

const mockRuntime = { send: vi.fn() };

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mockRuntime.send.mockResolvedValue(undefined);
  registerCountdownTwitchRuntime(mockRuntime);
});

afterEach(() => vi.useRealTimers());

describe('executeCountdownForTwitch', () => {
  it('does nothing for commands other than !321', async () => {
    await executeCountdownForTwitch('#chan', '!other', true);
    expect(mockRuntime.send).not.toHaveBeenCalled();
  });

  it('does nothing when isMod is false', async () => {
    await executeCountdownForTwitch('#chan', '!321', false);
    expect(mockRuntime.send).not.toHaveBeenCalled();
  });

  it('sends all four countdown steps in order with 1s delays', async () => {
    const promise = executeCountdownForTwitch('#chan', '!321', true);

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

    const promise = executeCountdownForTwitch('#chan', '!321', true);

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    await promise;

    // Only '3' and the failed '2' were attempted; '1' and 'Go!' never sent
    expect(mockRuntime.send).toHaveBeenCalledTimes(2);
  });

  it('does nothing when no runtime is registered', async () => {
    registerCountdownTwitchRuntime(null as any);
    await executeCountdownForTwitch('#chan', '!321', true);
    expect(mockRuntime.send).not.toHaveBeenCalled();
  });
});
