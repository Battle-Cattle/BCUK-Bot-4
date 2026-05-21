import { createLogger } from './logger';
import { getAllEventSubStreamers, saveStreamerToken, clearStreamerToken, DbStreamerEventSub, EventSubConfig } from './db/eventSub';
import { getAppToken, refreshUserToken, createEventSubSubscription } from './twitchApi';
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
export const streamerMap = new Map<string, StreamerInfo>();

export async function subscribeAll(sid: string): Promise<void> {
  const streamers = await getAllEventSubStreamers();
  streamerMap.clear();

  for (const streamer of streamers) {
    if (!streamer.twitch_user_id) continue;

    const token = await maybeRefreshToken(streamer);

    streamerMap.set(streamer.twitch_user_id, {
      login: streamer.name,
      streamerId: streamer.id,
      config: streamer.config,
    });

    const uid = streamer.twitch_user_id;
    const config = streamer.config;

    if (config?.follow_enabled && token) {
      await subscribe(sid, { type: 'channel.follow', version: '2',
        condition: { broadcaster_user_id: uid, moderator_user_id: uid } }, token, streamer.name);
    }

    if (config?.sub_enabled && token) {
      await subscribe(sid, { type: 'channel.subscribe', version: '1', condition: { broadcaster_user_id: uid } }, token, streamer.name);
      await subscribe(sid, { type: 'channel.subscription.message', version: '1', condition: { broadcaster_user_id: uid } }, token, streamer.name);
      await subscribe(sid, { type: 'channel.subscription.gift', version: '1', condition: { broadcaster_user_id: uid } }, token, streamer.name);
    }

    if (config?.raid_enabled) {
      try {
        const appToken = await getAppToken();
        await subscribe(sid, { type: 'channel.raid', version: '1', condition: { to_broadcaster_user_id: uid } }, appToken, streamer.name);
      } catch (err) {
        log.error(`Failed to get app token for raid sub (${streamer.name}):`, err);
      }
    }
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
    await clearStreamerToken(streamer.id);
    log.error(`Token refresh failed for ${streamer.name} — re-authorization required:`, err);
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
