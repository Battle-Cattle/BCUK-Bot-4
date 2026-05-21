import { createLogger } from './logger';
import { getAllEventSubStreamers, saveStreamerToken, clearStreamerToken, DbStreamerEventSub, EventSubConfig } from './db/eventSub';
import { getAppToken, getUsers } from './twitchApi';
import { TwitchAuthError, refreshUserToken, createEventSubSubscription, listEventSubSubscriptions, deleteEventSubSubscription } from './twitchApiEventSub';
import { getActiveChannels } from './twitchBot';
import {
  handleFollow, handleSub, handleResub, handleGiftSub, handleRaid,
  FollowEvent, SubEvent, ResubEvent, GiftSubEvent, RaidEvent,
} from './twitchEventSubHandler';

const log = createLogger('EventSub');

const BUFFER_MS = 5 * 60 * 1000;

export interface SubSpec { type: string; version: string; condition: Record<string, string> }

// In-memory lookup keyed by Twitch broadcaster user ID
export interface StreamerInfo { login: string; streamerId: number; config: EventSubConfig | null }
const streamerMap = new Map<string, StreamerInfo>();

// Maps EventSub notification types to their handler functions.
// Using Map instead of a plain object prevents prototype-chain lookup on user-controlled keys.
type NotificationHandler = (login: string, event: unknown, config: EventSubConfig) => Promise<void>;
const notificationHandlers = new Map<string, NotificationHandler>([
  ['channel.follow',               (l, e, c) => handleFollow(l, e as FollowEvent, c)],
  ['channel.subscribe',            (l, e, c) => handleSub(l, e as SubEvent, c)],
  ['channel.subscription.message', (l, e, c) => handleResub(l, e as ResubEvent, c)],
  ['channel.subscription.gift',    (l, e, c) => handleGiftSub(l, e as GiftSubEvent, c)],
  ['channel.raid',                 (l, e, c) => handleRaid(l, e as RaidEvent, c)],
]);

async function deleteStaleSubscriptions(uid: string, desired: Set<string>, userToken: string | null): Promise<void> {
  try {
    if (userToken) {
      const existing = await listEventSubSubscriptions(userToken);
      for (const sub of existing) {
        if (!desired.has(sub.type)) await deleteEventSubSubscription(sub.id, userToken);
      }
    }
    const appToken = await getAppToken();
    const raidSubs = await listEventSubSubscriptions(appToken, uid);
    for (const sub of raidSubs.filter((s) => s.type === 'channel.raid' && !desired.has('channel.raid'))) {
      await deleteEventSubSubscription(sub.id, appToken);
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
  try {
    const users = await getUsers([streamer.name]);
    return users[0]?.id ?? null;
  } catch (err) {
    log.error(`Failed to resolve Twitch user ID for ${streamer.name}:`, err);
    return null;
  }
}

/** Creates all desired EventSub subscriptions for a single streamer and returns the desired-types set. */
async function createSubscriptionsForStreamer(
  sid: string, uid: string, token: string | null, config: EventSubConfig | null, name: string,
): Promise<Set<string>> {
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

  if (config?.raid_enabled) {
    desired.add('channel.raid');
    try {
      const appToken = await getAppToken();
      await subscribe(sid, { type: 'channel.raid', version: '1', condition: { to_broadcaster_user_id: uid } }, appToken, name);
    } catch (err) {
      log.error(`Failed to get app token for raid sub (${name}):`, err);
    }
  }

  return desired;
}

export async function subscribeAll(sid: string): Promise<void> {
  const streamers = await getAllEventSubStreamers();
  streamerMap.clear();

  for (const streamer of streamers) {
    const token = await maybeRefreshToken(streamer);
    const config = streamer.config;
    const uid = await resolveBroadcasterId(streamer, config);
    if (!uid) continue;

    streamerMap.set(uid, { login: streamer.name, streamerId: streamer.id, config });

    // Create desired subscriptions first so there is never a gap where zero are active
    const desired = await createSubscriptionsForStreamer(sid, uid, token, config, streamer.name);
    await deleteStaleSubscriptions(uid, desired, token);
  }
}

async function subscribe(sessionId: string, spec: SubSpec, token: string, login: string): Promise<void> {
  try {
    const id = await createEventSubSubscription(spec.type, spec.version, spec.condition, sessionId, token);
    if (id !== null) log.info(`Subscribed to ${spec.type} for ${login}`);
  } catch (err) {
    log.error(`Failed to subscribe to ${spec.type} for ${login}:`, err);
  }
}

async function maybeRefreshToken(streamer: DbStreamerEventSub): Promise<string | null> {
  if (!streamer.eventsub_access_token) return null;

  const needsRefresh = !streamer.eventsub_token_expiry
    || Date.now() > streamer.eventsub_token_expiry - BUFFER_MS;

  if (!needsRefresh) return streamer.eventsub_access_token;

  if (!streamer.eventsub_refresh_token) {
    log.warn(`No refresh token for ${streamer.name}`);
    return null;
  }

  try {
    const tokens = await refreshUserToken(streamer.eventsub_refresh_token);
    const expiryMs = Date.now() + tokens.expires_in * 1000 - 60_000;
    await saveStreamerToken(streamer.id, streamer.twitch_user_id!, tokens.access_token, tokens.refresh_token, expiryMs);
    log.info(`Token refreshed for ${streamer.name}`);
    return tokens.access_token;
  } catch (err) {
    if (err instanceof TwitchAuthError) {
      await clearStreamerToken(streamer.id);
      log.error(`Token refresh failed for ${streamer.name} — re-authorization required:`, err);
    } else {
      log.error(`Token refresh failed for ${streamer.name} — transient error, will retry on next reload:`, err);
    }
    return null;
  }
}

export function dispatchNotification(type: string, event: Record<string, unknown>, condition: Record<string, string>): void {
  const broadcasterId = condition.broadcaster_user_id ?? condition.to_broadcaster_user_id;
  if (!broadcasterId) return;

  const info = streamerMap.get(broadcasterId);
  if (!info?.config) return;

  if (!getActiveChannels().has(info.login)) {
    log.warn(`Bot not in channel ${info.login} — skipping ${type} notification`);
    return;
  }

  const handler = notificationHandlers.get(type);
  if (!handler) {
    log.warn(`Unsupported EventSub notification type: ${type}`);
    return;
  }
  handler(info.login, event, info.config)
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
