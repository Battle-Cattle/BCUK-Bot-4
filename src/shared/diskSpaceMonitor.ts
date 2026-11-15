import fs from 'fs';
import path from 'path';
import { DISK_FREE_ALERT_MB, OVERLAY_FOLDER } from './config';
import { recordDiskSpace } from './healthStore';
import { createLogger } from './logger';

// Periodically measures free space on the volume holding OVERLAY_FOLDER and records it in
// `healthStore`, where the owner-alert watcher turns a reading below DISK_FREE_ALERT_MB into a
// `disk` "down" DM (#975). The storage caps limit what the bot itself stores; this catches the
// disk filling up anyway (logs, the database, backups, other files on the same volume).

const log = createLogger('DiskSpace');

/** How often free space is measured. statfs is a single cheap syscall. */
export const DISK_CHECK_INTERVAL_MS = 5 * 60_000;

const BYTES_PER_MB = 1024 * 1024;

let checkTimer: ReturnType<typeof setInterval> | null = null;
let checkInFlight = false;
/** Whether the last check failed, so a failure streak is logged once rather than every interval. */
let lastCheckFailed = false;

/**
 * Measures free space on the volume holding OVERLAY_FOLDER and records it in `healthStore`.
 * Free space is what an unprivileged user (the bot) can still write, `bavail * bsize`, not
 * `bfree`, which includes the blocks reserved for root. A failed `statfs` (a missing folder before
 * the first upload, an unsupported platform) records nothing, so the `disk` component stays
 * unknown or keeps its last real reading rather than paging the owner over a broken check. The
 * first failure of a streak is logged as a warning, not an error: error logs feed the health
 * store's error list, and a missing folder on a fresh install isn't one.
 * @returns Resolves once the check has finished; never rejects.
 */
export async function checkDiskSpace(): Promise<void> {
  const target = path.resolve(OVERLAY_FOLDER);
  try {
    const stats = await fs.promises.statfs(target);
    recordDiskSpace(target, stats.bavail * stats.bsize, DISK_FREE_ALERT_MB * BYTES_PER_MB);
    if (lastCheckFailed) log.info(`Free disk space check of ${target} is working again`);
    lastCheckFailed = false;
  } catch (err) {
    if (!lastCheckFailed) log.warn(`Couldn't check free disk space of ${target}; the disk alert is paused until it works:`, err);
    lastCheckFailed = true;
  }
}

/**
 * Runs {@link checkDiskSpace} unless the previous run is still going, so a hung `statfs` (e.g. a
 * stalled network mount) can't stack up checks.
 * @returns Resolves once the run (or skip) has finished; never rejects.
 */
async function runCheck(): Promise<void> {
  if (checkInFlight) return;
  checkInFlight = true;
  try {
    await checkDiskSpace();
  } finally {
    checkInFlight = false;
  }
}

/**
 * Starts the free disk space check: once now, then every {@link DISK_CHECK_INTERVAL_MS}.
 * No-ops if already started.
 */
export function startDiskSpaceMonitor(): void {
  if (checkTimer) return;
  void runCheck();
  checkTimer = setInterval(() => void runCheck(), DISK_CHECK_INTERVAL_MS);
  // shutdown() stops it explicitly; unref so it never keeps an otherwise-finished process alive.
  checkTimer.unref();
}

/** Stops the free disk space check, if running. */
export function stopDiskSpaceMonitor(): void {
  if (checkTimer) { clearInterval(checkTimer); checkTimer = null; }
}

/** Test-only: resets the module's state so each test starts from a clean slate. */
export function __resetDiskSpaceMonitorForTests(): void {
  stopDiskSpaceMonitor();
  checkInFlight = false;
  lastCheckFailed = false;
}
