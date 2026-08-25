import type { EventSubConfig, AlertEventType, StreamerEventType } from '../../db';
import { getVideosForReward, getStreamerById, findCachedAlertConfig, recordStreamerEvent } from '../../db';
import { pickWeightedRandom } from '../../commands/soundSelector';
import { buildShoutoutMessage } from '../../commands/shoutoutHandler';
import { createLogger } from '../../shared/logger';
import { triggerImmediateLiveCheck } from '../monitor/twitchMonitor';
import { fillTemplate } from '../../shared/textTemplate';
import { applyRedemptionPricing } from '../pricing/rewardPricingService';
import { isDuplicateRedemption, markRedemptionHandled, clearPendingRedemption } from './twitchEventSubRedemptionDedup';
import {
  overlayRuntimeRegistry,
  companionRuntimeRegistry,
  alertRuntimeRegistry,
  dashboardEventRuntimeRegistry,
  twitchRuntimeRegistry,
} from './twitchEventSubRuntime';

const log = createLogger('EventSubHandler');

export interface FollowEvent {
  user_login: string;
  user_name: string;
  broadcaster_user_login: string;
}

export interface SubEvent {
  user_login: string;
  user_name: string;
  broadcaster_user_login: string;
  tier: string;
  is_gift: boolean;
}

export interface ResubEvent {
  user_login: string;
  user_name: string;
  broadcaster_user_login: string;
  tier: string;
  cumulative_months: number;
  streak_months: number | null;
}

export interface GiftSubEvent {
  user_login: string;
  user_name: string;
  broadcaster_user_login: string;
  total: number;
  tier: string;
  is_anonymous: boolean;
}

export interface RaidEvent {
  from_broadcaster_user_login: string;
  from_broadcaster_user_name: string;
  to_broadcaster_user_login: string;
  viewers: number;
}

export interface RedemptionEvent {
  id: string;
  user_login: string;
  user_name: string;
  broadcaster_user_login: string;
  reward: { id: string; title: string };
  user_input: string;
}

function tierName(tier: string): string {
  return ({ '1000': 'Tier 1', '2000': 'Tier 2', '3000': 'Tier 3' } as Record<string, string>)[tier] ?? tier;
}

/**
 * Sends a chat message via the injected Twitch runtime, logging and swallowing any failure
 * (e.g. the bot lacking channel access, or a transient Twitch API error) instead of letting it
 * propagate — a chat-send failure must never prevent the independent {@link maybePushAlert} call
 * that follows it in each handler below.
 *
 * @param login - Broadcaster login name (chat channel to send to).
 * @param message - Chat message to send.
 * @returns True if a runtime was registered and the send succeeded; false if no runtime is
 *   registered or the send failed, so callers can avoid recording an unsent message as sent.
 */
async function sendChatMessage(login: string, message: string): Promise<boolean> {
  const runtime = twitchRuntimeRegistry.get();
  if (!runtime) return false;
  try {
    await runtime.send(login, message);
    return true;
  } catch (err) {
    log.error(`Failed to send chat message to ${login}:`, err);
    return false;
  }
}

/**
 * If `enabled`, fills `template` with `vars` and sends the result as a chat message. Shared by
 * each handler below's chat-message gate, which differ only in which `EventSubConfig` flag and
 * message template they read.
 * @param login - Broadcaster login name (chat channel to send to).
 * @param enabled - The relevant config flag (e.g. `config.follow_enabled`).
 * @param template - The relevant message template (e.g. `config.follow_message`).
 * @param vars - Template variables to fill.
 * @returns Resolves once the (possibly skipped) send completes.
 */
async function maybeSendChatMessage(login: string, enabled: boolean, template: string, vars: Record<string, string>): Promise<void> {
  if (!enabled) return;
  const msg = fillTemplate(template, vars);
  await sendChatMessage(login, msg);
}

