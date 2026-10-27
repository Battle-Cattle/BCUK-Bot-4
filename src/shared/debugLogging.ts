import { promises as fs } from 'fs';
import path from 'path';
import { createLogger, setDebugLogFile, LOG_DIR, DEBUG_LOG_RETENTION_DAYS } from './logger';

const log = createLogger('DebugLogging');

/**
 * Where the switch-off time is kept, so debug logging survives a restart and `deploy.sh debug` can
 * turn it on for the build it starts. Holds `{"until": "<ISO time>"}`; no file means off.
 */
export const DEBUG_LOGGING_STATE_FILE = path.join('logs', 'debug-logging.json');

/** How long debug logging stays on when no duration is given. */
export const DEFAULT_DEBUG_LOGGING_HOURS = 24;

/** The longest it may stay on, so a forgotten switch can't leave verbose logging running for good. */
export const MAX_DEBUG_LOGGING_HOURS = 72;

const MS_PER_HOUR = 60 * 60 * 1000;

/** How often {@link pruneOldDebugLogs} runs while the bot is up. */
const PRUNE_INTERVAL_MS = 6 * MS_PER_HOUR;

/** A debug log file as the rotator names it, current or compressed: `debug-YYYY-MM-DD.log[.N][.gz]`. */
const DEBUG_LOG_FILE = /^debug-\d{4}-\d{2}-\d{2}\.log(\.\d+)?(\.gz)?$/;

let debugUntil: Date | null = null;
let offTimer: ReturnType<typeof setTimeout> | null = null;
let pruneTimer: ReturnType<typeof setInterval> | null = null;

/** Cancels the pending switch-off timer, if any. */
function clearOffTimer(): void {
  if (offTimer) {
    clearTimeout(offTimer);
    offTimer = null;
  }
}

/**
 * Turns the debug log file on until `until` and schedules switching it off then.
 * @param until - When debug logging should end; must be in the future.
 * @param nowMs - The current time in epoch milliseconds.
 */
function applyUntil(until: Date, nowMs: number): void {
  clearOffTimer();
  if (!setDebugLogFile(true)) return;
  debugUntil = until;
  // Unref'd so a pending switch-off never keeps the process alive on its own.
  offTimer = setTimeout(() => {
    void disableDebugLogging().catch((err: unknown) => log.error('Failed to switch debug logging off:', err));
  }, until.getTime() - nowMs).unref();
}

/**
 * Switches the debug log file (`logs/debug-YYYY-MM-DD.log`) on for a set time, then off again on
 * its own. Saved to {@link DEBUG_LOGGING_STATE_FILE}, so a restart in the meantime keeps it on.
 * @param hours - How long to keep it on, from 1 to {@link MAX_DEBUG_LOGGING_HOURS}.
 * @param nowMs - The current time in epoch milliseconds (injectable for tests).
 * @returns When debug logging will switch off.
 * @throws RangeError if `hours` is not a whole number in range.
 */
export async function enableDebugLogging(hours: number, nowMs = Date.now()): Promise<Date> {
  if (!Number.isInteger(hours) || hours < 1 || hours > MAX_DEBUG_LOGGING_HOURS) {
    throw new RangeError(`Debug logging hours must be a whole number from 1 to ${MAX_DEBUG_LOGGING_HOURS}`);
  }
  const until = new Date(nowMs + hours * MS_PER_HOUR);
  await fs.mkdir(path.dirname(DEBUG_LOGGING_STATE_FILE), { recursive: true });
  // A temporary file renamed into place: an interrupted write never leaves a half-written state
  // file, which restoreDebugLogging would discard along with the debug window.
  const tmpFile = `${DEBUG_LOGGING_STATE_FILE}.tmp`;
  await fs.writeFile(tmpFile, JSON.stringify({ until: until.toISOString() }));
  await fs.rename(tmpFile, DEBUG_LOGGING_STATE_FILE);
  applyUntil(until, nowMs);
  log.info(`Debug logging on until ${until.toISOString()} (logs/debug-*.log)`);
  return until;
}

