import { createLogger } from './logger';
import { archiveAndResetYearlyCounters } from './db';

const log = createLogger('CounterScheduler');

// Node.js clamps setTimeout delays longer than 2^31-1 ms (~24.8 days) to 1 ms,
// so a single year-long timeout would fire immediately. Poll hourly instead.
const POLL_INTERVAL_MS = 3_600_000;

let schedulerTimer: ReturnType<typeof setTimeout> | null = null;
let lastArchivedYear: number | null = null;

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

  schedulerTimer = setTimeout(
    () => tick().catch((err) => log.error('Unhandled error:', err)),
    POLL_INTERVAL_MS,
  );
}

export function startCounterScheduler(): void {
  tick().catch((err) => log.error('Startup error:', err));
  const hoursUntil = Math.round(msUntilNextJan1() / 3_600_000);
  log.info(`Started — polling hourly, next yearly archive in ~${hoursUntil}h.`);
}

export function stopCounterScheduler(): void {
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