/**
 * Looks up a streamer's alerts-overlay config for one event type and, if enabled, pushes a
 * filled {@link AlertPayload} via the injected alert runtime. Independent of the chat-message
 * `*_enabled` flags on `EventSubConfig` — a streamer may enable the browser-source alert for an
 * event type without enabling its chat message, or vice versa. No-ops silently if no config row
 * exists, the alert is disabled, or no alert runtime has been registered. A failed config lookup
 * or push is logged and swallowed rather than rejecting, so a transient DB/alert problem can't
 * surface as a failure of the EventSub handler that called this (which has already, independently,
 * sent its own chat message if enabled). The config lookup goes through `findCachedAlertConfig`
 * (a TTL cache invalidated on every alert-config/asset save), not a live query, since this runs
 * on every single follow/sub/resub/giftsub/raid notification.
 *
 * Fills the template with `fillTemplate`'s `'keep'` fallback (an unrecognised `{placeholder}` is
 * left in place rather than blanked) — the same fallback the "Send Test Alert" preview route
 * uses (`alertsAdminMutations.ts`), so a streamer's test preview matches what actually ships live
 * for a typo'd placeholder instead of the preview showing the typo while the live alert silently
 * blanks it.
 *
 * @param login - Broadcaster login name (alerts-overlay channel to push to).
 * @param streamerId - DB row ID of the streamer, used to look up alert config and build asset URLs.
 * @param eventType - Which alert config row to look up.
 * @param vars - Template variables to fill the alert's message template with.
 */
async function maybePushAlert(
  login: string,
  streamerId: number,
  eventType: AlertEventType,
  vars: Record<string, string>,
): Promise<void> {
  const runtime = alertRuntimeRegistry.get();
  if (!runtime) return;
  try {
    const alert = await findCachedAlertConfig(streamerId, eventType);
    if (!alert || !alert.enabled) return;
    runtime.pushAlertEvent(login, {
      type: eventType,
      message: fillTemplate(alert.message_template, vars, 'keep'),
      imageUrl: alert.image_filename ? `/alerts/assets/${streamerId}/${alert.image_filename}` : null,
      soundUrl: alert.sound_filename ? `/alerts/assets/${streamerId}/${alert.sound_filename}` : null,
      durationMs: alert.duration_ms,
      textAnimation: alert.text_animation,
    });
  } catch (err) {
    log.error(`Failed to push ${eventType} alert for ${login}:`, err);
  }
}

/**
 * Records a streamer activity event to `streamer_event_log` and pushes it live to the
 * dashboard's "Recent Events" feed via the injected dashboard runtime. Unlike
 * {@link maybePushAlert}, this is unconditional — it doesn't gate on any per-streamer
 * enabled flag, since the dashboard feed always reflects what actually happened. A failed
 * DB write or push is logged and swallowed rather than rejecting, so it can't surface as a
 * failure of the EventSub handler that called it.
 *
 * @param streamerId - DB row ID of the streamer, used to scope the log entry and dashboard SSE channel.
 * @param eventType - Kind of activity that occurred.
 * @param displayName - The acting Twitch viewer's display name (follower, raider, redeemer, etc.).
 * @param detail - Short additional context (e.g. raid viewer count, redeemed reward name and any
 *   text the viewer entered), or null if there's none.
 */
async function recordAndPushDashboardEvent(
  streamerId: number,
  eventType: StreamerEventType,
  displayName: string,
  detail: string | null,
): Promise<void> {
  try {
    await recordStreamerEvent(streamerId, eventType, displayName, detail);
    dashboardEventRuntimeRegistry.get()?.pushDashboardEvent(streamerId, {
      eventType, displayName, detail, occurredAt: new Date().toISOString(),
    });
  } catch (err) {
    log.error(`Failed to record ${eventType} dashboard event for streamer ${streamerId}:`, err);
  }
}

/**
 * Same as {@link recordAndPushDashboardEvent}, but lets a failure propagate to the caller instead
 * of logging and swallowing it. Used only by {@link handleRedemption}, where a failed dashboard
 * record must cause the whole redemption to be retried (via its dedup pending/handled lifecycle)
 * rather than being silently lost — unlike the other five EventSub handlers, which treat the
 * dashboard feed as best-effort and must never let its failure crash or reject them.
 *
 * @param streamerId - DB row ID of the streamer, used to scope the log entry and dashboard SSE channel.
 * @param eventType - Kind of activity that occurred.
 * @param displayName - The acting Twitch viewer's display name.
 * @param detail - Short additional context, or null if there's none.
 * @returns A promise that resolves once the event is recorded and pushed to the dashboard.
 */
