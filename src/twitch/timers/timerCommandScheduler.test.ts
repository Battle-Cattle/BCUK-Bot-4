import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

/** Hoisted so the `vi.mock('../../shared/logger', ...)` factory below can safely reference it. */
const { mockLogger } = vi.hoisted(() => ({
  mockLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));
vi.mock('../../db', () => ({ getAllEnabledTimerCommandsWithChannel: vi.fn() }));
vi.mock('../twitchChatActivity', () => ({ getMessageCount: vi.fn() }));
vi.mock('../monitor/twitchMonitor', () => ({ isChannelLive: vi.fn() }));

import { getAllEnabledTimerCommandsWithChannel } from '../../db';
import { getMessageCount } from '../twitchChatActivity';
import { isChannelLive } from '../monitor/twitchMonitor';
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

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2025, 0, 1));
  send = vi.fn().mockResolvedValue(undefined);
  registerTimerCommandsRuntime({ send });
  vi.mocked(isChannelLive).mockReturnValue(true);
  vi.mocked(getMessageCount).mockReturnValue(0);
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
