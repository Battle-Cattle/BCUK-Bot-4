// channel.channel_points_custom_reward_redemption.add handling: in-memory dedup, the durable
// `redemption_handled` ledger, the required effects (dashboard record, dynamic pricing, overlay
// lookup), then the best-effort overlay and companion pushes. Split from `twitchEventSubHandler.ts`,
// which keeps the simpler follow/sub/resub/giftsub/raid/stream handlers.
import type { EventSubConfig, StreamerEventType, RedemptionProgress } from '../../db';
import {
  getVideosForReward, getStreamerById, recordStreamerEvent, getRedemptionProgress, markRedemptionEffect,
} from '../../db';
import { pickWeightedRandom } from '../../audio/soundSelector';
import { createLogger } from '../../shared/logger';
import { applyRedemptionPricing } from '../pricing/rewardPricingService';
import { isDuplicateRedemption, markRedemptionHandled, clearPendingRedemption } from './twitchEventSubRedemptionDedup';
import {
  overlayRuntimeRegistry,
  companionRuntimeRegistry,
  dashboardEventRuntimeRegistry,
} from './twitchEventSubRuntime';

const log = createLogger('EventSubHandler');

export interface RedemptionEvent {
  id: string;
  user_login: string;
  user_name: string;
  broadcaster_user_login: string;
  reward: { id: string; title: string };
  user_input: string;
}

/**
 * Same as `recordAndPushDashboardEvent` (`twitchEventSubEffects.ts`), but lets a failure propagate to the caller instead
 * of logging and swallowing it. Used only by {@link handleRedemption}, where a failed dashboard
 * record must cause the whole redemption to be retried (via its dedup pending/handled lifecycle)
 * rather than being silently lost — unlike the other five EventSub handlers, which treat the
 * dashboard feed as best-effort and must never let its failure crash or reject them.
 *
 * Passes `redemptionId` (Twitch's own redemption id) through to `recordStreamerEvent` as an
 * idempotency key: if a retry re-runs this after an earlier attempt already recorded the event
 * but failed on a later required effect, the duplicate `INSERT` collides on
 * `streamer_event_log`'s unique index and is silently skipped instead of creating a second row
 * — see `recordStreamerEvent`'s doc comment. The live dashboard SSE push is skipped on that same
 * retry path too, since `recordStreamerEvent` reports back whether it actually inserted a row —
 * otherwise a retry would re-deliver a second live event for a redemption already shown once.
 *
 * @param streamerId - DB row ID of the streamer, used to scope the log entry and dashboard SSE channel.
 * @param eventType - Kind of activity that occurred.
 * @param displayName - The acting Twitch viewer's display name.
 * @param detail - Short additional context, or null if there's none.
 * @param redemptionId - Twitch's own redemption id, used as the idempotency key.
 * @returns A promise that resolves once the event is recorded, and pushed to the dashboard if
 *   this call actually inserted a new row.
 */
async function recordAndPushDashboardEventOrThrow(
  streamerId: number,
  eventType: StreamerEventType,
  displayName: string,
  detail: string | null,
  redemptionId: string,
): Promise<void> {
  const eventId = await recordStreamerEvent(streamerId, eventType, displayName, detail, redemptionId);
  // Only push the live SSE update when a new row was actually inserted — if this redemption was
  // already recorded on an earlier attempt (see recordStreamerEvent's doc comment), a retry must
  // not re-deliver a second live dashboard event for the same physical redemption. `insertId` is
  // never 0 (auto-increment starts at 1), so `!eventId` only catches the genuine null-skip case.
  if (!eventId) return;
  dashboardEventRuntimeRegistry.get()?.pushDashboardEvent(streamerId, {
    eventType, displayName, detail, occurredAt: new Date().toISOString(),
  });
}

/**
 * Handle a channel.channel_points_custom_reward_redemption.add EventSub notification.
 * Records the redemption to the dashboard's "Recent Events" feed (via
 * {@link recordAndPushDashboardEventOrThrow}) and applies dynamic pricing for the redeemed reward
 * (a no-op if the reward doesn't have dynamic pricing enabled) — both are required: their
 * failures propagate so the redemption is retried rather than silently marked complete. It then
 * looks up videos configured for the redeemed reward and triggers an overlay event if found (the
 * overlay push still no-ops when no videos are configured for the reward or no overlay runtime
 * is registered) — this is also part of the required chain, since `getVideosForReward` can throw.
 * Only once all three of those have succeeded does it forward the redemption to the streamer's
 * companion app (if any device is connected) — this isolates its own errors internally
 * (try/catch) and is intentionally best-effort, so a companion-push failure can't reject this
 * function. It runs last (not first, and not before the overlay lookup) precisely because it's
 * best-effort and can't be un-sent: if it ran earlier and a later required step then failed, a
 * retry would re-deliver the same companion notification.
 *
 * Deduplicates on Twitch's own redemption id ({@link isDuplicateRedemption}) before doing
 * anything else — a duplicate (or an id already being processed by another in-flight call) is
 * dropped silently, since every effect below (companion push, dashboard record, pricing, overlay
 * trigger) would otherwise double-fire for one physical redemption. That in-memory cache only
 * remembers a redemption for `REDEMPTION_DEDUP_TTL_MS`, so the durable `redemption_handled`
 * ledger ({@link getRedemptionProgress}) is checked next: a redemption it records as fully handled
 * is dropped too, and one recorded as partly done resumes, skipping the dashboard record and
 * pricing increment if they already ran (see {@link applyRecordedRedemptionEffects}). This is
 * what lets reconciliation safely replay redemptions up to `MAX_CURSOR_LAG_MS` (1 hour) old. The
 * id is only marked as handled — in the ledger and via {@link markRedemptionHandled} — once the
 * dashboard record, pricing update, and overlay lookup have all completed without throwing (the
 * companion push is exempt, since it's intentionally best-effort). A failure clears the in-flight
 * claim ({@link clearPendingRedemption}) instead, so a retry of the same redemption id (e.g.
 * reconciliation's next poll tick) is not misclassified as a duplicate. The overlay video and
 * companion push aren't tracked in the ledger, so the `handled` write happens just before them: a
 * failed write means neither has been sent, and they're never replayed by a retry (at most lost
 * if the process dies between the write and the pushes).
 *
 * @param login - Broadcaster login name.
 * @param event - Redemption event payload including reward ID and user details.
 * @param _config - Streamer event config (unused for redemptions; reserved for future use).
 * @param streamerId - DB row ID of the streamer, used to scope video lookups and resolve the owning Discord ID.
 * @returns True if the redemption was actually processed; false if it was dropped as a duplicate
 *   — callers (e.g. reconciliation) use this to tell a genuine catch from a redemption that was
 *   already delivered live.
 */