async function recordAndPushDashboardEventOrThrow(
  streamerId: number,
  eventType: StreamerEventType,
  displayName: string,
  detail: string | null,
): Promise<void> {
  await recordStreamerEvent(streamerId, eventType, displayName, detail);
  dashboardEventRuntimeRegistry.get()?.pushDashboardEvent(streamerId, {
    eventType, displayName, detail, occurredAt: new Date().toISOString(),
  });
}

/**
 * Handle a channel.follow EventSub notification.
 * Sends a chat message to the broadcaster's channel using the injected Twitch runtime when
 * `config.follow_enabled` is true, independently pushes a browser-source alert via
 * {@link maybePushAlert} when the streamer's follow alert is enabled, and unconditionally
 * records the follow to the dashboard's "Recent Events" feed via {@link recordAndPushDashboardEvent}.
 *
 * @param login - Broadcaster login name (chat channel to send to).
 * @param event - Follow event payload from Twitch EventSub.
 * @param config - Streamer's event response configuration.
 * @param streamerId - DB row ID of the streamer, used to look up alert config.
 */
export async function handleFollow(login: string, event: FollowEvent, config: EventSubConfig, streamerId: number): Promise<void> {
  const vars = { username: event.user_login, display_name: event.user_name };
  await maybeSendChatMessage(login, config.follow_enabled, config.follow_message, vars);
  await maybePushAlert(login, streamerId, 'follow', vars);
  await recordAndPushDashboardEvent(streamerId, 'follow', event.user_name, null);
}

/**
 * Handle a channel.subscribe EventSub notification. Gift subs are silently skipped entirely
 * (handled by handleGiftSub) for the chat message, the alert, and the dashboard feed. Otherwise
 * sends a chat message when `config.sub_enabled` is true, independently pushes a browser-source
 * alert via {@link maybePushAlert} when the streamer's sub alert is enabled, and unconditionally
 * records the sub to the dashboard's "Recent Events" feed via {@link recordAndPushDashboardEvent}.
 *
 * @param login - Broadcaster login name.
 * @param event - Subscribe event payload; gift subs are silently skipped (handled by handleGiftSub).
 * @param config - Streamer's event response configuration.
 * @param streamerId - DB row ID of the streamer, used to look up alert config.
 */
export async function handleSub(login: string, event: SubEvent, config: EventSubConfig, streamerId: number): Promise<void> {
  if (event.is_gift) return;
  const vars = {
    username: event.user_login,
    display_name: event.user_name,
    tier: event.tier,
    tier_name: tierName(event.tier),
  };
  await maybeSendChatMessage(login, config.sub_enabled, config.sub_message, vars);
  await maybePushAlert(login, streamerId, 'sub', vars);
  await recordAndPushDashboardEvent(streamerId, 'sub', event.user_name, tierName(event.tier));
}

/**
 * Handle a channel.subscription.message (resub) EventSub notification.
 * Sends a chat message when `config.sub_enabled` is true, independently pushes a
 * browser-source alert via {@link maybePushAlert} when the streamer's resub alert is enabled,
 * and unconditionally records the resub to the dashboard's "Recent Events" feed via
 * {@link recordAndPushDashboardEvent}.
 *
 * @param login - Broadcaster login name.
 * @param event - Resub event payload including cumulative and streak month counts.
 * @param config - Streamer's event response configuration.
 * @param streamerId - DB row ID of the streamer, used to look up alert config.
 */
export async function handleResub(login: string, event: ResubEvent, config: EventSubConfig, streamerId: number): Promise<void> {
  const vars = {
    username: event.user_login,
    display_name: event.user_name,
    tier: event.tier,
    tier_name: tierName(event.tier),
    months: String(event.cumulative_months),
    streak: event.streak_months != null ? String(event.streak_months) : '0',
  };
  await maybeSendChatMessage(login, config.sub_enabled, config.resub_message, vars);
  await maybePushAlert(login, streamerId, 'resub', vars);
  await recordAndPushDashboardEvent(streamerId, 'resub', event.user_name, `${tierName(event.tier)} · ${event.cumulative_months} months`);
}

