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

export async function subscribeAll(sid: string): Promise<void> {
  const streamers = await getAllEventSubStreamers();
  streamerMap.clear();

  for (const streamer of streamers) {
    const token = await maybeRefreshToken(streamer);
    const config = streamer.config;

    // Resolve the broadcaster ID — stored after OAuth, or fetched via app token for raid-only streamers
    let uid = streamer.twitch_user_id;
    if (!uid && config?.raid_enabled) {
      try {
        const users = await getUsers([streamer.name]);
        uid = users[0]?.id ?? null;
      } catch (err) {
        log.error(`Failed to resolve Twitch user ID for ${streamer.name}:`, err);
      }
    }

    if (!uid) continue;

    streamerMap.set(uid, {
      login: streamer.name,
      streamerId: streamer.id,
      config,
    });

    // Track which types we want active so we can delete stale ones afterwards
    const desired = new Set<string>();

    if (config?.follow_enabled && token) {
      desired.add('channel.follow');
      await subscribe(sid, { type: 'channel.follow', version: '2',
        condition: { broadcaster_user_id: uid, moderator_user_id: uid } }, token, streamer.name);
    }

    if (config?.sub_enabled && token) {
      desired.add('channel.subscribe');
      desired.add('channel.subscription.message');
      desired.add('channel.subscription.gift');
      await subscribe(sid, { type: 'channel.subscribe', version: '1', condition: { broadcaster_user_id: uid } }, token, streamer.name);
      await subscribe(sid, { type: 'channel.subscription.message', version: '1', condition: { broadcaster_user_id: uid } }, token, streamer.name);
      await subscribe(sid, { type: 'channel.subscription.gift', version: '1', condition: { broadcaster_user_id: uid } }, token, streamer.name);
    }

    if (config?.raid_enabled) {
      desired.add('channel.raid');
      try {
        const appToken = await getAppToken();
        await subscribe(sid, { type: 'channel.raid', version: '1', condition: { to_broadcaster_user_id: uid } }, appToken, streamer.name);
      } catch (err) {
        log.error(`Failed to get app token for raid sub (${streamer.name}):`, err);
      }
    }

    // Delete subscriptions that are no longer desired — done after creation so
    // there is no window where zero subscriptions are active
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

  const { login, config } = info;

  switch (type) {
    case 'channel.follow':
      handleFollow(login, event as unknown as FollowEvent, config)
        .catch((err) => log.error('Follow handler error:', err));
      break;
    case 'channel.subscribe':
      handleSub(login, event as unknown as SubEvent, config)
        .catch((err) => log.error('Sub handler error:', err));
      break;
    case 'channel.subscription.message':
      handleResub(login, event as unknown as ResubEvent, config)
        .catch((err) => log.error('Resub handler error:', err));
      break;
    case 'channel.subscription.gift':
      handleGiftSub(login, event as unknown as GiftSubEvent, config)
        .catch((err) => log.error('GiftSub handler error:', err));
      break;
    case 'channel.raid':
      handleRaid(login, event as unknown as RaidEvent, config)
        .catch((err) => log.error('Raid handler error:', err));
      break;
  }
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
