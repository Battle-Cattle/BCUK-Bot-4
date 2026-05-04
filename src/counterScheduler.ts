import { archiveAndResetYearlyCounters } from './db';

let schedulerTimer: ReturnType<typeof setTimeout> | null = null;

function msUntilNextJan1(): number {
  const now = new Date();
  const nextJan1 = new Date(now.getFullYear() + 1, 0, 1, 0, 0, 0, 0);
  return nextJan1.getTime() - now.getTime();
}

async function runYearlyArchive(): Promise<void> {
  // Archive the year that just ended (scheduler fires on Jan 1 of the new year)
  const year = new Date().getFullYear() - 1;
  try {
    const count = await archiveAndResetYearlyCounters(year);
    console.log(`[CounterScheduler] Archived and reset ${count} counter(s) for year ${year}.`);
  } catch (err) {
    console.error(`[CounterScheduler] Failed to archive counters for year ${year}:`, err);
  }
  scheduleNextArchive();
}

function scheduleNextArchive(): void {
  const delay = msUntilNextJan1();
  schedulerTimer = setTimeout(() => {
    runYearlyArchive().catch((err) => console.error('[CounterScheduler] Unhandled error:', err));
  }, delay);
}

export function startCounterScheduler(): void {
  scheduleNextArchive();
  const hoursUntil = Math.round(msUntilNextJan1() / 3_600_000);
  console.log(`[CounterScheduler] Started — next yearly archive in ~${hoursUntil}h.`);
}

export function stopCounterScheduler(): void {
  if (schedulerTimer !== null) {
    clearTimeout(schedulerTimer);
    schedulerTimer = null;
  }
}