/**
 * Handle a channel.subscription.gift EventSub notification.
 * Anonymous gifters are reported as "anonymous" / "Anonymous" everywhere, including the
 * dashboard feed. Sends a chat message when `config.sub_enabled` is true, independently pushes
 * a browser-source alert via {@link maybePushAlert} when the streamer's gift-sub alert is
 * enabled, and unconditionally records the gift sub to the dashboard's "Recent Events" feed via
 * {@link recordAndPushDashboardEvent}.
 *
 * @param login - Broadcaster login name.
 * @param event - Gift-sub event payload; `is_anonymous` controls gifter display name.
 * @param config - Streamer's event response configuration.
 * @param streamerId - DB row ID of the streamer, used to look up alert config.
 */
export async function handleGiftSub(login: string, event: GiftSubEvent, config: EventSubConfig, streamerId: number): Promise<void> {
  const gifter = event.is_anonymous ? 'anonymous' : event.user_login;
  const gifterDisplay = event.is_anonymous ? 'Anonymous' : event.user_name;
  const vars = {
    gifter,
    gifter_display: gifterDisplay,
    count: String(event.total),
    tier: event.tier,
    tier_name: tierName(event.tier),
  };
  await maybeSendChatMessage(login, config.sub_enabled, config.giftsub_message, vars);
  await maybePushAlert(login, streamerId, 'giftsub', vars);
  await recordAndPushDashboardEvent(streamerId, 'giftsub', gifterDisplay, `${event.total} x ${tierName(event.tier)}`);
}

/**
 * Handle a channel.raid EventSub notification. Three independent behaviours are gated by
 * their own flags and none depends on the others:
 *  - `config.raid_enabled` — sends the configured welcome message.
 *  - `config.raid_shoutout_enabled` — looks up the raiding channel via
 *    {@link buildShoutoutMessage} (the same Helix lookup path as the `!so` command)
 *    and sends the resulting shoutout. No-ops silently if the raiding channel can't
 *    be resolved on Twitch.
 *  - The streamer's raid alert config (via {@link maybePushAlert}) — pushes a browser-source
 *    alert independently of both of the above.
 *  - The dashboard's "Recent Events" feed (via {@link recordAndPushDashboardEvent}) — recorded
 *    unconditionally, independently of all of the above.
 * The chat-message branches no-op when no Twitch runtime has been registered.
 *
 * @param login - Broadcaster login name (the raid target's channel).
 * @param event - Raid event payload including the raiding channel and viewer count.
 * @param config - Streamer's event response configuration.
 * @param streamerId - DB row ID of the streamer, used to look up alert config.
 */
export async function handleRaid(login: string, event: RaidEvent, config: EventSubConfig, streamerId: number): Promise<void> {
  const vars = {
    from_channel: event.from_broadcaster_user_login,
    from_display: event.from_broadcaster_user_name,
    viewers: String(event.viewers),
  };

  await maybeSendChatMessage(login, config.raid_enabled, config.raid_message, vars);

  if (config.raid_shoutout_enabled) {
    try {
      const shoutoutMsg = await buildShoutoutMessage(event.from_broadcaster_user_login);
      if (shoutoutMsg) {
        await sendChatMessage(login, shoutoutMsg);
      }
    } catch (err) {
      log.error(`Failed to build raid shoutout for ${login}:`, err);
    }
  }

  await maybePushAlert(login, streamerId, 'raid', vars);
  await recordAndPushDashboardEvent(streamerId, 'raid', event.from_broadcaster_user_name, `${event.viewers} viewers`);
}

