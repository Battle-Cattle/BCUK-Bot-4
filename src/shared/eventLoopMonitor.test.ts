import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('./logger', () => ({ createLogger: () => log }));

// A fake histogram whose readings (in nanoseconds) each test sets.
const histogram = vi.hoisted(() => ({
  enable: vi.fn(),
  disable: vi.fn(),
  reset: vi.fn(),
  percentile: vi.fn(() => 0),
  mean: 0,
  max: 0,
}));
const monitorEventLoopDelay = vi.hoisted(() => vi.fn(() => histogram));
vi.mock('perf_hooks', () => ({ monitorEventLoopDelay }));

import { startEventLoopMonitor, stopEventLoopMonitor } from './eventLoopMonitor';

const MS = 1e6;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  histogram.mean = 2 * MS;
  histogram.max = 15 * MS;
  histogram.percentile.mockReturnValue(10 * MS);
});

afterEach(() => {
  stopEventLoopMonitor();
  vi.useRealTimers();
});

describe('eventLoopMonitor', () => {
  it('logs the past minute at debug level and resets the histogram when there was no long stall', () => {
    startEventLoopMonitor();
    expect(histogram.enable).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(60_000);

    expect(log.debug).toHaveBeenCalledWith(expect.stringContaining('mean 2.0ms, p99 10.0ms, max 15.0ms'));
    expect(log.warn).not.toHaveBeenCalled();
    expect(histogram.reset).toHaveBeenCalledOnce();
  });

  it('logs a warning with memory use and uptime when the longest stall exceeded 200ms', () => {
    histogram.max = 850 * MS;
    startEventLoopMonitor();

    vi.advanceTimersByTime(60_000);

    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/max 850\.0ms \(heap \d+MB, rss \d+MB, uptime \d+min\)/));
  });

  it('does not start a second monitor when already running', () => {
    startEventLoopMonitor();
    startEventLoopMonitor();

    vi.advanceTimersByTime(60_000);

    expect(monitorEventLoopDelay).toHaveBeenCalledOnce();
    expect(log.debug).toHaveBeenCalledOnce();
  });

  it('stops reporting and disables the histogram once stopped', () => {
    startEventLoopMonitor();
    stopEventLoopMonitor();

    vi.advanceTimersByTime(120_000);

    expect(histogram.disable).toHaveBeenCalledOnce();
    expect(log.debug).not.toHaveBeenCalled();
  });
});
