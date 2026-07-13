import { createLogger } from '../../shared/logger';
import { getAllEventSubStreamers, clearStreamerToken } from '../../db';
import type { DbStreamerEventSub, EventSubConfig } from '../../db';
import { getUsers } from '../twitchApi';
import { getActiveChannels } from '../twitchChannelMembership';
import { normalizeTwitchChannelName } from '../twitchChannelName';
import { createEventSubSubscription, listEventSubSubscriptions, deleteEventSubSubscription, getValidToken, TwitchAuthError } from './twitchApiEventSub';
import {
  handleFollow, handleSub, handleResub, handleGiftSub, handleRaid, handleRedemption,
  handleStreamOnline, handleStreamOffline, handleChannelUpdate,
  FollowEvent, SubEvent, ResubEvent, GiftSubEvent, RaidEvent, RedemptionEvent,
} from './twitchEventSubHandler';

const log = createLogger('EventSub');


/** Describes a single EventSub subscription to create. */
export interface SubSpec { type: string; version: string; condition: Record<string, string> }

/** In-memory streamer info keyed by broadcaster user ID. */
export interface StreamerInfo { login: string; streamerId: number; config: EventSubConfig | null }
const streamerMap = new Map<string, StreamerInfo>();

// Tracks "login:type:token" triples that failed with 403 — skipped until bot restarts or token changes
const authFailedSubs = new Set<string>();

/** Returns true if any subscription for the given login has previously failed with a 403. */
export function hasAuthFailedSubs(login: string): boolean {
  const prefix = `${login}:`;
  for (const key of authFailedSubs) if (key.startsWith(prefix)) return true;
  return false;
}

/** Clears all auth-failed subscription records for the given login. */
export function clearAuthFailedSubs(login: string): void {
  const prefix = `${login}:`;
  for (const key of authFailedSubs) if (key.startsWith(prefix)) authFailedSubs.delete(key);
}

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
  ['stream.online',                                    (l) => handleStreamOnline(l)],
  ['stream.offline',                                   (l) => handleStreamOffline(l)],
  ['channel.update',                                    (l) => handleChannelUpdate(l)],
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
 *  falls back to a Helix lookup for raid-only streamers (welcome message and/or
 *  auto-shoutout) who haven't connected OAuth. */
async function resolveBroadcasterId(streamer: DbStreamerEventSub, config: EventSubConfig | null): Promise<string | null> {
  if (streamer.twitch_user_id) return streamer.twitch_user_id;
  if (!config?.raid_enabled && !config?.raid_shoutout_enabled) return null;
  if (!streamer.twitch_name) return null;
  try {
    const users = await getUsers([streamer.twitch_name]);
    return users[0]?.id ?? null;
  } catch (err) {
    log.error(`Failed to resolve Twitch user ID for ${streamer.twitch_name}:`, err);
    return null;
  }
}

/** One gated group of EventSub subscriptions: created together whenever `enabled` passes. */
interface SubscriptionGroup {
  /**
   * Returns true if this group's subscriptions should be created for the streamer.
   * @param config - The streamer's event response configuration, or null if unset.
   */
  enabled: (config: EventSubConfig | null) => boolean;
  /**
   * Builds this group's subscription specs.
   * @param uid - The broadcaster's Twitch user ID.
   * @returns The subscription specs to create for this group.
   */
  specs: (uid: string) => SubSpec[];
}