export async function handleRedemption(
  login: string,
  event: RedemptionEvent,
  _config: EventSubConfig,
  streamerId: number,
): Promise<boolean> {
  if (isDuplicateRedemption(event.id)) {
    log.warn(`Duplicate redemption notification for "${event.reward.title}" (id=${event.id}) — ignoring`);
    return false;
  }

  // Only mark the redemption as handled (in the durable ledger and via markRedemptionHandled) once
  // every effect below has run without throwing. If anything throws, clearPendingRedemption
  // releases the in-flight claim and the error is rethrown, so a retry (e.g. reconciliation's next
  // poll tick) resumes this redemption — skipping the effects the ledger says already ran —
  // instead of being silently dropped as a duplicate.
  try {
    const progress = await getRedemptionProgress(event.id);
    if (progress?.handled) {
      // Completed before, beyond what the in-memory cache still remembers (e.g. a reconciliation
      // replay older than REDEMPTION_DEDUP_TTL_MS). Re-remember it so later duplicates stay cheap.
      markRedemptionHandled(event.id);
      log.warn(`Redemption "${event.reward.title}" (id=${event.id}) already handled (durable record) — ignoring`);
      return false;
    }
    await applyRecordedRedemptionEffects(event, streamerId, progress);

    const videos = await getVideosForReward(event.reward.id, streamerId);

    // Mark handled once every required effect (dashboard, pricing, overlay lookup) has succeeded,
    // but before the two live pushes below: those aren't tracked in the ledger and can't be
    // un-sent, so if this write failed after them, the retry would send them again. Written here,
    // a failure means nothing live has gone out yet and the retry sends each once; the only loss
    // case is the process dying between this write and the pushes, which suits best-effort pushes.
    await markRedemptionEffect(event.id, streamerId, 'handled');

    if (videos.length > 0) {
      const filename = pickWeightedRandom(videos);
      const videoPath = `/overlay/videos/${streamerId}/${filename}`;
      overlayRuntimeRegistry.get()?.pushOverlayEvent(login, videoPath);
      log.info(`Overlay triggered for ${login}: reward="${event.reward.title}" video=${filename}`);
    }

    // Deliberately runs last, after every required effect above (dashboard record, pricing,
    // overlay lookup) has already succeeded: the companion push is best-effort and can't be
    // un-sent, so if it ran earlier and a later required step then failed, a retry would
    // deliver the same companion notification twice for one redemption.
    try {
      const streamer = await getStreamerById(streamerId);
      if (streamer) {
        companionRuntimeRegistry.get()?.pushCompanionEvent(streamer.discord_id, {
          type: 'channel_points_redemption',
          rewardId: event.reward.id,
          rewardTitle: event.reward.title,
          userLogin: event.user_login,
          userName: event.user_name,
          userInput: event.user_input,
          redeemedAt: new Date().toISOString(),
        });
      }
    } catch (err) {
      log.error('Failed to push companion event for redemption:', err);
    }

    markRedemptionHandled(event.id);
    return true;
  } catch (err) {
    clearPendingRedemption(event.id);
    throw err;
  }
}

/**
 * Runs a redemption's required effects that must not repeat — the dashboard record and the
 * dynamic-pricing increment — skipping any that the durable ledger (`progress`) says already ran,
 * and recording each in the ledger as soon as it succeeds. Both are awaited (unlike the other
 * EventSub handlers' fire-and-forget pricing calls): a failure must propagate so the redemption is
 * retried rather than silently marked complete. The dashboard record keeps its own
 * `redemption_id` unique-index guard as a second line of defence.
 * @param event - The redemption being handled.
 * @param streamerId - DB row id of the streamer.
 * @param progress - The redemption's recorded progress, or null if none is recorded yet.
 * @returns Resolves once both effects have run (or were already recorded).
 */
async function applyRecordedRedemptionEffects(event: RedemptionEvent, streamerId: number, progress: RedemptionProgress | null): Promise<void> {
  if (!progress?.dashboardRecorded) {
    const detail = event.user_input ? `${event.reward.title}: ${event.user_input}` : event.reward.title;
    await recordAndPushDashboardEventOrThrow(streamerId, 'redemption', event.user_name, detail, event.id);
    await markRedemptionEffect(event.id, streamerId, 'dashboard_recorded');
  }
  if (!progress?.pricingApplied) {
    await applyRedemptionPricing(streamerId, event.reward.id, event.id);
    await markRedemptionEffect(event.id, streamerId, 'pricing_applied');
  }
}
