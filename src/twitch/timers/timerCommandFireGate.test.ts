import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../twitchChatActivity', () => ({ getMessageCount: vi.fn() }));
vi.mock('../monitor/twitchMonitor', () => ({ isChannelLive: vi.fn() }));

import { getMessageCount } from '../twitchChatActivity';
import { isChannelLive } from '../monitor/twitchMonitor';
import type { TimerCommandForScheduler } from '../../db';
import { shouldFire, type TimerRuntimeState } from './timerCommandFireGate';

function row(overrides: Partial<TimerCommandForScheduler> = {}): TimerCommandForScheduler {
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

function state(overrides: Partial<TimerRuntimeState> = {}): TimerRuntimeState {
  return { lastFiredAt: 0, messagesAtLastFire: 0, ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isChannelLive).mockReturnValue(true);
  vi.mocked(getMessageCount).mockReturnValue(0);
});

describe('shouldFire', () => {
  it('blocks on offline when require_live is set and the channel is not live', () => {
    vi.mocked(isChannelLive).mockReturnValue(false);
    expect(shouldFire(row({ require_live: true }), state(), 700_000)).toBe(false);
  });

  it('does not check liveness when require_live is false', () => {
    vi.mocked(isChannelLive).mockReturnValue(false);
    expect(shouldFire(row({ require_live: false, interval_seconds: 0 }), state(), 0)).toBe(true);
  });

  it('blocks on interval when the interval has not elapsed', () => {
    expect(shouldFire(row({ interval_seconds: 600 }), state({ lastFiredAt: 0 }), 599_000)).toBe(false);
  });

  it('clears the interval block exactly at the boundary', () => {
    expect(shouldFire(row({ interval_seconds: 600, min_messages: 0 }), state({ lastFiredAt: 0 }), 600_000)).toBe(true);
  });

  it('blocks on messages when min_messages is not yet met', () => {
    vi.mocked(getMessageCount).mockReturnValue(2);
    const result = shouldFire(
      row({ interval_seconds: 600, min_messages: 5 }), state({ lastFiredAt: 0, messagesAtLastFire: 0 }), 600_000,
    );
    expect(result).toBe(false);
  });

  it('skips the messages check entirely when min_messages is 0', () => {
    vi.mocked(getMessageCount).mockReturnValue(0);
    const result = shouldFire(
      row({ interval_seconds: 600, min_messages: 0 }), state({ lastFiredAt: 0, messagesAtLastFire: 0 }), 600_000,
    );
    expect(result).toBe(true);
  });

  it('returns true when every condition is clear', () => {
    vi.mocked(isChannelLive).mockReturnValue(true);
    vi.mocked(getMessageCount).mockReturnValue(10);
    const result = shouldFire(
      row({ require_live: true, interval_seconds: 600, min_messages: 5 }),
      state({ lastFiredAt: 0, messagesAtLastFire: 0 }),
      600_000,
    );
    expect(result).toBe(true);
  });
});