// Every group also requires a broadcaster token (WebSocket transport only works with a user
// token, not an app token — see createSubscriptionsForStreamer's upfront `!token` check).
const SUBSCRIPTION_GROUPS: SubscriptionGroup[] = [
  {
    enabled: (config) => Boolean(config?.follow_enabled),
    specs: (uid) => [{ type: 'channel.follow', version: '2', condition: { broadcaster_user_id: uid, moderator_user_id: uid } }],
  },
  {
    enabled: (config) => Boolean(config?.sub_enabled),
    specs: (uid) => [
      { type: 'channel.subscribe', version: '1', condition: { broadcaster_user_id: uid } },
      { type: 'channel.subscription.message', version: '1', condition: { broadcaster_user_id: uid } },
      { type: 'channel.subscription.gift', version: '1', condition: { broadcaster_user_id: uid } },
    ],
  },
  {
    // Subscribe when either the welcome message or the auto-shoutout toggle is on —
    // handleRaid gates its own two behaviours independently, but the subscription itself
    // must exist for either to fire.
    enabled: (config) => Boolean(config?.raid_enabled || config?.raid_shoutout_enabled),
    specs: (uid) => [{ type: 'channel.raid', version: '1', condition: { to_broadcaster_user_id: uid } }],
  },
  {
    // Gated on config (not just token) to keep subscription and dispatch aligned —
    // dispatchNotification early-exits without config.
    enabled: (config) => Boolean(config),
    specs: (uid) => [{ type: 'channel.channel_points_custom_reward_redemption.add', version: '1', condition: { broadcaster_user_id: uid } }],
  },
  {
    // stream.online/offline and channel.update require no scope beyond a valid token — but,
    // like the redemption group above, still gated on config (not just token) to keep
    // subscription and dispatch aligned, since dispatchNotification early-exits without
    // config. This drives an immediate live-check that supplements (not replaces) the 60s poller.
    enabled: (config) => Boolean(config),
    specs: (uid) => [
      { type: 'stream.online', version: '1', condition: { broadcaster_user_id: uid } },
      { type: 'stream.offline', version: '1', condition: { broadcaster_user_id: uid } },
      { type: 'channel.update', version: '2', condition: { broadcaster_user_id: uid } },
    ],
  },
];

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
  if (!token) return desired;

  for (const group of SUBSCRIPTION_GROUPS) {
    if (!group.enabled(config)) continue;
    for (const spec of group.specs(uid)) {
      desired.add(spec.type);
      await subscribe(sid, spec, token, name);
    }
  }

  return desired;
}

/** Data bundle passed to a StreamerConnection for setting up EventSub subscriptions. */
export interface StreamerEventSubData {
  uid: string;
  token: string | null;
  name: string;
  config: EventSubConfig | null;
  streamerId: number;
}

/** Fetches all streamers from the DB, resolves their broadcaster IDs and valid tokens. */
export async function loadStreamersForEventSub(): Promise<StreamerEventSubData[]> {
  const streamers = await getAllEventSubStreamers();
  const result: StreamerEventSubData[] = [];
  for (const streamer of streamers) {
    const token = await getValidToken(streamer);
    const config = streamer.config;
    const uid = await resolveBroadcasterId(streamer, config);
    if (!uid) continue;
    result.push({ uid, token, name: streamer.twitch_name ?? '', config, streamerId: streamer.id });
  }
  return result;
}

/** Creates all subscriptions for one streamer on their dedicated session, updates streamerMap,
 *  and cleans up stale subscriptions. Returns the count of desired subscriptions. */
export async function subscribeForStreamer(
  sessionId: string, data: StreamerEventSubData,
): Promise<number> {
  const { uid, token, name, config, streamerId } = data;
  streamerMap.set(uid, { login: name, streamerId, config });
  const desired = await createSubscriptionsForStreamer(sessionId, uid, token, config, name);
  await deleteStaleSubscriptions(uid, desired, token);
  return desired.size;
}

/** Removes a streamer from the in-memory map (called when their connection is stopped). */
export function removeStreamerFromMap(uid: string): void {
  streamerMap.delete(uid);
}

async function subscribe(sessionId: string, spec: SubSpec, token: string, login: string): Promise<void> {
  const skipKey = `${login}:${spec.type}:${token}`;
  if (authFailedSubs.has(skipKey)) return;
  try {
    const id = await createEventSubSubscription(spec.type, spec.version, spec.condition, sessionId, token);
    if (id !== null) {
      authFailedSubs.delete(skipKey);
      log.info(`Subscribed to ${spec.type} for ${login}`);
    }
  } catch (err) {
    if (err instanceof TwitchAuthError) {
      authFailedSubs.add(skipKey);
      log.warn(`Skipping ${spec.type} for ${login} — authorization missing, user must reconnect Twitch`);
    } else {
      log.error(`Failed to subscribe to ${spec.type} for ${login}:`, err);
    }
  }
}


/** Routes an EventSub notification to the appropriate handler based on subscription type. */
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

/** Handles a subscription revocation message, clearing the broadcaster's token if authorisation was revoked. */
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
