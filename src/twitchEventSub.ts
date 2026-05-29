import { createLogger } from './logger';
import { loadStreamersForEventSub, subscribeForStreamer, removeStreamerFromMap, dispatchNotification, handleRevocation, StreamerEventSubData } from './twitchEventSubSubscriptions';

const log = createLogger('EventSub');

const EVENTSUB_WS_URL = 'wss://eventsub.wss.twitch.tv/ws';
const RECONNECT_BACKOFF_MAX_MS = 30_000;
const MESSAGE_TTL_MS = 10 * 60 * 1000;

interface EventSubMetadata {
  message_type: string;
  message_id: string;
  message_timestamp: string;
}

interface EventSubMessage {
  metadata: EventSubMetadata;
  payload: {
    session?: { id: string; keepalive_timeout_seconds: number; reconnect_url?: string | null };
    subscription?: { type: string; status: string; condition: Record<string, string> };
    event?: Record<string, unknown>;
  };
}

// TTL-based dedup: messageId → expiry timestamp (shared across all per-streamer connections)
const seenMessageIds = new Map<string, number>();

function isDuplicate(messageId: string): boolean {
  const now = Date.now();
  for (const [id, expiry] of seenMessageIds) {
    if (now > expiry) seenMessageIds.delete(id);
  }
  if (seenMessageIds.has(messageId)) return true;
  seenMessageIds.set(messageId, now + MESSAGE_TTL_MS);
  return false;
}

function isStale(timestamp: string): boolean {
  const ts = Date.parse(timestamp);
  return !Number.isFinite(ts) || Date.now() - ts > MESSAGE_TTL_MS;
}

/** Validates the Twitch-supplied reconnect URL against a strict allowlist. */
function buildReconnectUrl(reconnectUrl: string): string | null {
  let parsed: URL;
  try { parsed = new URL(reconnectUrl); } catch { return null; }
  const validPorts = new Set(['', '443']);
  const checks = [
    parsed.protocol === 'wss:',
    parsed.hostname === 'eventsub.wss.twitch.tv',
    !parsed.username,
    !parsed.password,
    validPorts.has(parsed.port),
    parsed.pathname === '/ws',
  ];
  if (!checks.every(Boolean)) return null;
  // Reconstruct from validated components so taint analysis sees a clean value
  const safe = new URL('wss://eventsub.wss.twitch.tv/ws');
  safe.search = parsed.search;
  return safe.href;
}

// ─── Per-streamer connection ──────────────────────────────────────────────────

class StreamerConnection {
  readonly uid: string;
  private readonly name: string;
  private currentData: StreamerEventSubData;

  private ws: WebSocket | null = null;
  private sessionId: string | null = null;
  private keepaliveTimeoutSecs = 10;
  private keepaliveTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private isReconnecting = false;
  private stopped = false;
  private reloadChain: Promise<void> = Promise.resolve();

  constructor(data: StreamerEventSubData) {
    this.uid = data.uid;
    this.name = data.name;
    this.currentData = data;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.isReconnecting = false;
    this.sessionId = null;
    this.clearKeepaliveTimer();
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.ws?.close(1000, 'shutdown');
    this.ws = null;
    removeStreamerFromMap(this.uid);
  }

  reload(newData: StreamerEventSubData): void {
    this.currentData = newData;
    this.reloadChain = this.reloadChain
      .then(() => this.doReload())
      .catch((err) => { log.error(`[${this.name}] EventSub reload error:`, err); });
  }

  private async doReload(): Promise<void> {
    if (!this.ws || !this.sessionId) {
      if (!this.stopped) { this.stopped = false; this.connect(); }
      return;
    }
    const count = await subscribeForStreamer(this.sessionId, this.currentData);
    if (count === 0) {
      log.info(`[${this.name}] No subscriptions after reload — disconnecting`);
      this.stop();
    }
  }

  private connect(url: string = EVENTSUB_WS_URL): void {
    if (this.stopped) return;
    const socket = new WebSocket(url);
    socket.addEventListener('open', () => this.onOpen());
    socket.addEventListener('message', (ev: MessageEvent) => this.onMessage(ev));
    socket.addEventListener('close', (ev: CloseEvent) => this.onClose(ev, socket));
    socket.addEventListener('error', () => { log.error(`[${this.name}] WebSocket error`); });
    this.ws = socket;
  }

  private onOpen(): void {
    log.info(`[${this.name}] WebSocket connected`);
    this.reconnectAttempts = 0;
    this.resetKeepaliveTimer();
  }

  private onMessage(ev: MessageEvent): void {
    try {
      const msg = JSON.parse(ev.data as string) as EventSubMessage;
      this.handleMessage(msg);
    } catch (err) {
      log.error(`[${this.name}] Message parse error:`, err);
    }
  }

  private onClose(ev: CloseEvent, socket: WebSocket): void {
    if (this.ws !== socket) return; // old socket closed during session migration — ignore
    log.warn(`[${this.name}] WebSocket closed: ${ev.code} ${ev.reason}`);
    this.clearKeepaliveTimer();
    if (!this.stopped) {
      this.isReconnecting = false;
      this.scheduleReconnect();
    }
  }