/** Switches the debug log file off now and forgets the saved switch-off time. Safe to call when already off. */
export async function disableDebugLogging(): Promise<void> {
  clearOffTimer();
  setDebugLogFile(false);
  const wasOn = debugUntil !== null;
  debugUntil = null;
  await fs.rm(DEBUG_LOGGING_STATE_FILE, { force: true });
  if (wasOn) log.info('Debug logging off');
}

/**
 * Reads the switch-off time from {@link DEBUG_LOGGING_STATE_FILE} at startup and turns debug
 * logging back on if it hasn't passed yet; an expired, unreadable or out-of-range saved time
 * switches it off and removes the file. Never throws: a broken file mustn't stop the bot starting.
 * @param nowMs - The current time in epoch milliseconds (injectable for tests).
 * @returns When debug logging will switch off, or null if it's off.
 */
export async function restoreDebugLogging(nowMs = Date.now()): Promise<Date | null> {
  try {
    const raw = await fs.readFile(DEBUG_LOGGING_STATE_FILE, 'utf8').catch((err: unknown) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    });
    if (raw === null) return null;
    const until = new Date((JSON.parse(raw) as { until?: unknown }).until as string);
    const remainingMs = until.getTime() - nowMs;
    if (!(remainingMs > 0 && remainingMs <= MAX_DEBUG_LOGGING_HOURS * MS_PER_HOUR)) {
      await disableDebugLogging();
      return null;
    }
    applyUntil(until, nowMs);
    log.info(`Debug logging on until ${until.toISOString()} (logs/debug-*.log)`);
    return until;
  } catch (err) {
    log.error('Failed to read the saved debug logging state; leaving it off:', err);
    await disableDebugLogging().catch(() => { /* already logged above */ });
    return null;
  }
}

/**
 * Reports whether debug logging is on.
 * @returns When debug logging will switch off, or null if it's off.
 */
export function getDebugLoggingUntil(): Date | null {
  return debugUntil;
}

/**
 * Deletes debug log files last written more than {@link DEBUG_LOG_RETENTION_DAYS} days ago. The
 * rotator only prunes when it opens a file, which doesn't happen while debug logging is off, so
 * without this a long-running bot would keep old debug files past their retention.
 * @param nowMs - The current time in epoch milliseconds (injectable for tests).
 * @returns How many files were deleted. A missing log folder, or a file that can't be read or
 *   removed, is skipped rather than thrown.
 */
export async function pruneOldDebugLogs(nowMs = Date.now()): Promise<number> {
  const cutoffMs = nowMs - DEBUG_LOG_RETENTION_DAYS * 24 * MS_PER_HOUR;
  const names = await fs.readdir(LOG_DIR).catch(() => [] as string[]);
  let removed = 0;
  for (const name of names.filter((n) => DEBUG_LOG_FILE.test(n))) {
    const file = path.join(LOG_DIR, name);
    try {
      if ((await fs.stat(file)).mtimeMs >= cutoffMs) continue;
      await fs.rm(file, { force: true });
      removed++;
    } catch (err) {
      log.warn(`Couldn't prune old debug log ${name}:`, err);
    }
  }
  if (removed > 0) log.info(`Pruned ${removed} debug log file(s) older than ${DEBUG_LOG_RETENTION_DAYS} days`);
  return removed;
}

/** Runs {@link pruneOldDebugLogs}, logging rather than throwing on an unexpected failure. */
function pruneSafely(): void {
  void pruneOldDebugLogs().catch((err: unknown) => log.error('Failed to prune old debug logs:', err));
}

/** Prunes old debug log files now and every {@link PRUNE_INTERVAL_MS} after. No-ops if already started. */
export function startDebugLogPruning(): void {
  if (pruneTimer) return;
  pruneSafely();
  // Unref'd so it never keeps the process alive on its own; shutdown() stops it too.
  pruneTimer = setInterval(pruneSafely, PRUNE_INTERVAL_MS).unref();
}

/** Stops the periodic debug log pruning, if running. */
export function stopDebugLogPruning(): void {
  if (pruneTimer) {
    clearInterval(pruneTimer);
    pruneTimer = null;
  }
}
