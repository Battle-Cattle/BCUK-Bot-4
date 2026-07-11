import { describe, it, expect, vi, beforeEach } from 'vitest';

const { logMock } = vi.hoisted(() => ({
  logMock: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
vi.mock('../../shared/logger', () => ({ createLogger: () => logMock }));
vi.mock('../../twitch/monitor/twitchMonitor', () => ({ restartTwitchMonitor: vi.fn() }));

import { triggerRestart } from './streamRestart';
import { restartTwitchMonitor } from '../../twitch/monitor/twitchMonitor';

beforeEach(() => {
  vi.clearAllMocks();
});

/** Waits for the fire-and-forget promise chain inside triggerRestart to settle. */
async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('triggerRestart', () => {
  it('calls restartTwitchMonitor', async () => {
    vi.mocked(restartTwitchMonitor).mockResolvedValue(undefined);
    triggerRestart();
    await flush();
    expect(restartTwitchMonitor).toHaveBeenCalled();
  });

  it('logs an error when the monitor restart itself rejects, without throwing', async () => {
    vi.mocked(restartTwitchMonitor).mockRejectedValueOnce(new Error('monitor boom'));
    expect(() => triggerRestart()).not.toThrow();
    await flush();
    expect(logMock.error).toHaveBeenCalledWith('TwitchMonitor restart error:', expect.any(Error));
  });

  it('serializes concurrent calls so a later restart waits for an earlier one to settle', async () => {
    const order: string[] = [];
    let resolveFirst!: () => void;
    vi.mocked(restartTwitchMonitor)
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveFirst = () => { order.push('first'); resolve(undefined); };
      }))
      .mockImplementationOnce(async () => { order.push('second'); });

    triggerRestart();
    triggerRestart();
    await flush();
    expect(order).toEqual([]); // first restart hasn't resolved yet, second must wait

    resolveFirst();
    await flush();
    await flush();
    expect(order).toEqual(['first', 'second']);
  });
});
