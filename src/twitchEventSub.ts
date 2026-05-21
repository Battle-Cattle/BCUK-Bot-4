import { createLogger } from './logger';
import { getAllEventSubStreamers, saveStreamerToken, clearStreamerToken, DbStreamerEventSub, EventSubConfig } from './db/eventSub';
import { getAppToken, refreshUserToken, createEventSubSubscription } from './twitchApi';
import { getActiveChannels } from './twitchBot';
import {
  handleFollow, handleSub, handleResub, handleGiftSub, handleRaid,
  FollowEvent, SubEvent, ResubEvent, GiftSubEvent, RaidEvent,
} from './twitchEventSubHandler';

const log = createLogger('EventSub');

const EVENTSUB_WS_URL = 'wss://eventsub.wss.twitch.tv/ws';
const RECONNECT_BACKOFF_MAX_MS = 30_000;
const BUFFER_MS = 5 * 60 * 1000;

interface EventSubMessage {
  metadata: { message_type: string };
  payload: {
    session?: { id: string; keepalive_timeout_seconds: number; reconnect_url?: string | null };
    subscription?: { type: string; status: string; condition: Record<string, string> };
    event?: Record<string, unknown>;
  };
}

// In-memory lookup keyed by Twitch broadcaster user ID
interface StreamerInfo { login: string; streamerId: number; config: EventSubConfig | null }
const streamerMap = new Map<string, StreamerInfo>();

let ws: WebSocket | null = null;
let sessionId: string | null = null;
let keepaliveTimeoutSecs = 10;
let keepaliveTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;
let stopped = false;
let isReconnecting = false;

// Serialise subscription reloads so concurrent calls don't interleave
let reloadChain: Promise<void> = Promise.resolve();

// ─── Public API ───────────────────────────────────────────────────────────────

export async function startEventSub(): Promise<void> {
  stopped = false;
  await connect();
}

export function stopEventSub(): void {
  stopped = true;
  clearKeepaliveTimer();
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  ws?.close(1000, 'shutdown');
  ws = null;
}

export function reloadEventSubSubscriptions(): void {
  reloadChain = reloadChain
    .then(async () => {
      if (!ws || !sessionId) return;
      await subscribeAll(sessionId);
    })
    .catch((err) => { log.error('EventSub reload error:', err); });
}

// ─── WebSocket connection ─────────────────────────────────────────────────────

function connect(url: string = EVENTSUB_WS_URL): void {
  if (stopped) return;

  const socket = new WebSocket(url);

  socket.addEventListener('open', () => {
    log.info('WebSocket connected');
    reconnectAttempts = 0;
    resetKeepaliveTimer();
  });

  socket.addEventListener('message', (ev: MessageEvent) => {
    try {
      const msg = JSON.parse(ev.data as string) as EventSubMessage;
      handleMessage(socket, msg);
    } catch (err) {
      log.error('Message parse error:', err);
    }
  });

  socket.addEventListener('close', (ev: CloseEvent) => {
    log.warn(`WebSocket closed: ${ev.code} ${ev.reason}`);
    clearKeepaliveTimer();
    if (!stopped && !isReconnecting) scheduleReconnect();
  });

  socket.addEventListener('error', () => {
    log.error('WebSocket error');
  });

  ws = socket;
}

function scheduleReconnect(): void {
  const delay = Math.min(RECONNECT_BACKOFF_MAX_MS, 1_000 * Math.pow(2, reconnectAttempts));
  reconnectAttempts++;
  log.info(`Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function handleMessage(socket: WebSocket, msg: EventSubMessage): void {
  resetKeepaliveTimer();
  const type = msg.metadata.message_type;

  if (type === 'session_welcome') {
    const session = msg.payload.session!;
    sessionId = session.id;
    keepaliveTimeoutSecs = session.keepalive_timeout_seconds;
    resetKeepaliveTimer();

    if (isReconnecting) {
      isReconnecting = false;
      log.info(`Reconnected — session ${sessionId}`);
    } else {
      log.info(`Session established: ${sessionId}`);
      subscribeAll(sessionId).catch((err) => log.error('Subscribe error:', err));
    }
  } else if (type === 'session_reconnect') {
    const reconnectUrl = msg.payload.session?.reconnect_url;
    if (reconnectUrl) handleSessionReconnect(socket, reconnectUrl);
  } else if (type === 'notification') {
    const sub = msg.payload.subscription;
    const event = msg.payload.event;
    if (sub && event) dispatchNotification(sub.type, event, sub.condition);
  } else if (type === 'revocation') {
    const sub = msg.payload.subscription;
    if (sub) handleRevocation(sub);
  }
  // session_keepalive: timer already reset above
}

function handleSessionReconnect(oldSocket: WebSocket, reconnectUrl: string): void {
  // Validate URL is Twitch's EventSub domain before connecting (prevents SSRF)
  let parsed: URL;
  try { parsed = new URL(reconnectUrl); } catch {
    log.error(`Invalid reconnect URL (unparseable) — ignoring`);
    return;
  }
  if (parsed.protocol !== 'wss:' || parsed.hostname !== 'eventsub.wss.twitch.tv') {
    log.error(`Invalid reconnect URL (unexpected host) — ignoring`);
    return;
  }
  isReconnecting = true;
  log.info(`Session reconnect to ${reconnectUrl}`);
  connect(reconnectUrl);
  // Close the old socket after the new one has had time to establish
  setTimeout(() => { oldSocket.close(1000, 'reconnect'); }, 5_000);
}

function resetKeepaliveTimer(): void {
  clearKeepaliveTimer();
  keepaliveTimer = setTimeout(() => {
    log.warn('Keepalive timeout — reconnecting');
    ws?.close(4000, 'keepalive timeout');
  }, (keepaliveTimeoutSecs + 10) * 1_000);
}

function clearKeepaliveTimer(): void {
  if (keepaliveTimer) { clearTimeout(keepaliveTimer); keepaliveTimer = null; }
}

// ─── Subscription management ──────────────────────────────────────────────────

async function subscribeAll(sid: string): Promise<void> {
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
      await subscribe(sid, 'channel.follow', '2',
        { broadcaster_user_id: uid, moderator_user_id: uid }, token, streamer.name);
    }

    if (config?.sub_enabled && token) {
      await subscribe(sid, 'channel.subscribe', '1', { broadcaster_user_id: uid }, token, streamer.name);
      await subscribe(sid, 'channel.subscription.message', '1', { broadcaster_user_id: uid }, token, streamer.name);
      await subscribe(sid, 'channel.subscription.gift', '1', { broadcaster_user_id: uid }, token, streamer.name);
    }

    if (config?.raid_enabled) {
      try {
        const appToken = await getAppToken();
        await subscribe(sid, 'channel.raid', '1', { to_broadcaster_user_id: uid }, appToken, streamer.name);
      } catch (err) {
        log.error(`Failed to get app token for raid sub (${streamer.name}):`, err);
      }
    }
  }
}

async function subscribe(
  sessionId: string,
  type: string,
  version: string,
  condition: Record<string, string>,
  token: string,
  login: string,
): Promise<void> {
  try {
    const id = await createEventSubSubscription(type, version, condition, sessionId, token);
    if (id !== null) log.info(`Subscribed to ${type} for ${login}`);
  } catch (err) {
    log.error(`Failed to subscribe to ${type} for ${login}:`, err);
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

// ─── Notification dispatch ────────────────────────────────────────────────────

function dispatchNotification(type: string, event: Record<string, unknown>, condition: Record<string, string>): void {
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

function handleRevocation(sub: { type: string; status: string; condition: Record<string, string> }): void {
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
