import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

/** Hoisted so the `vi.mock('../../shared/logger', ...)` factory below can safely reference it. */
const { mockLogger, loggerInstance } = vi.hoisted(() => {
  const loggerInstance = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { mockLogger: () => loggerInstance, loggerInstance };
});

vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));
vi.mock('../../db', () => ({ getAllEnabledTimerCommandsWithChannel: vi.fn() }));
vi.mock('../twitchChatActivity', () => ({ getMessageCount: vi.fn() }));
vi.mock('../monitor/twitchMonitor', () => ({ isChannelLive: vi.fn() }));
vi.mock('../../commands/customCommandHandler', () => ({ resolveSharedChatSessionId: vi.fn() }));

import { getAllEnabledTimerCommandsWithChannel } from '../../db';
import { getMessageCount } from '../twitchChatActivity';
import { isChannelLive } from '../monitor/twitchMonitor';
import { resolveSharedChatSessionId } from '../../commands/customCommandHandler';
import {
  runTimerCommandTick, startTimerCommandScheduler, stopTimerCommandScheduler, registerTimerCommandsRuntime,
} from './timerCommandScheduler';

interface TestRow {
  id: number;
  channel: string;
  message: string;
  interval_seconds: number;
  min_messages: number;
  require_live: boolean;
}

function timerRow(overrides: Partial<TestRow> = {}): TestRow {
  return {
    id: 1,
    channel: 'somestreamer',
    message: 'hello',
    interval_seconds: 600,
    min_messages: 0,
    require_live: true,
    ...overrides,
  };
}

let send: Mock<(channel: string, message: string) => Promise<void>>;
let getLoginUserIds: Mock<() => ReadonlyMap<string, string>>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2025, 0, 1));
  send = vi.fn().mockResolvedValue(undefined);
  getLoginUserIds = vi.fn().mockReturnValue(new Map());
  registerTimerCommandsRuntime({ send, getLoginUserIds });
  vi.mocked(isChannelLive).mockReturnValue(true);
  vi.mocked(getMessageCount).mockReturnValue(0);
  vi.mocked(resolveSharedChatSessionId).mockResolvedValue(null);
});

afterEach(async () => {
  await stopTimerCommandScheduler();
  vi.useRealTimers();
});

