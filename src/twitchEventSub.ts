import { createLogger } from './logger';
import { subscribeAll, dispatchNotification, handleRevocation } from './twitchEventSubSubscriptions';

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

// TTL-based dedup: messageId → expiry timestamp
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

export function startEventSub(): void {
  stopped = false;
  connect();
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
      handleMessage(msg);
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

function handleMessage(msg: EventSubMessage): void {
  const { message_type, message_id, message_timestamp } = msg.metadata;

  if (isStale(message_timestamp)) {
    log.warn(`Stale message (${message_type}) — ignoring`);
    return;
  }
  if (isDuplicate(message_id)) {
    log.warn(`Duplicate message (${message_type}) — ignoring`);
    return;
  }

  resetKeepaliveTimer();

  if (message_type === 'session_welcome') {
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
  } else if (message_type === 'session_reconnect') {
    const reconnectUrl = msg.payload.session?.reconnect_url;
    if (reconnectUrl) handleSessionReconnect(reconnectUrl);
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

/** Validates the Twitch-supplied reconnect URL and returns a safe version.
 *  Only the query string (which contains the session_id for sub migration) is
 *  taken from the external input; the protocol/host/path come from our constant,
 *  so the connection cannot be redirected to an arbitrary server. */
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
  return reconnectUrl;
}

function handleSessionReconnect(reconnectUrl: string): void {
  const safeUrl = buildReconnectUrl(reconnectUrl);
  if (!safeUrl) {
    log.error('Invalid reconnect URL — ignoring');
    return;
  }
  const oldSocket = ws;
  isReconnecting = true;
  log.info('Session reconnect — connecting to new session');
  connect(safeUrl);
  // Close the old socket after the new one has time to establish
  setTimeout(() => { oldSocket?.close(1000, 'reconnect'); }, 5_000);
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
