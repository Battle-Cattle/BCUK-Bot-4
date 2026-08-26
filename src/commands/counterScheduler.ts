import { createLogger } from '../shared/logger';
import { archiveAndResetYearlyCounters } from '../db';

const log = createLogger('CounterScheduler');

// Node.js clamps setTimeout delays longer than 2^31-1 ms (~24.8 days) to 1 ms,
// so a single year-long timeout would fire immediately. Poll hourly instead.
const POLL_INTERVAL_MS = 3_600_000;

let schedulerTimer: ReturnType<typeof setTimeout> | null = null;
let lastArchivedYear: number | null = null;
// Set synchronously in startCounterScheduler(), before tick() does any async work.
// schedulerTimer itself isn't assigned until tick()'s async work completes, so it can't be
// used as the re-entrancy guard: two synchronous back-to-back start calls would both see it
// as null and both kick off a tick() chain. This flag closes that gap.
let started = false;
// Incremented on every start, so a tick() begun by an earlier start (still awaiting
// archiveAndResetYearlyCounters when that run was stopped) can tell it's no longer the
// active run even after a subsequent start flips `started` back to true — a plain
// `started` check alone can't distinguish "still my run" from "a newer run began".
let runGeneration = 0;

/** Polls once for the yearly counter archive and reschedules itself hourly while its run is still active. */
async function tick(myGeneration: number): Promise<void> {
  const now = new Date();
  const prevYear = now.getFullYear() - 1;

  if (now.getMonth() === 0 && now.getDate() === 1 && lastArchivedYear !== prevYear) {
    try {
      const count = await archiveAndResetYearlyCounters(prevYear);
      log.info(`Archived and reset ${count} counter(s) for year ${prevYear}.`);
      lastArchivedYear = prevYear;
    } catch (err) {
      log.error(`Failed to archive counters for year ${prevYear}:`, err);
      // lastArchivedYear is not set on failure, so the next hourly poll will retry.
    }
  }

  // Only reschedule while still the active run — guards both a stop() that raced this
  // tick's async work (schedulerTimer was still null when stop() ran, so it had nothing
  // to clear) and a stop()-then-start() that raced it (started is true again, but from a
  // newer run than the one this tick belongs to).
  if (started && myGeneration === runGeneration) {
    schedulerTimer = setTimeout(
      () => tick(myGeneration).catch((err) => log.error('Unhandled error:', err)),
      POLL_INTERVAL_MS,
    );
  }
}

/**
 * Starts the hourly counter-archive poll. Call once at bot startup.
 * No-ops if already started, so a second call can't leak a duplicate self-perpetuating
 * `setTimeout` chain that `stopCounterScheduler()` wouldn't be able to fully cancel.
 */
export function startCounterScheduler(): void {
  if (started) return;
  started = true;
  runGeneration += 1;
  tick(runGeneration).catch((err) => log.error('Startup error:', err));
  const hoursUntil = Math.round(msUntilNextJan1() / 3_600_000);
  log.info(`Started — polling hourly, next yearly archive in ~${hoursUntil}h.`);
}

/** Stops the hourly counter-archive poll, cancelling any pending timer. */
export function stopCounterScheduler(): void {
  started = false;
  if (schedulerTimer !== null) {
    clearTimeout(schedulerTimer);
    schedulerTimer = null;
  }
}

function msUntilNextJan1(): number {
  const now = new Date();
  const nextJan1 = new Date(now.getFullYear() + 1, 0, 1, 0, 0, 0, 0);
  return nextJan1.getTime() - now.getTime();
}
