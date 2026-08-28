import { createLogger } from '../../shared/logger';
import { getAllEnabledPricingRows, getPricingSettingsForStreamers, type StreamerPricingSettings } from '../../db';
import { applyDecayTick } from './rewardPricingService';
import { recordSchedulerRun, normalizeError } from '../../shared/healthStore';

const log = createLogger('RewardPricingScheduler');

const DECAY_POLL_INTERVAL_MS = 30_000;
const DB_SHUTDOWN_RETRY_INTERVAL_MS = 60_000;

let tickTimer: ReturnType<typeof setInterval> | null = null;
let dbShutdownRetryTimer: ReturnType<typeof setTimeout> | null = null;
let awaitingDbRecovery = false;
let tickRunning = false;
let currentTickPromise: Promise<void> = Promise.resolve();

/** True if `error` is MySQL's `ER_SERVER_SHUTDOWN` (errno 1053) — the DB server itself is restarting/shutting down. */
function isServerShutdownError(error: unknown): boolean {
  const err = error as { code?: string; errno?: number };
  return err?.code === 'ER_SERVER_SHUTDOWN' || err?.errno === 1053;
}

/**
 * Starts (or no-ops if already running) the interval that fires `runDecayTick` on a fixed
 * cadence. Shared by `startRewardPricingScheduler` and DB-shutdown recovery so both paths
 * track the same `tickTimer` handle.
 */
function startTickTimer(): void {
  if (tickTimer) return;
  /** Interval callback: fires a decay tick and logs (rather than throws) if the returned promise ever rejects. */
  tickTimer = setInterval(() => {
    runDecayTick().catch((err) => log.error('Decay tick error:', err));
  }, DECAY_POLL_INTERVAL_MS);
}

/**
 * Pauses the regular polling interval and schedules a single probe tick after
 * `DB_SHUTDOWN_RETRY_INTERVAL_MS` — called when a tick discovers the DB server itself is
 * shutting down, so the scheduler stops hammering it every 30s and instead waits for it to
 * come back. No-ops if a probe is already pending. `runDecayTick` resumes normal polling
 * (via `resumeAfterDbRecovery`) once it manages to fetch rows again, whether that happens
 * on the scheduled probe or an externally-triggered call.
 */
function pauseForDbShutdown(): void {
  awaitingDbRecovery = true;
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  if (dbShutdownRetryTimer) return;
  /** Probe callback: retries the tick once; `runDecayTick` reschedules another probe itself if it's still failing while `awaitingDbRecovery` is true. */
  dbShutdownRetryTimer = setTimeout(() => {
    dbShutdownRetryTimer = null;
    runDecayTick().catch((err) => log.error('Decay tick error while probing DB availability:', err));
  }, DB_SHUTDOWN_RETRY_INTERVAL_MS);
}

/** Resumes normal interval polling after a successful row fetch that follows a DB-shutdown pause. No-ops if not currently paused. */
function resumeAfterDbRecovery(): void {
  if (!awaitingDbRecovery) return;
  awaitingDbRecovery = false;
  log.info('Database reachable again — resuming decay tick polling.');
  startTickTimer();
}

/**
 * Applies a decay-only pricing sync to every reward with dynamic pricing enabled, across
 * all streamers, pushing an updated Twitch cost for any reward whose price has drifted.
 * Rows are processed concurrently — `applyDecayTick` already serializes work per reward via
 * its own mutation queue, so different rows are independent and don't need to wait on each
 * other, keeping tick duration from growing linearly with the number of enabled rewards.
 * A streamer's pricing settings are fetched once per tick, in one batched query across every
 * distinct streamer with enabled pricing rows (`getPricingSettingsForStreamers`), and shared
 * across all of that streamer's rewards (rather than once per reward or one query per
 * streamer) — settings aren't part of the per-reward concurrency-sensitive state
 * `applyDecayTick` re-reads fresh, so a tick-old value is harmless. No-ops (re-uses the
 * in-flight promise) if a tick is already running, so a slow tick can't overlap with the next
 * interval firing.
 */
export async function runDecayTick(): Promise<void> {
  if (tickRunning) return currentTickPromise;
  tickRunning = true;
  currentTickPromise = (async () => {
    try {
      const rows = await getAllEnabledPricingRows();
      resumeAfterDbRecovery();
      const distinctStreamerIds = [...new Set(rows.map((row) => row.streamer_id))];
      // A streamer absent from the result (no settings row, or the whole batch fetch failed)
      // is simply missing from the map — applyDecayTick falls back to fetching its own
      // per-reward default when `settingsByStreamerId.get(...)` is undefined, same as before.
      let settingsByStreamerId: Map<number, StreamerPricingSettings>;
      try {
        settingsByStreamerId = await getPricingSettingsForStreamers(distinctStreamerIds);
      } catch (err) {
        log.error('Failed to pre-fetch pricing settings during decay tick:', err);
        settingsByStreamerId = new Map();
      }

      await Promise.allSettled(
        rows.map((row) =>
          applyDecayTick(row.streamer_id, row.twitch_reward_id, settingsByStreamerId.get(row.streamer_id)).catch((err) => {
            log.error(`Decay tick failed for reward ${row.twitch_reward_id} (streamer ${row.streamer_id}):`, err);
          }),
        ),
      );
      recordSchedulerRun('rewardPricing', true);
    } catch (err) {
      if (isServerShutdownError(err)) {
        log.warn('Database is shutting down — pausing decay tick polling until it recovers.');
        recordSchedulerRun('rewardPricing', false, normalizeError(err));
        pauseForDbShutdown();
      } else {
        log.error('Failed to load enabled pricing rows:', err);
        recordSchedulerRun('rewardPricing', false, normalizeError(err));
        // A recovery probe can fail with something other than the shutdown error it was
        // triggered by (e.g. a transient network blip) — without this, that probe's own
        // cleanup would already have cleared dbShutdownRetryTimer, leaving the scheduler
        // paused forever since nothing else would ever schedule another probe.
        if (awaitingDbRecovery) {
          pauseForDbShutdown();
        }
      }
    } finally {
      tickRunning = false;
    }
  })();
  return currentTickPromise;
}

/**
 * Starts the periodic decay-tick interval. Call once at bot startup.
 * No-ops if already started, so a second call can't leak the original interval handle.
 */
export function startRewardPricingScheduler(): void {
  startTickTimer();
  log.info(`Started — decay tick every ${DECAY_POLL_INTERVAL_MS / 1000}s`);
}

/**
 * Stops the periodic decay-tick interval (and any pending DB-shutdown recovery probe) and
 * awaits any in-flight tick before returning.
 */
export async function stopRewardPricingScheduler(): Promise<void> {
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  await currentTickPromise;
  if (dbShutdownRetryTimer) { clearTimeout(dbShutdownRetryTimer); dbShutdownRetryTimer = null; }
  awaitingDbRecovery = false;
}
