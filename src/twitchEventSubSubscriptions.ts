import { createLogger } from './logger';
import { getAllEventSubStreamers, clearStreamerToken, DbStreamerEventSub, EventSubConfig } from './db/eventSub';
import { getUsers } from './twitchApi';
import { getActiveChannels } from './twitchBot';
import { normalizeTwitchChannelName } from './twitchChannelName';
import { createEventSubSubscription, listEventSubSubscriptions, deleteEventSubSubscription, getValidToken, TwitchAuthError } from './twitchApiEventSub';
import {
  handleFollow, handleSub, handleResub, handleGiftSub, handleRaid, handleRedemption,
  FollowEvent, SubEvent, ResubEvent, GiftSubEvent, RaidEvent, RedemptionEvent,
} from './twitchEventSubHandler';

const log = createLogger('EventSub');


export interface SubSpec { type: string; version: string; condition: Record<string, string> }

// In-memory lookup keyed by Twitch broadcaster user ID
export interface StreamerInfo { login: string; streamerId: number; config: EventSubConfig | null }
const streamerMap = new Map<string, StreamerInfo>();

// Maps EventSub notification types to their handler functions.
// Using Map instead of a plain object prevents prototype-chain lookup on user-controlled keys.
type NotificationHandler = (login: string, event: unknown, config: EventSubConfig, streamerId: number) => Promise<void>;
const notificationHandlers = new Map<string, NotificationHandler>([
  ['channel.follow',                                   (l, e, c) => handleFollow(l, e as FollowEvent, c)],
  ['channel.subscribe',                                (l, e, c) => handleSub(l, e as SubEvent, c)],
  ['channel.subscription.message',                     (l, e, c) => handleResub(l, e as ResubEvent, c)],
  ['channel.subscription.gift',                        (l, e, c) => handleGiftSub(l, e as GiftSubEvent, c)],
  ['channel.raid',                                     (l, e, c) => handleRaid(l, e as RaidEvent, c)],
  ['channel.channel_points_custom_reward_redemption.add',  (l, e, c, sid) => handleRedemption(l, e as RedemptionEvent, c, sid)],
]);

async function deleteStaleSubscriptions(uid: string, desired: Set<string>, userToken: string | null): Promise<void> {
  if (!userToken) return;
  try {
    const existing = await listEventSubSubscriptions(userToken);
    for (const sub of existing) {
      if (!desired.has(sub.type)) await deleteEventSubSubscription(sub.id, userToken);
    }
  } catch (err) {
    log.error(`Subscription cleanup failed for uid ${uid}:`, err);
  }
}

/** Resolves the broadcaster's Twitch user ID. Uses the stored OAuth ID if available;
 *  falls back to a Helix lookup for raid-only streamers who haven't connected OAuth. */
async function resolveBroadcasterId(streamer: DbStreamerEventSub, config: EventSubConfig | null): Promise<string | null> {
  if (streamer.twitch_user_id) return streamer.twitch_user_id;
  if (!config?.raid_enabled) return null;
  if (!streamer.twitch_name) return null;
  try {
    const users = await getUsers([streamer.twitch_name]);
    return users[0]?.id ?? null;
  } catch (err) {
    log.error(`Failed to resolve Twitch user ID for ${streamer.twitch_name}:`, err);
    return null;
  }
}

