import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { throttledTwitchSend, __resetTwitchSendQueueForTests } from './twitchSendQueue';

const WINDOW_MS = 30_000;
const PRIVILEGED_LIMIT = 100;
const NON_PRIVILEGED_LIMIT = 20;
const CHANNEL_FLOOR_MS = 1_000;

/** Runs `count` sends of the given privilege to `channel` against a single shared mock. */
async function fillWindow(channel: string, isPrivileged: boolean, count: number): Promise<Mock> {
  const send = vi.fn().mockResolvedValue(undefined);
  for (let i = 0; i < count; i++) {
    await throttledTwitchSend(channel, isPrivileged, send);
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
  it('runs a send immediately when the window has room and the channel floor is clear', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    await throttledTwitchSend('streamer', false, send);
    expect(send).toHaveBeenCalledTimes(1);
  });

  // ─── Shared 30s window ──────────────────────────────────────────────────────

  it('lets a non-privileged send run up to the 20-message limit without delay (spread across channels to dodge the per-channel floor)', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    for (let i = 0; i < NON_PRIVILEGED_LIMIT; i++) {
      await throttledTwitchSend(`streamer-${i}`, false, send);
    }
    expect(send).toHaveBeenCalledTimes(NON_PRIVILEGED_LIMIT);
  });

  it('delays a non-privileged send past the 20-message limit until the window rolls', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    for (let i = 0; i < NON_PRIVILEGED_LIMIT; i++) {
      await throttledTwitchSend(`streamer-${i}`, false, send);
    }

    const next = throttledTwitchSend('streamer-overflow', false, send);
    await vi.advanceTimersByTimeAsync(WINDOW_MS - 1);
    expect(send).toHaveBeenCalledTimes(NON_PRIVILEGED_LIMIT);

    await vi.advanceTimersByTimeAsync(1);
    await next;
    expect(send).toHaveBeenCalledTimes(NON_PRIVILEGED_LIMIT + 1);
  });

  it('lets a privileged send keep going past the 20-message limit, up to the 100-message ceiling', async () => {
    const send = await fillWindow('streamer', true, NON_PRIVILEGED_LIMIT + 5);
    expect(send).toHaveBeenCalledTimes(NON_PRIVILEGED_LIMIT + 5);
  });

  it('delays a privileged send past the 100-message ceiling until the window rolls', async () => {
    const send = await fillWindow('streamer', true, PRIVILEGED_LIMIT);

    const next = throttledTwitchSend('streamer', true, send);
    await vi.advanceTimersByTimeAsync(WINDOW_MS - 1);
    expect(send).toHaveBeenCalledTimes(PRIVILEGED_LIMIT);

    await vi.advanceTimersByTimeAsync(1);
    await next;
    expect(send).toHaveBeenCalledTimes(PRIVILEGED_LIMIT + 1);
  });

  it('blocks a non-privileged send to one channel once a privileged burst on another channel has pushed the shared window past 20 — privileged sends still count toward it', async () => {
    // 21 privileged sends push the shared window's count to 21, past the 20 threshold, even
    // though none of them touched "streamer-b" at all.
    await fillWindow('streamer-a', true, NON_PRIVILEGED_LIMIT + 1);

    const send = vi.fn().mockResolvedValue(undefined);
    const blocked = throttledTwitchSend('streamer-b', false, send);
    await vi.advanceTimersByTimeAsync(WINDOW_MS - 1);
    expect(send).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await blocked;
    expect(send).toHaveBeenCalledTimes(1);
  });

  // ─── Per-channel 1-message-per-second floor (non-privileged only) ───────────

  it('delays a second non-privileged send to the same channel within 1s, even with the shared window nowhere near its limit', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    await throttledTwitchSend('streamer', false, send);

    const next = throttledTwitchSend('streamer', false, send);
    await vi.advanceTimersByTimeAsync(CHANNEL_FLOOR_MS - 1);
    expect(send).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await next;
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('does not apply the per-channel floor to different channels', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    await throttledTwitchSend('streamer-a', false, send);
    await throttledTwitchSend('streamer-b', false, send);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('exempts privileged sends from the per-channel floor', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    await throttledTwitchSend('streamer', true, send);
    await throttledTwitchSend('streamer', true, send);
    expect(send).toHaveBeenCalledTimes(2);
  });

  // ─── Ordering & failure isolation ────────────────────────────────────────────

  it('keeps queued sends in enqueue order across mixed privileged/non-privileged calls to different channels', async () => {
    const order: string[] = [];
    const makeSend = (label: string) => vi.fn().mockImplementation(async () => { order.push(label); });

    const p1 = throttledTwitchSend('streamer-a', true, makeSend('a'));
    const p2 = throttledTwitchSend('streamer-b', false, makeSend('b'));
    const p3 = throttledTwitchSend('streamer-c', true, makeSend('c'));

    await Promise.all([p1, p2, p3]);
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('still consumes a window slot when the send itself fails, so a failure cannot be used to dodge the limit', async () => {
    for (let i = 0; i < NON_PRIVILEGED_LIMIT - 1; i++) {
      await throttledTwitchSend(`streamer-${i}`, false, vi.fn().mockResolvedValue(undefined));
    }
    await expect(
      throttledTwitchSend('streamer-fail', false, vi.fn().mockRejectedValue(new Error('boom'))),
    ).rejects.toThrow('boom');

    const send = vi.fn().mockResolvedValue(undefined);
    const blocked = throttledTwitchSend('streamer-overflow', false, send);
    await vi.advanceTimersByTimeAsync(WINDOW_MS - 1);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await blocked;
    expect(send).toHaveBeenCalledTimes(1);
  });
});
