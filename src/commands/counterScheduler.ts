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

async function tick(): Promise<void> {
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

  // Only reschedule while still started — otherwise a stop() that raced this tick's
  // async work (schedulerTimer was still null when stop() ran, so it had nothing to
  // clear) would have its cancellation silently undone here.
  if (started) {
    schedulerTimer = setTimeout(
      () => tick().catch((err) => log.error('Unhandled error:', err)),
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
  tick().catch((err) => log.error('Startup error:', err));
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