/**
 * Handle a channel.channel_points_custom_reward_redemption.add EventSub notification.
 * Records the redemption to the dashboard's "Recent Events" feed (via
 * {@link recordAndPushDashboardEventOrThrow}) and applies dynamic pricing for the redeemed reward
 * (a no-op if the reward doesn't have dynamic pricing enabled) — both are required: their
 * failures propagate so the redemption is retried rather than silently marked complete. Only
 * once both succeed does it forward the redemption to the streamer's companion app (if any
 * device is connected) — this isolates its own errors internally (try/catch) and is
 * intentionally best-effort, so a companion-push failure can't reject this function. It runs
 * last among these three (not first) precisely because it's best-effort and can't be un-sent: if
 * it ran before a required effect that then failed, a retry would re-deliver the same companion
 * notification. Finally it looks up videos configured for the redeemed reward and triggers an
 * overlay event if found; the overlay push still no-ops when no videos are configured for the
 * reward or no overlay runtime is registered.
 *
 * Deduplicates on Twitch's own redemption id ({@link isDuplicateRedemption}) before doing
 * anything else — a duplicate (or an id already being processed by another in-flight call) is
 * dropped silently, since every effect below (companion push, dashboard record, pricing, overlay
 * trigger) would otherwise double-fire for one physical redemption. The id is only marked as
 * successfully handled ({@link markRedemptionHandled}) once the dashboard record, pricing update,
 * and overlay lookup have all completed without throwing (the companion push is exempt, since
 * it's intentionally best-effort). A failure clears the in-flight claim
 * ({@link clearPendingRedemption}) instead, so a retry of the same redemption id (e.g.
 * reconciliation's next poll tick) is not misclassified as a duplicate and re-runs the failed
 * work from scratch.
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

  // Only mark the redemption as handled (via markRedemptionHandled) once every effect below has
  // run without throwing. If anything throws, clearPendingRedemption releases the in-flight claim
  // and the error is rethrown, so a retry (e.g. reconciliation's next poll tick) re-runs this
  // redemption from scratch instead of being silently dropped as a duplicate.
  try {
    const detail = event.user_input ? `${event.reward.title}: ${event.user_input}` : event.reward.title;
    await recordAndPushDashboardEventOrThrow(streamerId, 'redemption', event.user_name, detail);

    // Awaited (unlike the other EventSub handlers' fire-and-forget pricing calls elsewhere):
    // a failed pricing update must propagate so the redemption is retried instead of silently
    // marked complete. See the doc comment above.
    await applyRedemptionPricing(streamerId, event.reward.id);

    // Deliberately runs after both required effects above (not before): the companion push is
    // best-effort and can't be un-sent, so if it ran first and a required effect then failed, a
    // retry would deliver the same companion notification twice for one redemption.
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

    const videos = await getVideosForReward(event.reward.id, streamerId);
    if (videos.length > 0) {
      const filename = pickWeightedRandom(videos);
      const videoPath = `/overlay/videos/${streamerId}/${filename}`;
      overlayRuntimeRegistry.get()?.pushOverlayEvent(login, videoPath);
      log.info(`Overlay triggered for ${login}: reward="${event.reward.title}" video=${filename}`);
    }
    markRedemptionHandled(event.id);
    return true;
  } catch (err) {
    clearPendingRedemption(event.id);
    throw err;
  }
}

/**
 * Handle a stream.online EventSub notification by triggering an immediate live-check
 * for the broadcaster, bypassing the Twitch monitor's 60s poll interval. The poller
 * still runs as a fallback for streamers without EventSub connected, and re-checking
 * here is harmless if it already caught the change first.
 *
 * @param login - Broadcaster login name.
 * @returns Resolves after triggering the immediate live-check.
 */
export async function handleStreamOnline(login: string): Promise<void> {
  await triggerImmediateLiveCheck(login);
}

/**
 * Handle a stream.offline EventSub notification by triggering an immediate live-check
 * for the broadcaster. This starts the same 5-minute offline grace period the poller
 * uses before removing the live announcement, since both paths share the same
 * `liveStates` map.
 *
 * @param login - Broadcaster login name.
 * @returns Resolves after triggering the immediate live-check.
 */
export async function handleStreamOffline(login: string): Promise<void> {
  await triggerImmediateLiveCheck(login);
}

/**
 * Handle a channel.update EventSub notification (title/category change) by triggering
 * an immediate live-check for the broadcaster. Reuses the same poll-and-decide logic
 * as stream.online/offline, so a title or game change posted via Twitch is reflected
 * on Discord without waiting for the next 60s poll.
 *
 * @param login - Broadcaster login name.
 * @returns Resolves after triggering the immediate live-check.
 */
export async function handleChannelUpdate(login: string): Promise<void> {
  await triggerImmediateLiveCheck(login);
}