describe('runTimerCommandTick', () => {
  it('seeds state on first sight without firing', async () => {
    vi.mocked(getAllEnabledTimerCommandsWithChannel).mockResolvedValue([timerRow()] as any);
    await runTimerCommandTick();
    expect(send).not.toHaveBeenCalled();
  });

  it('fires once the interval has elapsed and the channel is live', async () => {
    vi.mocked(getAllEnabledTimerCommandsWithChannel).mockResolvedValue([timerRow({ interval_seconds: 600 })] as any);
    await runTimerCommandTick(); // seed
    await vi.advanceTimersByTimeAsync(600_000);
    await runTimerCommandTick();
    expect(send).toHaveBeenCalledWith('somestreamer', 'hello');
  });

  it('does not fire before the interval elapses', async () => {
    vi.mocked(getAllEnabledTimerCommandsWithChannel).mockResolvedValue([timerRow({ interval_seconds: 600 })] as any);
    await runTimerCommandTick(); // seed
    await vi.advanceTimersByTimeAsync(300_000);
    await runTimerCommandTick();
    expect(send).not.toHaveBeenCalled();
  });

  it('does not fire while offline when require_live is set', async () => {
    vi.mocked(isChannelLive).mockReturnValue(false);
    vi.mocked(getAllEnabledTimerCommandsWithChannel).mockResolvedValue(
      [timerRow({ interval_seconds: 600, require_live: true })] as any,
    );
    await runTimerCommandTick(); // seed
    await vi.advanceTimersByTimeAsync(600_000);
    await runTimerCommandTick();
    expect(send).not.toHaveBeenCalled();
  });

  it('does not fire below the min_messages threshold', async () => {
    vi.mocked(getAllEnabledTimerCommandsWithChannel).mockResolvedValue(
      [timerRow({ interval_seconds: 600, min_messages: 5 })] as any,
    );
    await runTimerCommandTick(); // seeds messagesAtLastFire at the current count (0)
    await vi.advanceTimersByTimeAsync(600_000);
    vi.mocked(getMessageCount).mockReturnValue(3); // below the 5-message threshold
    await runTimerCommandTick();
    expect(send).not.toHaveBeenCalled();
  });

  it('fires once the min_messages threshold is met', async () => {
    vi.mocked(getAllEnabledTimerCommandsWithChannel).mockResolvedValue(
      [timerRow({ interval_seconds: 600, min_messages: 5 })] as any,
    );
    await runTimerCommandTick(); // seeds messagesAtLastFire at the current count (0)
    await vi.advanceTimersByTimeAsync(600_000);
    vi.mocked(getMessageCount).mockReturnValue(5);
    await runTimerCommandTick();
    expect(send).toHaveBeenCalledWith('somestreamer', 'hello');
  });

  it('prunes in-memory state once a timer disappears from the enabled-rows query', async () => {
    vi.mocked(getAllEnabledTimerCommandsWithChannel).mockResolvedValueOnce([timerRow()] as any);
    await runTimerCommandTick(); // seeded

    vi.mocked(getAllEnabledTimerCommandsWithChannel).mockResolvedValueOnce([]);
    await runTimerCommandTick(); // pruned — the timer's old state is gone

    vi.mocked(getAllEnabledTimerCommandsWithChannel).mockResolvedValueOnce([timerRow()] as any);
    await vi.advanceTimersByTimeAsync(600_000);
    await runTimerCommandTick(); // re-seen: seeds fresh state again instead of firing on stale state
    expect(send).not.toHaveBeenCalled();
  });

  it('fires independently per channel when the same timer is assigned to multiple streamers', async () => {
    // A timer can now be assigned to several streamers' channels — each appears as its own row
    // sharing the same timer id, and each must fire on its own live/interval schedule rather
    // than sharing one countdown.
    vi.mocked(getAllEnabledTimerCommandsWithChannel).mockResolvedValue([
      timerRow({ id: 1, channel: 'streamer-a', interval_seconds: 600 }),
      timerRow({ id: 1, channel: 'streamer-b', interval_seconds: 600 }),
    ] as any);
    await runTimerCommandTick(); // seed both channels independently

    vi.mocked(isChannelLive).mockImplementation((channel: string) => channel === 'streamer-a');
    await vi.advanceTimersByTimeAsync(600_000);
    await runTimerCommandTick();

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('streamer-a', 'hello');
  });

  it("keeps firing state independent for the same timer id on different channels (a shared, id-only-keyed state would let one channel's fire reset the other's clock)", async () => {
    vi.mocked(getAllEnabledTimerCommandsWithChannel).mockResolvedValue([
      timerRow({ id: 2, channel: 'streamer-a', interval_seconds: 600 }),
      timerRow({ id: 2, channel: 'streamer-b', interval_seconds: 300 }),
    ] as any);
    await runTimerCommandTick(); // seed both channels (both live by default per beforeEach)

    await vi.advanceTimersByTimeAsync(300_000);
    await runTimerCommandTick(); // only streamer-b's shorter interval has elapsed
    expect(send).toHaveBeenCalledWith('streamer-b', 'hello');
    expect(send).not.toHaveBeenCalledWith('streamer-a', 'hello');

    send.mockClear();
    await vi.advanceTimersByTimeAsync(300_000);
    await runTimerCommandTick(); // streamer-a's own 600s interval has now elapsed since its seed
    expect(send).toHaveBeenCalledWith('streamer-a', 'hello');
  });

  it("one channel's send failure does not block another's", async () => {
    vi.mocked(getAllEnabledTimerCommandsWithChannel).mockResolvedValue([
      timerRow({ id: 1, channel: 'streamer-a' }),
      timerRow({ id: 2, channel: 'streamer-b' }),
    ] as any);
    await runTimerCommandTick(); // seed both
    await vi.advanceTimersByTimeAsync(600_000);

    send.mockImplementation(async (channel: string) => {
      if (channel === 'streamer-a') throw new Error('boom');
    });

    await expect(runTimerCommandTick()).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledWith('streamer-a', 'hello');
    expect(send).toHaveBeenCalledWith('streamer-b', 'hello');
  });

  it('does not throw when loading rows fails', async () => {
    vi.mocked(getAllEnabledTimerCommandsWithChannel).mockRejectedValue(new Error('db down'));
    await expect(runTimerCommandTick()).resolves.toBeUndefined();
  });

  it('a reentrancy guard prevents overlapping ticks', async () => {
    let resolveFirst!: () => void;
    const gate = new Promise<void>((resolve) => { resolveFirst = resolve; });
    vi.mocked(getAllEnabledTimerCommandsWithChannel).mockImplementation(async () => {
      await gate;
      return [];
    });

    const first = runTimerCommandTick();
    const second = runTimerCommandTick(); // should not trigger a second fetch

    resolveFirst();
    await Promise.all([first, second]);

    expect(getAllEnabledTimerCommandsWithChannel).toHaveBeenCalledTimes(1);
  });
});

