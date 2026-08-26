import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mockLogger } from '../test-utils/loggerMock';

/** Mocks the shared logger so the scheduler's log calls don't produce real output during tests. */
vi.mock('../shared/logger', () => ({ createLogger: mockLogger }));

vi.mock('../db', () => ({ archiveAndResetYearlyCounters: vi.fn() }));

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

  const db = await import('../db.js');
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

  it('does not leak a duplicate tick chain when started twice without stopping', async () => {
    vi.setSystemTime(new Date(2025, 0, 1)); // Jan 1, 2025
    startCounterScheduler();
    startCounterScheduler(); // second call should no-op, not kick off a second tick() chain
    await flushAsync();

    // If the second call had leaked a duplicate chain, this would be 2.
    expect(archiveAndResetYearlyCounters).toHaveBeenCalledTimes(1);

    // Advance an hour; only one timer chain should be pending, so only one more poll fires.
    await vi.advanceTimersByTimeAsync(3_600_000);
    await flushAsync();

    // Still Jan 1, lastArchivedYear already set — no additional archive call either way,
    // but a leaked second chain would have logged/scheduled independently. Confirm the
    // scheduler can still be fully stopped with a single stopCounterScheduler() call.
    stopCounterScheduler();
    await vi.advanceTimersByTimeAsync(7_200_000);
    await flushAsync();
    expect(archiveAndResetYearlyCounters).toHaveBeenCalledTimes(1);
  });

  it('stopping while a tick is still awaiting its archive call prevents the chain from resuming', async () => {
    vi.setSystemTime(new Date(2025, 0, 1)); // Jan 1, 2025

    // Keep the in-flight tick's archive call pending so stop() races it before
    // schedulerTimer gets (re)assigned.
    let resolveArchive!: (count: number) => void;
    archiveAndResetYearlyCounters.mockImplementationOnce(
      () => new Promise((resolve) => { resolveArchive = resolve; }),
    );

    startCounterScheduler();
    await Promise.resolve(); // let tick() start and reach the pending archive await

    stopCounterScheduler(); // schedulerTimer is still null here — nothing to clear

    resolveArchive(0);
    await flushAsync(); // let the in-flight tick() finish and (attempt to) reschedule

    // Without the `started` guard, tick() would have re-armed schedulerTimer here anyway.
    await vi.advanceTimersByTimeAsync(3_600_000);
    await flushAsync();

    expect(archiveAndResetYearlyCounters).toHaveBeenCalledTimes(1);
  });

  it('a stop followed by a restart before the old tick resolves does not leak a duplicate chain', async () => {
    vi.setSystemTime(new Date(2025, 0, 1)); // Jan 1, 2025

    // Keep the first run's archive call pending so restart races it.
    let resolveFirstArchive!: (count: number) => void;
    archiveAndResetYearlyCounters.mockImplementationOnce(
      () => new Promise((resolve) => { resolveFirstArchive = resolve; }),
    );

    startCounterScheduler();
    await Promise.resolve(); // let the first tick() start and reach the pending archive await

    stopCounterScheduler(); // schedulerTimer is still null here — nothing to clear
    startCounterScheduler(); // flips `started` back to true for a new run; its own tick
    await flushAsync(); // resolves immediately (default mock) and arms one timer

    resolveFirstArchive(0); // let the stale first-run tick resolve and attempt to reschedule
    await flushAsync();

    // Without the generation guard, the stale first-run tick would arm a second,
    // independent timer here (overwriting `schedulerTimer` and leaking the new run's own
    // timer) — leaving two hourly chains running instead of one.
    expect(vi.getTimerCount()).toBe(1);

    // A single stopCounterScheduler() call should still fully stop everything.
    stopCounterScheduler();
    expect(vi.getTimerCount()).toBe(0);
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
