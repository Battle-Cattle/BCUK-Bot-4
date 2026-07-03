import { createLogger } from '../../shared/logger';
import { getAllEnabledPricingRows } from '../../db';
import { applyDecayTick } from './rewardPricingService';

const log = createLogger('RewardPricingScheduler');

const DECAY_POLL_INTERVAL_MS = 5 * 60_000;

let tickTimer: ReturnType<typeof setInterval> | null = null;
let tickRunning = false;
let currentTickPromise: Promise<void> = Promise.resolve();

/**
 * Applies a decay-only pricing sync to every reward with dynamic pricing enabled, across
 * all streamers, pushing an updated Twitch cost for any reward whose price has drifted.
 * Rows are processed concurrently — `applyDecayTick` already serializes work per reward via
 * its own mutation queue, so different rows are independent and don't need to wait on each
 * other, keeping tick duration from growing linearly with the number of enabled rewards.
 * No-ops (re-uses the in-flight promise) if a tick is already running, so a slow tick
 * can't overlap with the next interval firing.
 */
export async function runDecayTick(): Promise<void> {
  if (tickRunning) return currentTickPromise;
  tickRunning = true;
  currentTickPromise = (async () => {
    try {
      const rows = await getAllEnabledPricingRows();
      await Promise.allSettled(
        rows.map((row) =>
          applyDecayTick(row.streamer_id, row.twitch_reward_id).catch((err) => {
            log.error(`Decay tick failed for reward ${row.twitch_reward_id} (streamer ${row.streamer_id}):`, err);
          }),
        ),
      );
    } catch (err) {
      log.error('Failed to load enabled pricing rows:', err);
    } finally {
      tickRunning = false;
    }
  })();
  return currentTickPromise;
}

/** Starts the periodic decay-tick interval. Call once at bot startup. */
export function startRewardPricingScheduler(): void {
  tickTimer = setInterval(() => {
    runDecayTick().catch((err) => log.error('Decay tick error:', err));
  }, DECAY_POLL_INTERVAL_MS);
  log.info(`Started — decay tick every ${DECAY_POLL_INTERVAL_MS / 1000}s`);
}

/** Stops the periodic decay-tick interval and awaits any in-flight tick before returning. */
export async function stopRewardPricingScheduler(): Promise<void> {
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  await currentTickPromise;
}
