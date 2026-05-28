import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.mock('./logger', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

vi.mock('./db', () => ({ archiveAndResetYearlyCounters: vi.fn() }));

let startCounterScheduler: () => void;
let stopCounterScheduler: () => void;
let archiveAndResetYearlyCounters: ReturnType<typeof vi.fn>;

async function flushAsync(): Promise<void> {
  // Multiple rounds of microtask flushing to let async tick() complete
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();

  const mod = await import('./counterScheduler.js');
  startCounterScheduler = mod.startCounterScheduler;
  stopCounterScheduler = mod.stopCounterScheduler;

  const db = await import('./db.js');
  archiveAndResetYearlyCounters = vi.mocked(db.archiveAndResetYearlyCounters);
  archiveAndResetYearlyCounters.mockResolvedValue(0);
});

afterEach(() => {
  stopCounterScheduler();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('counterScheduler', () => {
  it('triggers archive on Jan 1st with previous year', async () => {
    vi.setSystemTime(new Date(2025, 0, 1)); // Jan 1, 2025
    startCounterScheduler();
    await flushAsync();

    expect(archiveAndResetYearlyCounters).toHaveBeenCalledTimes(1);
    expect(archiveAndResetYearlyCounters).toHaveBeenCalledWith(2024);
  });

  it('does not trigger archive on a non-Jan-1 date', async () => {
    vi.setSystemTime(new Date(2025, 1, 15)); // Feb 15, 2025
    startCounterScheduler();
    await flushAsync();

    expect(archiveAndResetYearlyCounters).not.toHaveBeenCalled();
  });

  it('is idempotent — archive fires only once even after hourly re-polls on Jan 1', async () => {
    vi.setSystemTime(new Date(2025, 0, 1)); // Jan 1, 2025
    startCounterScheduler();
    await flushAsync();

    // First tick ran and archived; now advance 1 hour so the second tick fires
    await vi.advanceTimersByTimeAsync(3_600_000);
    await flushAsync();

    // Still on Jan 1 (only 1 hour later), lastArchivedYear is set — no second call
    expect(archiveAndResetYearlyCounters).toHaveBeenCalledTimes(1);
  });

  it('retries archive on the next poll when the first call throws', async () => {
    vi.setSystemTime(new Date(2025, 0, 1)); // Jan 1, 2025
    archiveAndResetYearlyCounters
      .mockRejectedValueOnce(new Error('DB down'))
      .mockResolvedValueOnce(3);

    startCounterScheduler();
    await flushAsync();

    // First tick: archive throws; should not propagate, lastArchivedYear stays null
    expect(archiveAndResetYearlyCounters).toHaveBeenCalledTimes(1);

    // Advance 1 hour; still Jan 1, and lastArchivedYear is still null — retry fires
    await vi.advanceTimersByTimeAsync(3_600_000);
    await flushAsync();

    expect(archiveAndResetYearlyCounters).toHaveBeenCalledTimes(2);
    expect(archiveAndResetYearlyCounters).toHaveBeenNthCalledWith(2, 2024);
  });

  it('stopCounterScheduler prevents further ticks', async () => {
    vi.setSystemTime(new Date(2025, 5, 15)); // June 15 — no archive expected
    startCounterScheduler();
    await flushAsync();

    stopCounterScheduler();

    // Advance well past 2 hourly intervals — no timer should fire
    await vi.advanceTimersByTimeAsync(7_200_000);
    await flushAsync();

    expect(archiveAndResetYearlyCounters).not.toHaveBeenCalled();
  });
});
