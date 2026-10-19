import { monitorEventLoopDelay, type ELDHistogram } from 'perf_hooks';
import { createLogger } from './logger';

const log = createLogger('EventLoop');

/** How often the event-loop delay histogram is read and reset. */
const CHECK_INTERVAL_MS = 60_000;

/**
 * A minute whose longest event-loop stall exceeds this is logged as a warning. Audio frames go
 * out every 20ms from the event loop, and HTTP requests (Stream Deck SFX presses) wait on it too,
 * so a stall this long is audible/noticeable.
 */
const STALL_WARN_MS = 200;

const NS_PER_MS = 1e6;
const BYTES_PER_MB = 1024 * 1024;

let histogram: ELDHistogram | null = null;
let checkTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Reads and resets the histogram, logging the past interval's event-loop delay alongside memory
 * use and uptime: a warning when the longest stall exceeds {@link STALL_WARN_MS}, debug otherwise.
 * Memory and uptime are included so a stall that grows with process age (GC pressure from a
 * leak) is visible in the same line.
 * @param h - The histogram to read.
 */
function reportEventLoopDelay(h: ELDHistogram): void {
  const maxMs = h.max / NS_PER_MS;
  const { heapUsed, rss } = process.memoryUsage();
  const message = `Event loop delay over the last ${CHECK_INTERVAL_MS / 1000}s: `
    + `mean ${(h.mean / NS_PER_MS).toFixed(1)}ms, p99 ${(h.percentile(99) / NS_PER_MS).toFixed(1)}ms, `
    + `max ${maxMs.toFixed(1)}ms (heap ${Math.round(heapUsed / BYTES_PER_MB)}MB, `
    + `rss ${Math.round(rss / BYTES_PER_MB)}MB, uptime ${Math.round(process.uptime() / 60)}min)`;
  h.reset();
  if (maxMs > STALL_WARN_MS) log.warn(message);
  else log.debug(message);
}

/**
 * Starts sampling event-loop delay and logs a summary every {@link CHECK_INTERVAL_MS}, so a
 * process that slows down over a long session (e.g. delayed SFX after hours live) shows when and
 * how badly the event loop is stalling. No-ops if already started.
 */
export function startEventLoopMonitor(): void {
  if (histogram) return;
  const h = monitorEventLoopDelay({ resolution: 20 });
  h.enable();
  histogram = h;
  checkTimer = setInterval(() => reportEventLoopDelay(h), CHECK_INTERVAL_MS);
  // shutdown() stops it explicitly; unref so it never keeps an otherwise-finished process alive.
  checkTimer.unref();
}

/** Stops sampling event-loop delay, if running. */
export function stopEventLoopMonitor(): void {
  if (checkTimer) { clearInterval(checkTimer); checkTimer = null; }
  if (histogram) { histogram.disable(); histogram = null; }
}