describe('block-reason logging', () => {
  it('logs once when a row becomes stuck waiting on chat activity after its interval elapses, and does not repeat the log on later ticks in the same state', async () => {
    vi.mocked(getAllEnabledTimerCommandsWithChannel).mockResolvedValue(
      [timerRow({ interval_seconds: 600, min_messages: 5 })] as any,
    );
    await runTimerCommandTick(); // seeds messagesAtLastFire at the current count (0)
    await vi.advanceTimersByTimeAsync(600_000);
    vi.mocked(getMessageCount).mockReturnValue(3); // below the 5-message threshold

    await runTimerCommandTick();
    expect(loggerInstance.info).toHaveBeenCalledWith(
      expect.stringContaining('interval elapsed, waiting on chat activity (3/5 messages since last fire)'),
    );

    loggerInstance.info.mockClear();
    await vi.advanceTimersByTimeAsync(15_000);
    await runTimerCommandTick(); // still stuck on the same reason — must not log again
    expect(loggerInstance.info).not.toHaveBeenCalled();
  });

  it('logs once when a row goes offline, and again once it comes back and gets blocked on messages', async () => {
    vi.mocked(isChannelLive).mockReturnValue(false);
    vi.mocked(getAllEnabledTimerCommandsWithChannel).mockResolvedValue(
      [timerRow({ interval_seconds: 600, min_messages: 5, require_live: true })] as any,
    );
    await runTimerCommandTick(); // seed
    await vi.advanceTimersByTimeAsync(600_000);

    await runTimerCommandTick();
    expect(loggerInstance.info).toHaveBeenCalledWith(expect.stringContaining('waiting — channel not live'));

    loggerInstance.info.mockClear();
    vi.mocked(isChannelLive).mockReturnValue(true);
    vi.mocked(getMessageCount).mockReturnValue(3);
    await runTimerCommandTick();
    expect(loggerInstance.info).toHaveBeenCalledWith(
      expect.stringContaining('interval elapsed, waiting on chat activity (3/5 messages since last fire)'),
    );
  });

  it('does not log anything for the routine interval wait', async () => {
    vi.mocked(getAllEnabledTimerCommandsWithChannel).mockResolvedValue([timerRow({ interval_seconds: 600 })] as any);
    await runTimerCommandTick(); // seed
    loggerInstance.info.mockClear();
    await vi.advanceTimersByTimeAsync(300_000);

    await runTimerCommandTick(); // interval not yet elapsed
    expect(loggerInstance.info).not.toHaveBeenCalled();
  });

  it('logs a successful post', async () => {
    vi.mocked(getAllEnabledTimerCommandsWithChannel).mockResolvedValue([timerRow({ interval_seconds: 600 })] as any);
    await runTimerCommandTick(); // seed
    await vi.advanceTimersByTimeAsync(600_000);

    await runTimerCommandTick();
    expect(loggerInstance.info).toHaveBeenCalledWith(expect.stringContaining('Posted timer 1 to somestreamer'));
  });
});

