import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { throttledTwitchSend, __resetTwitchSendQueueForTests } from './twitchSendQueue';

const WINDOW_MS = 30_000;
const MODERATOR_CAPACITY = 100;
const USER_CAPACITY = 20;

/** Runs `count` sends of the given privilege against a single shared mock, resolving once they've all run. */
async function fillBucket(isPrivileged: boolean, count: number): Promise<Mock> {
  const send = vi.fn().mockResolvedValue(undefined);
  for (let i = 0; i < count; i++) {
    await throttledTwitchSend(isPrivileged, send);
  }
  return send;
}

beforeEach(() => {
  vi.useFakeTimers();
  __resetTwitchSendQueueForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('throttledTwitchSend', () => {
  it('runs a send immediately when both buckets have room', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    await throttledTwitchSend(false, send);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('lets a non-privileged send run up to the user bucket capacity without delay', async () => {
    const send = await fillBucket(false, USER_CAPACITY);
    expect(send).toHaveBeenCalledTimes(USER_CAPACITY);
  });

  it('delays a non-privileged send past the user bucket capacity until the window rolls', async () => {
    const send = await fillBucket(false, USER_CAPACITY);

    const next = throttledTwitchSend(false, send);
    await vi.advanceTimersByTimeAsync(WINDOW_MS - 1);
    expect(send).toHaveBeenCalledTimes(USER_CAPACITY);

    await vi.advanceTimersByTimeAsync(1);
    await next;
    expect(send).toHaveBeenCalledTimes(USER_CAPACITY + 1);
  });

  it('lets a privileged send run well past the user bucket capacity, up to the moderator bucket capacity', async () => {
    const send = await fillBucket(true, USER_CAPACITY + 5);
    expect(send).toHaveBeenCalledTimes(USER_CAPACITY + 5);
  });

  it('delays a privileged send past the moderator bucket capacity until the window rolls', async () => {
    const send = await fillBucket(true, MODERATOR_CAPACITY);

    const next = throttledTwitchSend(true, send);
    await vi.advanceTimersByTimeAsync(WINDOW_MS - 1);
    expect(send).toHaveBeenCalledTimes(MODERATOR_CAPACITY);

    await vi.advanceTimersByTimeAsync(1);
    await next;
    expect(send).toHaveBeenCalledTimes(MODERATOR_CAPACITY + 1);
  });

  it('blocks a non-privileged send when a privileged burst has exhausted the shared moderator bucket, even though the user bucket is untouched', async () => {
    // Fill the moderator bucket entirely with privileged sends — none of these touch the user bucket.
    await fillBucket(true, MODERATOR_CAPACITY);

    // User bucket is still completely empty (0/20), but the moderator bucket both kinds of
    // send draw from is full, so this non-privileged send must still wait for it to roll.
    const send = vi.fn().mockResolvedValue(undefined);
    const blocked = throttledTwitchSend(false, send);
    await vi.advanceTimersByTimeAsync(WINDOW_MS - 1);
    expect(send).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await blocked;
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('keeps queued sends in enqueue order across mixed privileged/non-privileged calls', async () => {
    const order: string[] = [];
    const makeSend = (label: string) => vi.fn().mockImplementation(async () => { order.push(label); });

    const p1 = throttledTwitchSend(true, makeSend('a'));
    const p2 = throttledTwitchSend(false, makeSend('b'));
    const p3 = throttledTwitchSend(true, makeSend('c'));

    await Promise.all([p1, p2, p3]);
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('still consumes a bucket token when the send itself fails, so a failure cannot be used to dodge the limit', async () => {
    await fillBucket(false, USER_CAPACITY - 1);
    await expect(throttledTwitchSend(false, vi.fn().mockRejectedValue(new Error('boom')))).rejects.toThrow('boom');

    const send = vi.fn().mockResolvedValue(undefined);
    const blocked = throttledTwitchSend(false, send);
    await vi.advanceTimersByTimeAsync(WINDOW_MS - 1);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await blocked;
    expect(send).toHaveBeenCalledTimes(1);
  });
});
