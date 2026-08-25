import { createLogger } from '../../shared/logger';
import { clearStreamerToken, DEFAULT_EVENT_CONFIG } from '../../db';
import type { EventSubConfig } from '../../db';
import {
  handleFollow, handleSub, handleResub, handleGiftSub, handleRaid, handleRedemption,
  handleStreamOnline, handleStreamOffline, handleChannelUpdate,
  FollowEvent, SubEvent, ResubEvent, GiftSubEvent, RaidEvent, RedemptionEvent,
} from './twitchEventSubHandler';

const log = createLogger('EventSub');

/** In-memory streamer info keyed by broadcaster user ID. */
export interface StreamerInfo { login: string; streamerId: number; config: EventSubConfig | null }
const streamerMap = new Map<string, StreamerInfo>();

/** Records or updates a streamer's dispatch info, keyed by their broadcaster user ID. */
export function setStreamerInfo(uid: string, info: StreamerInfo): void {
  streamerMap.set(uid, info);
}

/** Removes a streamer from the in-memory map (called when their connection is stopped). */
export function removeStreamerFromMap(uid: string): void {
  streamerMap.delete(uid);
}

/**
 * Returns the live streamer-dispatch map, keyed by broadcaster Twitch user ID. Read-only view
 * used by the EventSub reconciliation poll to enumerate every streamer currently connected via
 * EventSub, without duplicating this module's connection-tracking state.
 */
export function getAllStreamerInfo(): ReadonlyMap<string, StreamerInfo> {
  return streamerMap;
}

// Maps EventSub notification types to their handler functions.
// Using Map instead of a plain object prevents prototype-chain lookup on user-controlled keys.
type NotificationHandler = (login: string, event: unknown, config: EventSubConfig, streamerId: number) => Promise<void>;
const notificationHandlers = new Map<string, NotificationHandler>([
  ['channel.follow',                                   (l, e, c, sid) => handleFollow(l, e as FollowEvent, c, sid)],
  ['channel.subscribe',                                (l, e, c, sid) => handleSub(l, e as SubEvent, c, sid)],
  ['channel.subscription.message',                     (l, e, c, sid) => handleResub(l, e as ResubEvent, c, sid)],
  ['channel.subscription.gift',                        (l, e, c, sid) => handleGiftSub(l, e as GiftSubEvent, c, sid)],
  ['channel.raid',                                     (l, e, c, sid) => handleRaid(l, e as RaidEvent, c, sid)],
  // handleRedemption resolves a processed/duplicate boolean (used by reconciliation); discarded
  // here since this dispatch table's live-notification path only needs the side effects.
  ['channel.channel_points_custom_reward_redemption.add',  async (l, e, c, sid) => { await handleRedemption(l, e as RedemptionEvent, c, sid); }],
  ['stream.online',                                    (l) => handleStreamOnline(l)],
  ['stream.offline',                                   (l) => handleStreamOffline(l)],
  ['channel.update',                                    (l) => handleChannelUpdate(l)],
]);

/**
 * Routes an EventSub notification to the appropriate handler based on subscription type.
 * A streamer with no `streamer_event_config` row (`info.config` null) — e.g. one who has only
 * ever enabled a browser-source alert and never completed the chat-message OAuth setup — still
 * dispatches, using `DEFAULT_EVENT_CONFIG` (every chat-message flag disabled) in place of the
 * missing config, so their alert-only subscriptions aren't silently discarded here. Without
 * this fallback, `isGroupEnabled`'s alert-driven subscription creation and this dispatch gate
 * would disagree: the subscription would exist but every notification for it would be dropped.
 */
export function dispatchNotification(type: string, event: Record<string, unknown>, condition: Record<string, string>): void {
  const broadcasterId = condition.broadcaster_user_id ?? condition.to_broadcaster_user_id;
  if (!broadcasterId) {
    log.warn(`EventSub notification (${type}) has no broadcaster_user_id/to_broadcaster_user_id in its condition — dropping`);
    return;
  }

  const info = streamerMap.get(broadcasterId);
  if (!info) {
    log.warn(`EventSub notification (${type}) for unknown broadcaster ${broadcasterId} — not in the dispatch map, dropping`);
    return;
  }
  const config = info.config ?? DEFAULT_EVENT_CONFIG;

  const handler = notificationHandlers.get(type);
  if (!handler) {
    log.warn(`Unsupported EventSub notification type: ${type}`);
    return;
  }
  // TypeScript has already narrowed handler to NotificationHandler here, but the explicit
  // typeof check is required for CodeQL's taint analysis to trust the call is safe.
  if (typeof handler !== 'function') {
    log.warn(`Invalid EventSub handler for type: ${type}`);
    return;
  }
  handler(info.login, event, config, info.streamerId)
    .catch((err) => log.error(`${type} handler error:`, err));
}

/** Handles a subscription revocation message, clearing the broadcaster's token if authorisation was revoked. */
export function handleRevocation(sub: { type: string; status: string; condition: Record<string, string> }): void {
  log.warn(`Subscription revoked: type=${sub.type} status=${sub.status}`);

  if (sub.status === 'authorization_revoked' || sub.status === 'user_removed') {
    const broadcasterId = sub.condition.broadcaster_user_id ?? sub.condition.to_broadcaster_user_id;
    if (broadcasterId) {
      const info = streamerMap.get(broadcasterId);
      if (info) {
        clearStreamerToken(info.streamerId)
          .then(() => log.warn(`Cleared token for ${info.login} (${sub.status})`))
          .catch((err) => log.error('Clear token error:', err));
      }
    }
  }
}