describe('Shared Chat group cooldown', () => {
  /** Routes `resolveSharedChatSessionId` to a fixed session id per Twitch user id. */
  function stubSessions(sessionIdByUserId: Record<string, string>): void {
    vi.mocked(resolveSharedChatSessionId).mockImplementation(async (userId: string) => sessionIdByUserId[userId] ?? null);
  }

  it('suppresses a second ready timer sharing the same session, then fires it once the group cooldown elapses', async () => {
    getLoginUserIds.mockReturnValue(new Map([['streamer-a', 'uid-a'], ['streamer-b', 'uid-b']]));
    stubSessions({ 'uid-a': 'session-1', 'uid-b': 'session-1' });
    vi.mocked(getAllEnabledTimerCommandsWithChannel).mockResolvedValue([
      timerRow({ id: 1, channel: 'streamer-a', message: 'msg-a', interval_seconds: 60 }),
      timerRow({ id: 2, channel: 'streamer-b', message: 'msg-b', interval_seconds: 60 }),
    ] as any);

    await runTimerCommandTick(); // seed both
    await vi.advanceTimersByTimeAsync(60_000);
    await runTimerCommandTick(); // both ready, same session off cooldown -> only the oldest (streamer-a) fires
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('streamer-a', 'msg-a');

    send.mockClear();
    await vi.advanceTimersByTimeAsync(60_000); // both ready again, but group cooldown (120s) not yet elapsed
    await runTimerCommandTick();
    expect(send).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000); // group cooldown now elapsed (120s since streamer-a fired)
    await runTimerCommandTick();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('streamer-b', 'msg-b');
  });

  it('rotates fairly among three timers sharing a session instead of favoring the same one', async () => {
    getLoginUserIds.mockReturnValue(new Map([
      ['streamer-a', 'uid-a'], ['streamer-b', 'uid-b'], ['streamer-c', 'uid-c'],
    ]));
    stubSessions({ 'uid-a': 'session-1', 'uid-b': 'session-1', 'uid-c': 'session-1' });
    vi.mocked(getAllEnabledTimerCommandsWithChannel).mockResolvedValue([
      timerRow({ id: 1, channel: 'streamer-a', message: 'msg-a', interval_seconds: 60 }),
      timerRow({ id: 2, channel: 'streamer-b', message: 'msg-b', interval_seconds: 60 }),
      timerRow({ id: 3, channel: 'streamer-c', message: 'msg-c', interval_seconds: 60 }),
    ] as any);

    await runTimerCommandTick(); // seed all three

    const fired: string[] = [];
    for (let window = 0; window < 3; window++) {
      await vi.advanceTimersByTimeAsync(120_000); // clears both each timer's own interval and the group cooldown
      await runTimerCommandTick();
      expect(send).toHaveBeenCalledTimes(1);
      fired.push(send.mock.calls[0][1]);
      send.mockClear();
    }

    // Each of the three distinct messages gets a turn — none is skipped in favor of another.
    expect(new Set(fired)).toEqual(new Set(['msg-a', 'msg-b', 'msg-c']));
  });

  it('fires independently when timers resolve to different sessions', async () => {
    getLoginUserIds.mockReturnValue(new Map([['streamer-a', 'uid-a'], ['streamer-b', 'uid-b']]));
    stubSessions({ 'uid-a': 'session-1', 'uid-b': 'session-2' });
    vi.mocked(getAllEnabledTimerCommandsWithChannel).mockResolvedValue([
      timerRow({ id: 1, channel: 'streamer-a', message: 'msg-a', interval_seconds: 60 }),
      timerRow({ id: 2, channel: 'streamer-b', message: 'msg-b', interval_seconds: 60 }),
    ] as any);

    await runTimerCommandTick(); // seed both
    await vi.advanceTimersByTimeAsync(60_000);
    await runTimerCommandTick();

    expect(send).toHaveBeenCalledWith('streamer-a', 'msg-a');
    expect(send).toHaveBeenCalledWith('streamer-b', 'msg-b');
  });

  it('releases the group cooldown reservation when the picked row fails to send', async () => {
    getLoginUserIds.mockReturnValue(new Map([['streamer-a', 'uid-a'], ['streamer-b', 'uid-b']]));
    stubSessions({ 'uid-a': 'session-1', 'uid-b': 'session-1' });
    vi.mocked(getAllEnabledTimerCommandsWithChannel).mockResolvedValue([
      timerRow({ id: 1, channel: 'streamer-a', message: 'msg-a', interval_seconds: 60 }),
      timerRow({ id: 2, channel: 'streamer-b', message: 'msg-b', interval_seconds: 60 }),
    ] as any);

    await runTimerCommandTick(); // seed both
    await vi.advanceTimersByTimeAsync(60_000);

    send.mockRejectedValueOnce(new Error('helix down')); // fails for whichever row is picked (streamer-a, being oldest)
    await runTimerCommandTick();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('streamer-a', 'msg-a');

    // The failed send released the reservation, so the session can be retried on the very next
    // tick instead of being blocked for the full 120s group cooldown.
    send.mockClear();
    await runTimerCommandTick();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('streamer-a', 'msg-a');
  });

  it('fires normally when the session lookup fails (treated as not in Shared Chat)', async () => {
    getLoginUserIds.mockReturnValue(new Map([['streamer-a', 'uid-a']]));
    vi.mocked(resolveSharedChatSessionId).mockRejectedValue(new Error('helix down'));
    vi.mocked(getAllEnabledTimerCommandsWithChannel).mockResolvedValue([
      timerRow({ id: 1, channel: 'streamer-a', message: 'msg-a', interval_seconds: 60 }),
    ] as any);

    await runTimerCommandTick(); // seed
    await vi.advanceTimersByTimeAsync(60_000);
    await runTimerCommandTick();

    expect(send).toHaveBeenCalledWith('streamer-a', 'msg-a');
  });
});

