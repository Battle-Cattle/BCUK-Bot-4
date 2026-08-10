import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockLogger, loggerInstance } = vi.hoisted(() => {
  const loggerInstance = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { mockLogger: () => loggerInstance, loggerInstance };
});

vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));
vi.mock('../twitchChatActivity', () => ({ getMessageCount: vi.fn() }));
vi.mock('../monitor/twitchMonitor', () => ({ isChannelLive: vi.fn() }));

import { getMessageCount } from '../twitchChatActivity';
import { isChannelLive } from '../monitor/twitchMonitor';
import type { TimerCommandForScheduler } from '../../db';
import {
  evaluateFireBlock, logBlockReasonChange, forgetBlockReason, pruneBlockReasonLog, clearBlockReasonLog,
  type TimerRuntimeState,
} from './timerCommandFireGate';

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
  clearBlockReasonLog();
  vi.mocked(isChannelLive).mockReturnValue(true);
  vi.mocked(getMessageCount).mockReturnValue(0);
});

describe('evaluateFireBlock', () => {
  it('blocks on offline when require_live is set and the channel is not live', () => {
    vi.mocked(isChannelLive).mockReturnValue(false);
    expect(evaluateFireBlock(row({ require_live: true }), state(), 700_000)).toBe('offline');
  });

  it('does not check liveness when require_live is false', () => {
    vi.mocked(isChannelLive).mockReturnValue(false);
    expect(evaluateFireBlock(row({ require_live: false, interval_seconds: 0 }), state(), 0)).toBeNull();
  });

  it('blocks on interval when the interval has not elapsed', () => {
    expect(evaluateFireBlock(row({ interval_seconds: 600 }), state({ lastFiredAt: 0 }), 599_000)).toBe('interval');
  });

  it('clears the interval block exactly at the boundary', () => {
    expect(evaluateFireBlock(row({ interval_seconds: 600, min_messages: 0 }), state({ lastFiredAt: 0 }), 600_000)).toBeNull();
  });

  it('blocks on messages when min_messages is not yet met', () => {
    vi.mocked(getMessageCount).mockReturnValue(2);
    const result = evaluateFireBlock(
      row({ interval_seconds: 600, min_messages: 5 }), state({ lastFiredAt: 0, messagesAtLastFire: 0 }), 600_000,
    );
    expect(result).toBe('messages');
  });

  it('skips the messages check entirely when min_messages is 0', () => {
    vi.mocked(getMessageCount).mockReturnValue(0);
    const result = evaluateFireBlock(
      row({ interval_seconds: 600, min_messages: 0 }), state({ lastFiredAt: 0, messagesAtLastFire: 0 }), 600_000,
    );
    expect(result).toBeNull();
  });

  it('returns null when every condition is clear', () => {
    vi.mocked(isChannelLive).mockReturnValue(true);
    vi.mocked(getMessageCount).mockReturnValue(10);
    const result = evaluateFireBlock(
      row({ require_live: true, interval_seconds: 600, min_messages: 5 }),
      state({ lastFiredAt: 0, messagesAtLastFire: 0 }),
      600_000,
    );
    expect(result).toBeNull();
  });
});

describe('logBlockReasonChange', () => {
  it('logs the first time a non-interval reason is seen', () => {
    logBlockReasonChange('1::somestreamer', row(), 'offline', state());
    expect(loggerInstance.info).toHaveBeenCalledTimes(1);
    expect(loggerInstance.info).toHaveBeenCalledWith(expect.stringContaining('waiting — channel not live'));
  });

  it('does not re-log the same reason on a repeat tick', () => {
    logBlockReasonChange('1::somestreamer', row(), 'offline', state());
    logBlockReasonChange('1::somestreamer', row(), 'offline', state());
    expect(loggerInstance.info).toHaveBeenCalledTimes(1);
  });

  it('never logs the routine interval-wait reason', () => {
    logBlockReasonChange('1::somestreamer', row(), 'interval', state());
    expect(loggerInstance.info).not.toHaveBeenCalled();
  });

  it('does not log when the reason is null (clear to fire)', () => {
    logBlockReasonChange('1::somestreamer', row(), null, state());
    expect(loggerInstance.info).not.toHaveBeenCalled();
  });

  it('logs again when the reason changes from offline to messages', () => {
    logBlockReasonChange('1::somestreamer', row(), 'offline', state());
    vi.mocked(getMessageCount).mockReturnValue(1);
    logBlockReasonChange('1::somestreamer', row({ min_messages: 5 }), 'messages', state({ messagesAtLastFire: 0 }));
    expect(loggerInstance.info).toHaveBeenCalledTimes(2);
    expect(loggerInstance.info).toHaveBeenLastCalledWith(expect.stringContaining('waiting on chat activity (1/5 messages'));
  });
});

describe('forgetBlockReason / pruneBlockReasonLog / clearBlockReasonLog', () => {
  it('forgetBlockReason makes a later repeat of the same reason log again', () => {
    logBlockReasonChange('1::somestreamer', row(), 'offline', state());
    forgetBlockReason('1::somestreamer');
    logBlockReasonChange('1::somestreamer', row(), 'offline', state());
    expect(loggerInstance.info).toHaveBeenCalledTimes(2);
  });

  it('pruneBlockReasonLog drops keys no longer present, keeping current ones', () => {
    logBlockReasonChange('1::somestreamer', row(), 'offline', state());
    logBlockReasonChange('2::otherstreamer', row({ id: 2, channel: 'otherstreamer' }), 'offline', state());

    pruneBlockReasonLog(new Set(['1::somestreamer']));

    // Pruned key logs again (state was forgotten); surviving key stays deduped.
    logBlockReasonChange('2::otherstreamer', row({ id: 2, channel: 'otherstreamer' }), 'offline', state());
    logBlockReasonChange('1::somestreamer', row(), 'offline', state());
    expect(loggerInstance.info).toHaveBeenCalledTimes(3);
  });

  it('clearBlockReasonLog resets all tracked state', () => {
    logBlockReasonChange('1::somestreamer', row(), 'offline', state());
    clearBlockReasonLog();
    logBlockReasonChange('1::somestreamer', row(), 'offline', state());
    expect(loggerInstance.info).toHaveBeenCalledTimes(2);
  });
});
