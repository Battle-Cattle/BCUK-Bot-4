import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { throttledChannelSend, __resetTwitchSendQueueForTests } from './twitchSendQueue';

const INTERVAL_MS = 1_500;

beforeEach(() => {
  vi.useFakeTimers();
  __resetTwitchSendQueueForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('throttledChannelSend', () => {
  it('runs the first send for a channel immediately', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    await throttledChannelSend('streamer', send, INTERVAL_MS);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('delays a second send to the same channel until the spacing interval elapses', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    await throttledChannelSend('streamer', send, INTERVAL_MS);

    const second = throttledChannelSend('streamer', send, INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_499);
    expect(send).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await second;
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('does not delay sends to different channels', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    await throttledChannelSend('streamer-a', send, INTERVAL_MS);
    await throttledChannelSend('streamer-b', send, INTERVAL_MS);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('keeps queued sends for a channel in enqueue order', async () => {
    const order: string[] = [];
    const makeSend = (label: string) => vi.fn().mockImplementation(async () => { order.push(label); });

    const p1 = throttledChannelSend('streamer', makeSend('a'), INTERVAL_MS);
    const p2 = throttledChannelSend('streamer', makeSend('b'), INTERVAL_MS);
    const p3 = throttledChannelSend('streamer', makeSend('c'), INTERVAL_MS);

    await vi.advanceTimersByTimeAsync(3_000);
    await Promise.all([p1, p2, p3]);

    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('does not shrink the spacing of queued sends when an earlier send fails', async () => {
    const failing = vi.fn().mockRejectedValue(new Error('boom'));
    const succeeding = vi.fn().mockResolvedValue(undefined);

    const first = throttledChannelSend('streamer', failing, INTERVAL_MS);
    const second = throttledChannelSend('streamer', succeeding, INTERVAL_MS);

    await expect(first).rejects.toThrow('boom');

    await vi.advanceTimersByTimeAsync(1_499);
    expect(succeeding).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await second;
    expect(succeeding).toHaveBeenCalledTimes(1);
  });

  it('schedules the following send using the minIntervalMs passed to the current call, not a prior one', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    // First call schedules the next slot 1.5s out — a later call can't retroactively shrink
    // the wait it's already queued behind, so the second send still waits the full interval.
    await throttledChannelSend('streamer', send, INTERVAL_MS);

    const second = throttledChannelSend('streamer', send, 300);
    await vi.advanceTimersByTimeAsync(1_499);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await second;
    expect(send).toHaveBeenCalledTimes(2);

    // The second call's 300ms interval now governs the wait before the third send.
    const third = throttledChannelSend('streamer', send, 300);
    await vi.advanceTimersByTimeAsync(299);
    expect(send).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await third;
    expect(send).toHaveBeenCalledTimes(3);
  });
});