describe('startTimerCommandScheduler / stopTimerCommandScheduler', () => {
  it('fires runTimerCommandTick on the configured interval', async () => {
    vi.mocked(getAllEnabledTimerCommandsWithChannel).mockResolvedValue([]);
    startTimerCommandScheduler();

    expect(getAllEnabledTimerCommandsWithChannel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(getAllEnabledTimerCommandsWithChannel).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(getAllEnabledTimerCommandsWithChannel).toHaveBeenCalledTimes(2);
  });

  it('does not leak the interval when started twice without stopping', async () => {
    vi.mocked(getAllEnabledTimerCommandsWithChannel).mockResolvedValue([]);
    startTimerCommandScheduler();
    startTimerCommandScheduler(); // second call should no-op, not replace the tracked handle

    await vi.advanceTimersByTimeAsync(15_000);
    expect(getAllEnabledTimerCommandsWithChannel).toHaveBeenCalledTimes(1);

    await stopTimerCommandScheduler();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(getAllEnabledTimerCommandsWithChannel).toHaveBeenCalledTimes(1);
  });

  it('stop prevents further ticks', async () => {
    vi.mocked(getAllEnabledTimerCommandsWithChannel).mockResolvedValue([]);
    startTimerCommandScheduler();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(getAllEnabledTimerCommandsWithChannel).toHaveBeenCalledTimes(1);

    await stopTimerCommandScheduler();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(getAllEnabledTimerCommandsWithChannel).toHaveBeenCalledTimes(1);
  });
});