/** Creates all desired EventSub subscriptions for a single streamer and returns the desired-types set. */
async function createSubscriptionsForStreamer(
  sid: string, uid: string, token: string | null, config: EventSubConfig | null, name: string,
): Promise<Set<string>> {
  const normalizedName = normalizeTwitchChannelName(name) ?? name.toLowerCase();
  if (!getActiveChannels().has(normalizedName)) {
    log.info(`Skipping EventSub subscriptions for ${name} — bot not in channel`);
    return new Set();
  }

  const desired = new Set<string>();

  if (config?.follow_enabled && token) {
    desired.add('channel.follow');
    await subscribe(sid, { type: 'channel.follow', version: '2',
      condition: { broadcaster_user_id: uid, moderator_user_id: uid } }, token, name);
  }

  if (config?.sub_enabled && token) {
    desired.add('channel.subscribe');
    desired.add('channel.subscription.message');
    desired.add('channel.subscription.gift');
    await subscribe(sid, { type: 'channel.subscribe', version: '1', condition: { broadcaster_user_id: uid } }, token, name);
    await subscribe(sid, { type: 'channel.subscription.message', version: '1', condition: { broadcaster_user_id: uid } }, token, name);
    await subscribe(sid, { type: 'channel.subscription.gift', version: '1', condition: { broadcaster_user_id: uid } }, token, name);
  }

  // WebSocket transport requires a user token — app tokens only work with webhook transport.
  // Raids therefore also require the broadcaster's OAuth token.
  if (config?.raid_enabled && token) {
    desired.add('channel.raid');
    await subscribe(sid, { type: 'channel.raid', version: '1', condition: { to_broadcaster_user_id: uid } }, token, name);
  }

  // Subscribe to channel points redemptions when a broadcaster token and config are available.
  // Gated on config to keep subscription and dispatch aligned (dispatchNotification early-exits without config).
  if (config && token) {
    desired.add('channel.channel_points_custom_reward_redemption.add');
    await subscribe(sid, {
      type: 'channel.channel_points_custom_reward_redemption.add',
      version: '1',
      condition: { broadcaster_user_id: uid },
    }, token, name);
  }

  return desired;
}

export async function subscribeAll(sid: string): Promise<number> {
  const streamers = await getAllEventSubStreamers();

  // Build into a temporary map so dispatchNotification/handleRevocation see a
  // consistent snapshot throughout the async loop, not an empty map mid-reload.
  const nextMap = new Map<string, StreamerInfo>();
  let totalSubscriptions = 0;

  for (const streamer of streamers) {
    const token = await getValidToken(streamer);
    const config = streamer.config;
    const uid = await resolveBroadcasterId(streamer, config);
    if (!uid) continue;

    nextMap.set(uid, { login: streamer.twitch_name ?? '', streamerId: streamer.id, config });

    // Create desired subscriptions first so there is never a gap where zero are active
    let desired: Set<string>;
    try {
      desired = await createSubscriptionsForStreamer(sid, uid, token, config, streamer.twitch_name ?? '');
    } catch (err) {
      if (err instanceof TwitchAuthError) {
        log.warn(`Clearing token for ${streamer.twitch_name ?? uid} — authorization missing, user must reconnect Twitch`);
        await clearStreamerToken(streamer.id);
      } else {
        log.error(`createSubscriptionsForStreamer failed for ${streamer.twitch_name ?? uid}:`, err);
      }
      continue;
    }
    totalSubscriptions += desired.size;
    await deleteStaleSubscriptions(uid, desired, token);
  }

  // Atomic swap — old map stays readable until all subscriptions are ready
  streamerMap.clear();
  for (const [uid, info] of nextMap) streamerMap.set(uid, info);
  return totalSubscriptions;
}

async function subscribe(sessionId: string, spec: SubSpec, token: string, login: string): Promise<void> {
  try {
    const id = await createEventSubSubscription(spec.type, spec.version, spec.condition, sessionId, token);
    if (id !== null) log.info(`Subscribed to ${spec.type} for ${login}`);
  } catch (err) {
    if (err instanceof TwitchAuthError) throw err;
    log.error(`Failed to subscribe to ${spec.type} for ${login}:`, err);
  }
}


export function dispatchNotification(type: string, event: Record<string, unknown>, condition: Record<string, string>): void {
  const broadcasterId = condition.broadcaster_user_id ?? condition.to_broadcaster_user_id;
  if (!broadcasterId) return;

  const info = streamerMap.get(broadcasterId);
  if (!info?.config) return;

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
  handler(info.login, event, info.config, info.streamerId)
    .catch((err) => log.error(`${type} handler error:`, err));
}

export function handleRevocation(sub: { type: string; status: string; condition: Record<string, string> }): void {
  log.warn(`Subscription revoked: type=${sub.type} status=${sub.status}`);

  if (sub.status === 'authorization_revoked' || sub.status === 'user_removed') {
    const broadcasterId = sub.condition.broadcaster_user_id ?? sub.condition.to_broadcaster_user_id;
    if (broadcasterId) {
      const info = streamerMap.get(broadcasterId);
      if (info) {
        clearStreamerToken(info.streamerId)
          .catch((err) => log.error('Clear token error:', err));
        log.warn(`Cleared token for ${info.login} (${sub.status})`);
      }
    }
  }
}
