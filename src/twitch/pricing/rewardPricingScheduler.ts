import { createLogger } from '../../shared/logger';
import { getAllEnabledPricingRows, getPricingSettingsForStreamer, type StreamerPricingSettings } from '../../db';
import { applyDecayTick } from './rewardPricingService';

const log = createLogger('RewardPricingScheduler');

const DECAY_POLL_INTERVAL_MS = 30_000;

let tickTimer: ReturnType<typeof setInterval> | null = null;
let tickRunning = false;
let currentTickPromise: Promise<void> = Promise.resolve();

/**
 * Applies a decay-only pricing sync to every reward with dynamic pricing enabled, across
 * all streamers, pushing an updated Twitch cost for any reward whose price has drifted.
 * Rows are processed concurrently — `applyDecayTick` already serializes work per reward via
 * its own mutation queue, so different rows are independent and don't need to wait on each
 * other, keeping tick duration from growing linearly with the number of enabled rewards.
 * A streamer's pricing settings are fetched once per tick and shared across all of that
 * streamer's rewards (rather than once per reward) — settings aren't part of the
 * per-reward concurrency-sensitive state `applyDecayTick` re-reads fresh, so a tick-old
 * value is harmless. No-ops (re-uses the in-flight promise) if a tick is already running,
 * so a slow tick can't overlap with the next interval firing.
 */
export async function runDecayTick(): Promise<void> {
  if (tickRunning) return currentTickPromise;
  tickRunning = true;
  currentTickPromise = (async () => {
    try {
      const rows = await getAllEnabledPricingRows();
      const distinctStreamerIds = [...new Set(rows.map((row) => row.streamer_id))];
      // Settled (not Promise.all) so one streamer's settings-fetch failure doesn't abort
      // the whole tick — that streamer's rewards simply fall back to fetching their own
      // settings inside applyDecayTick, isolated by the per-row .catch below like before.
      const settingsResults = await Promise.allSettled(
        distinctStreamerIds.map(async (streamerId): Promise<[number, StreamerPricingSettings]> =>
          [streamerId, await getPricingSettingsForStreamer(streamerId)]),
      );
      const settingsByStreamerId = new Map<number, StreamerPricingSettings>();
      for (const result of settingsResults) {
        if (result.status === 'fulfilled') {
          settingsByStreamerId.set(...result.value);
        } else {
          log.error('Failed to pre-fetch pricing settings for a streamer during decay tick:', result.reason);
        }
      }

      await Promise.allSettled(
        rows.map((row) =>
          applyDecayTick(row.streamer_id, row.twitch_reward_id, settingsByStreamerId.get(row.streamer_id)).catch((err) => {
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

/**
 * Starts the periodic decay-tick interval. Call once at bot startup.
 * No-ops if already started, so a second call can't leak the original interval handle.
 */
export function startRewardPricingScheduler(): void {
  if (tickTimer) return;
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
