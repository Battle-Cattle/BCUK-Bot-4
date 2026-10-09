// Side effects shared by the EventSub notification handlers (`twitchEventSubHandler.ts` and
// `twitchEventSubRedemption.ts`): chat sends, browser-source alert pushes, and the dashboard
// "Recent Events" record with its companion-app forward. Each one logs and swallows its own
// failures so one effect can never block the next.
import type { AlertEventType, StreamerEventType } from '../../db';
import type { CompanionActivityEvent, CompanionActivityEventType } from './twitchEventSubRuntime';
import { getStreamerById, findCachedAlertConfig, recordStreamerEvent } from '../../db';
import { createLogger } from '../../shared/logger';
import { fillTemplate } from '../../shared/textTemplate';
import {
  companionRuntimeRegistry,
  alertRuntimeRegistry,
  dashboardEventRuntimeRegistry,
  twitchRuntimeRegistry,
} from './twitchEventSubRuntime';

const log = createLogger('EventSubHandler');

/**
 * Sends a chat message via the injected Twitch runtime, logging and swallowing any failure
 * (e.g. the bot lacking channel access, or a transient Twitch API error) instead of letting it
 * propagate — a chat-send failure must never prevent the independent {@link maybePushAlert} call
 * that follows it in each EventSub handler.
 *
 * @param login - Broadcaster login name (chat channel to send to).
 * @param message - Chat message to send.
 * @returns True if a runtime was registered and the send succeeded; false if no runtime is
 *   registered or the send failed, so callers can avoid recording an unsent message as sent.
 */
export async function sendChatMessage(login: string, message: string): Promise<boolean> {
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
 * each EventSub handler's chat-message gate, which differ only in which `EventSubConfig` flag and
 * message template they read.
 * @param login - Broadcaster login name (chat channel to send to).
 * @param enabled - The relevant config flag (e.g. `config.follow_enabled`).
 * @param template - The relevant message template (e.g. `config.follow_message`).
 * @param vars - Template variables to fill.
 * @returns Resolves once the (possibly skipped) send completes.
 */
export async function maybeSendChatMessage(login: string, enabled: boolean, template: string, vars: Record<string, string>): Promise<void> {
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
export async function maybePushAlert(
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
 * Also best-effort forwards the event to the streamer's companion app (see
 * {@link pushCompanionActivityEvent}) — this handler is only ever called with a non-redemption
 * `eventType` (redemptions go through `recordAndPushDashboardEventOrThrow` in
 * `twitchEventSubRedemption.ts` instead), so every event it records is a valid
 * {@link CompanionActivityEventType}.
 *
 * @param streamerId - DB row ID of the streamer, used to scope the log entry and dashboard SSE channel.
 * @param eventType - Kind of activity that occurred.
 * @param displayName - The acting Twitch viewer's display name (follower, raider, redeemer, etc.).
 * @param detail - Short additional context (e.g. raid viewer count, redeemed reward name and any
 *   text the viewer entered), or null if there's none.
 */
export async function recordAndPushDashboardEvent(
  streamerId: number,
  eventType: StreamerEventType,
  displayName: string,
  detail: string | null,
): Promise<void> {
  try {
    // No `redemptionId` is passed here, so recordStreamerEvent never skips the insert as an
    // already-recorded duplicate — the returned id is always the new row's, never null.
    const eventId = (await recordStreamerEvent(streamerId, eventType, displayName, detail))!;
    const occurredAt = new Date().toISOString();
    dashboardEventRuntimeRegistry.get()?.pushDashboardEvent(streamerId, { eventType, displayName, detail, occurredAt });
    await pushCompanionActivityEvent(streamerId, {
      type: eventType as CompanionActivityEventType, id: eventId, displayName, detail, occurredAt,
    });
  } catch (err) {
    log.error(`Failed to record ${eventType} dashboard event for streamer ${streamerId}:`, err);
  }
}

/**
 * Best-effort forwards a follow/sub/resub/giftsub/raid activity event to the owning streamer's
 * companion app, if any device is connected. Isolates its own errors (try/catch) so a
 * companion-push failure can never affect the dashboard record/push that triggered it — mirrors
 * the same best-effort isolation `handleRedemption` (`twitchEventSubRedemption.ts`) uses for its
 * own companion push.
 *
 * @param streamerId - DB row ID of the streamer, used to resolve the owning Discord ID.
 * @param event - The activity event to forward, already shaped for the companion SSE payload
 *   (including its stable `streamer_event_log.id`, shared with the `/events/recent` backfill so
 *   the companion client can dedupe/order exactly instead of by timestamp heuristic).
 */
async function pushCompanionActivityEvent(
  streamerId: number,
  event: CompanionActivityEvent,
): Promise<void> {
  try {
    const streamer = await getStreamerById(streamerId);
    if (streamer) {
      companionRuntimeRegistry.get()?.pushCompanionEvent(streamer.discord_id, event);
    }
  } catch (err) {
    log.error(`Failed to push companion event for ${event.type}:`, err);
  }
}