  private handleMessage(msg: EventSubMessage): void {
    const { message_type, message_id, message_timestamp } = msg.metadata;
    if (isStale(message_timestamp)) { log.warn(`[${this.name}] Stale message (${message_type}) — ignoring`); return; }
    if (isDuplicate(message_id)) { log.warn(`[${this.name}] Duplicate message (${message_type}) — ignoring`); return; }
    this.resetKeepaliveTimer();

    if (message_type === 'session_welcome') {
      this.onSessionWelcome(msg);
    } else if (message_type === 'session_reconnect') {
      const reconnectUrl = msg.payload.session?.reconnect_url;
      if (reconnectUrl) this.handleSessionReconnect(reconnectUrl);
    } else if (message_type === 'notification') {
      const sub = msg.payload.subscription;
      const event = msg.payload.event;
      if (sub && event) dispatchNotification(sub.type, event, sub.condition);
    } else if (message_type === 'revocation') {
      const sub = msg.payload.subscription;
      if (sub) handleRevocation(sub);
    }
    // session_keepalive: timer already reset above
  }

  private onSessionWelcome(msg: EventSubMessage): void {
    const session = msg.payload.session!;
    this.sessionId = session.id;
    this.keepaliveTimeoutSecs = session.keepalive_timeout_seconds;
    this.resetKeepaliveTimer();
    if (this.isReconnecting) {
      this.isReconnecting = false;
      log.info(`[${this.name}] Reconnected — session ${this.sessionId}`);
      return;
    }
    log.info(`[${this.name}] Session established: ${this.sessionId}`);
    subscribeForStreamer(this.sessionId, this.currentData)
      .then((count) => { if (count === 0) { log.info(`[${this.name}] No subscriptions — disconnecting`); this.stop(); } })
      .catch((err) => log.error(`[${this.name}] Subscribe error:`, err));
  }

  private handleSessionReconnect(reconnectUrl: string): void {
    const safeUrl = buildReconnectUrl(reconnectUrl);
    if (!safeUrl) { log.error(`[${this.name}] Invalid reconnect URL — ignoring`); return; }
    const oldSocket = this.ws;
    this.isReconnecting = true;
    log.info(`[${this.name}] Session reconnect — connecting to new session`);
    this.connect(safeUrl);
    setTimeout(() => { oldSocket?.close(1000, 'reconnect'); }, 5_000);
  }

  private scheduleReconnect(): void {
    const delay = Math.min(RECONNECT_BACKOFF_MAX_MS, 1_000 * Math.pow(2, this.reconnectAttempts));
    this.reconnectAttempts++;
    log.info(`[${this.name}] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect(); }, delay);
  }

  private clearKeepaliveTimer(): void {
    if (this.keepaliveTimer) { clearTimeout(this.keepaliveTimer); this.keepaliveTimer = null; }
  }

  private resetKeepaliveTimer(): void {
    this.clearKeepaliveTimer();
    this.keepaliveTimer = setTimeout(() => {
      log.warn(`[${this.name}] Keepalive timeout — reconnecting`);
      this.ws?.close(4000, 'keepalive timeout');
    }, (this.keepaliveTimeoutSecs + 10) * 1_000);
  }
}

// ─── Global connection map ────────────────────────────────────────────────────

const connections = new Map<string, StreamerConnection>();
let globalStopped = false;

// Serialise top-level reloads
let topReloadChain: Promise<void> = Promise.resolve();

// ─── Public API ───────────────────────────────────────────────────────────────

export function startEventSub(): void {
  globalStopped = false;
  topReloadChain = topReloadChain
    .then(async () => {
      const streamers = await loadStreamersForEventSub();
      for (const data of streamers) {
        if (!connections.has(data.uid)) {
          const conn = new StreamerConnection(data);
          connections.set(data.uid, conn);
          conn.start();
        }
      }
    })
    .catch((err) => { log.error('EventSub start error:', err); });
}

export function stopEventSub(): void {
  globalStopped = true;
  for (const conn of connections.values()) conn.stop();
  connections.clear();
}

export function reloadEventSubSubscriptions(): void {
  if (globalStopped) return;
  topReloadChain = topReloadChain
    .then(async () => {
      const streamers = await loadStreamersForEventSub();
      const newUids = new Set(streamers.map((s) => s.uid));

      // Stop and remove connections for streamers no longer present
      for (const [uid, conn] of connections) {
        if (!newUids.has(uid)) { conn.stop(); connections.delete(uid); }
      }

      // Reload existing or start new connections
      for (const data of streamers) {
        const existing = connections.get(data.uid);
        if (existing) {
          existing.reload(data);
        } else {
          const conn = new StreamerConnection(data);
          connections.set(data.uid, conn);
          conn.start();
        }
      }
    })
    .catch((err) => { log.error('EventSub reload error:', err); });
}
