import { createLogger } from './logger';
import { subscribeAll, dispatchNotification, handleRevocation } from './twitchEventSubSubscriptions';

const log = createLogger('EventSub');

const EVENTSUB_WS_URL = 'wss://eventsub.wss.twitch.tv/ws';
const RECONNECT_BACKOFF_MAX_MS = 30_000;

interface EventSubMessage {
  metadata: { message_type: string };
  payload: {
    session?: { id: string; keepalive_timeout_seconds: number; reconnect_url?: string | null };
    subscription?: { type: string; status: string; condition: Record<string, string> };
    event?: Record<string, unknown>;
  };
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

function sanitizeReconnectUrl(reconnectUrl: string): string | null {
  try {
    const parsed = new URL(reconnectUrl);
    const validPorts = new Set(['', '443']);
    // Strict allowlist for Twitch EventSub websocket endpoint
    const checks = [
      parsed.protocol === 'wss:',
      parsed.hostname === 'eventsub.wss.twitch.tv',
      !parsed.username,
      !parsed.password,
      validPorts.has(parsed.port),
      parsed.pathname === '/ws',
    ];
    // Return trusted constant to avoid propagating untrusted URL data
    return checks.every(Boolean) ? EVENTSUB_WS_URL : null;
  } catch {
    return null;
  }
}

function handleSessionReconnect(oldSocket: WebSocket, reconnectUrl: string): void {
  const safeReconnectUrl = sanitizeReconnectUrl(reconnectUrl);
  if (!safeReconnectUrl) {
    log.error('Invalid reconnect URL — ignoring');
    return;
  }
  isReconnecting = true;
  log.info(`Session reconnect to ${safeReconnectUrl}`);
  connect(safeReconnectUrl);
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
