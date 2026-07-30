import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { throttledChannelSend, __resetTwitchSendQueueForTests } from './twitchSendQueue';

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
    await throttledChannelSend('streamer', send);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('delays a second send to the same channel until the spacing interval elapses', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    await throttledChannelSend('streamer', send);

    const second = throttledChannelSend('streamer', send);
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
    await throttledChannelSend('streamer-a', send);
    await throttledChannelSend('streamer-b', send);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('keeps queued sends for a channel in enqueue order', async () => {
    const order: string[] = [];
    const makeSend = (label: string) => vi.fn().mockImplementation(async () => { order.push(label); });

    const p1 = throttledChannelSend('streamer', makeSend('a'));
    const p2 = throttledChannelSend('streamer', makeSend('b'));
    const p3 = throttledChannelSend('streamer', makeSend('c'));

    await vi.advanceTimersByTimeAsync(3_000);
    await Promise.all([p1, p2, p3]);

    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('does not shrink the spacing of queued sends when an earlier send fails', async () => {
    const failing = vi.fn().mockRejectedValue(new Error('boom'));
    const succeeding = vi.fn().mockResolvedValue(undefined);

    const first = throttledChannelSend('streamer', failing);
    const second = throttledChannelSend('streamer', succeeding);

    await expect(first).rejects.toThrow('boom');

    await vi.advanceTimersByTimeAsync(1_499);
    expect(succeeding).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await second;
    expect(succeeding).toHaveBeenCalledTimes(1);
  });
});
