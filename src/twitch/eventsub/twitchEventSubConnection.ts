import { createLogger } from '../../shared/logger';
import { subscribeForStreamer, removeStreamerFromMap, dispatchNotification, handleRevocation, StreamerEventSubData } from './twitchEventSubSubscriptions';

const log = createLogger('EventSub');

/** Default Twitch EventSub WebSocket URL. */
export const EVENTSUB_WS_URL = 'wss://eventsub.wss.twitch.tv/ws';
const RECONNECT_BACKOFF_MAX_MS = 30_000;
/** Upper bound on how long a WebSocket may sit in CONNECTING before this connection gives up on
 *  it and force-reconnects — see {@link StreamerConnection.connect}. Without this, a socket whose
 *  underlying TCP handshake hangs (e.g. a connection silently dropped by a firewall/NAT) would
 *  never fire 'open', 'error', or 'close', leaving this connection stuck with no live
 *  subscription and nothing in the logs to explain why — unlike every other failure path here
 *  (keepalive timeout, socket error, socket close), which already force-reconnects. */
const CONNECT_TIMEOUT_MS = 30_000;
/** How long a message ID is remembered for deduplication (ms). */
export const MESSAGE_TTL_MS = 10 * 60 * 1000;
/** Grace period before closing the old WebSocket during a session migration (Twitch-specified window). */
const SESSION_MIGRATION_CLOSE_DELAY_MS = 5_000;

/** Metadata fields present on every EventSub WebSocket message. */
export interface EventSubMetadata {
  message_type: string;
  message_id: string;
  message_timestamp: string;
}

/** A single EventSub WebSocket message. */
export interface EventSubMessage {
  metadata: EventSubMetadata;
  payload: {
    session?: { id: string; keepalive_timeout_seconds: number; reconnect_url?: string | null };
    subscription?: { type: string; status: string; condition: Record<string, string> };
    event?: Record<string, unknown>;
  };
}

/** Validates the Twitch-supplied reconnect URL against a strict allowlist. */
export function buildReconnectUrl(reconnectUrl: string): string | null {
  let parsed: URL;
  try { parsed = new URL(reconnectUrl); } catch { return null; }
  const validPorts = new Set(['', '443']);
  const checkResults = {
    protocol: parsed.protocol === 'wss:',
    hostname: parsed.hostname === 'eventsub.wss.twitch.tv' || parsed.hostname.endsWith('.eventsub.wss.twitch.tv'),
    username: !parsed.username,
    password: !parsed.password,
    port: validPorts.has(parsed.port),
    pathname: parsed.pathname.replace(/\/$/, '') === '/ws',
  };
  const failed = Object.entries(checkResults).filter(([, v]) => !v).map(([k]) => k);
  if (failed.length > 0) {
    log.error(`Invalid reconnect URL — failed checks: ${failed.join(', ')} — url: ${reconnectUrl}`);
    return null;
  }
  // Reconstruct from validated components so taint analysis sees a clean value
  const safe = new URL(`wss://${parsed.hostname}/ws`);
  safe.search = parsed.search;
  return safe.href;
}

/** Manages a per-streamer EventSub WebSocket connection with reconnection and keepalive logic. */
export class StreamerConnection {
  readonly uid: string;
  private readonly name: string;
  private currentData: StreamerEventSubData;
  private onSelfStop: ((uid: string) => void) | null = null;

  private ws: WebSocket | null = null;
  private sessionId: string | null = null;
  private keepaliveTimeoutSecs = 10;
  private keepaliveTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private isReconnecting = false;
  // Set when reload() runs while isReconnecting is true — at that point this.sessionId is
  // still the OLD session's id (the new session's welcome hasn't arrived yet), so subscribing
  // now would hit a doomed session. Consumed once onSessionWelcome() lands the new session id.
  private reloadPendingAfterMigration = false;
  private stopped = false;
  private reloadChain: Promise<void> = Promise.resolve();

  constructor(data: StreamerEventSubData) {
    this.uid = data.uid;
    this.name = data.name;
    this.currentData = data;
  }

  /** Register a callback invoked when this connection stops itself due to zero subscriptions. */
  setSelfStopCallback(cb: (uid: string) => void): void {
    this.onSelfStop = cb;
  }

  /** Opens the WebSocket connection for this streamer. */
  start(): void {
    this.stopped = false;
    this.connect();
  }

  /** Closes the connection and removes this streamer from the subscription map. */
  stop(): void {
    this.stopped = true;
    this.isReconnecting = false;
    this.reloadPendingAfterMigration = false;
    this.sessionId = null;
    this.clearKeepaliveTimer();
    this.clearConnectTimer();
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.ws?.close(1000, 'shutdown');
    this.ws = null;
    removeStreamerFromMap(this.uid);
  }

  /** Updates streamer data and re-subscribes on the live session (serialised via reloadChain). */
  reload(newData: StreamerEventSubData): void {
    this.currentData = newData;
    this.reloadChain = this.reloadChain
      .then(() => this.doReload())
      .catch((err) => { log.error(`[${this.name}] EventSub reload error:`, err); });
  }

  /**
   * Re-subscribes on the live session using the latest streamer data. If a session migration
   * is in flight, this.sessionId still refers to the old, soon-to-be-invalidated session —
   * subscribing now would silently fail against Twitch, so the reload is deferred and picked
   * up by onSessionWelcome() once the new session's id is known.
   *
   * Likewise, if `this.ws` is already set but `this.sessionId` is still null, a connect() is
   * already in flight — its `session_welcome` just hasn't arrived yet. Calling connect() again
   * here would open a *second* live WebSocket alongside the first (connect() never closes the
   * socket it replaces), and both would end up subscribing independently, each treating the
   * other's fresh subscription as "stale" and deleting it — observed in production as every
   * subscription type being deleted and recreated within seconds of startup, with a real gap
   * where nothing was subscribed. Reload only needs to fall through and do nothing: the pending
   * connect's own onSessionWelcome() will subscribe once it lands, using this.currentData —
   * already updated by reload() above — so nothing is lost by waiting for it instead of racing
   * a second connection. A reconnect is only actually needed when there's no socket at all.
   */
  private async doReload(): Promise<void> {
    if (this.isReconnecting) {
      this.reloadPendingAfterMigration = true;
      return;
    }
    if (!this.ws) {
      if (!this.stopped && !this.reconnectTimer) { this.connect(); }
      return;
    }
    if (!this.sessionId) {
      return;
    }
    await this.subscribeAndHandleEmpty(this.sessionId, 'No subscriptions after reload — disconnecting');
  }

  /**
   * Subscribes for the current streamer data on the given session id and stops the
   * connection (notifying onSelfStop) if zero subscriptions result. Shared by doReload()
   * and the deferred reload applied after a session migration completes. No-ops (both
   * before and after the subscribe call) if the connection was stopped while this was
   * in flight — e.g. `stop()` called from `twitchEventSub.ts` on shutdown or when a
   * streamer is removed — so a zombie API call can't resurrect an already-closed
   * connection or double-fire `onSelfStop`.
   */
  private async subscribeAndHandleEmpty(sessionId: string, emptyLogMessage: string): Promise<void> {
    if (this.stopped) return;
    const count = await subscribeForStreamer(sessionId, this.currentData);
    if (this.stopped) return;
    if (count === 0) {
      log.info(`[${this.name}] ${emptyLogMessage}`);
      this.stop();
      this.onSelfStop?.(this.uid);
    }
  }

  /**
   * Opens a new WebSocket to the given URL (defaults to the standard EventSub URL). Bounded by
   * {@link CONNECT_TIMEOUT_MS} — see its doc for why a socket stuck in CONNECTING would otherwise
   * never trigger a reconnect on its own.
   */
  connect(url: string = EVENTSUB_WS_URL): void {
    if (this.stopped) return;
    const socket = new WebSocket(url);
    socket.addEventListener('open', () => this.onOpen(socket));
    socket.addEventListener('message', (ev: MessageEvent) => this.onMessage(ev));
    socket.addEventListener('close', (ev: CloseEvent) => this.onClose(ev, socket));
    socket.addEventListener('error', () => this.onError(socket));
    this.ws = socket;
    this.clearConnectTimer();
    this.connectTimer = setTimeout(() => {
      log.warn(`[${this.name}] Connect timeout — reconnecting`);
      this.forceReconnect(socket);
    }, CONNECT_TIMEOUT_MS);
  }

  /** Clears the pending connect-timeout timer (see {@link CONNECT_TIMEOUT_MS}), if one is armed. */
  private clearConnectTimer(): void {
    if (this.connectTimer) { clearTimeout(this.connectTimer); this.connectTimer = null; }
  }

  /**
   * Handles the socket's `'open'` event: ignores it if `socket` is no longer this connection's
   * active socket (a stale, late-arriving event from a socket already superseded by a
   * force-reconnect — the same staleness this file already guards against in {@link onClose},
   * {@link onError}, and {@link forceReconnect} itself). Without this guard, a delayed `open`
   * from an old socket would incorrectly clear the *current* socket's connect timer and reset
   * {@link reconnectAttempts}/the keepalive timer for a connection that may not have opened yet.
   * @param socket - The socket that emitted the event.
   */
  private onOpen(socket: WebSocket): void {
    if (this.ws !== socket) return;
    log.info(`[${this.name}] WebSocket connected`);
    this.clearConnectTimer();
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

  /**
   * Handles the socket's `'close'` event: ignores it if `socket` is no longer this connection's
   * active socket (a stale event from a socket already superseded by a force-reconnect or
   * session migration), otherwise tears it down and schedules a reconnect via {@link forceReconnect}.
   * @param ev - The close event, used only for logging the code/reason.
   * @param socket - The socket that emitted the event.
   */
  private onClose(ev: CloseEvent, socket: WebSocket): void {
    if (this.ws !== socket) return; // old socket closed during session migration, or already force-reconnected — ignore
    log.warn(`[${this.name}] WebSocket closed: ${ev.code} ${ev.reason}`);
    this.forceReconnect(socket);
  }

  /**
   * Handles the socket's `'error'` event: logs it and immediately force-reconnects, without
   * waiting for a `'close'` event that a dead-but-not-yet-torn-down socket may never actually
   * emit (observed in production: an `error` with no following `close`, leaving the connection
   * silently stuck until the keepalive-timeout backstop eventually caught it minutes later).
   * @param socket - The socket that emitted the event.
   * @returns Nothing.
   */
  private onError(socket: WebSocket): void {
    if (this.ws !== socket) return;
    log.warn(`[${this.name}] WebSocket error`);
    this.forceReconnect(socket);
  }

  /**
   * Tears down `socket` as this connection's active WebSocket and schedules a reconnect,
   * without depending on the socket ever emitting its own `'close'` event. Shared by
   * {@link onClose} (a real close event did arrive), {@link onError} (a socket error arrived
   * but its `'close'` may never follow), the keepalive-timeout path in
   * {@link resetKeepaliveTimer} (a close was requested but might never actually fire — a
   * half-dead TCP connection, e.g. after a silent NAT/load-balancer drop, can leave `close()`
   * pending forever with no `'close'` event ever following it, which would otherwise strand
   * this connection permanently until the whole process restarts), and the connect-timeout path
   * in {@link connect} (the socket never left CONNECTING at all, so none of 'open'/'error'/
   * 'close' ever fired to begin with). No-ops if `socket` isn't
   * this connection's current socket any more (e.g. a session migration or an earlier
   * force-reconnect already superseded it) — including the case where `socket`'s real
   * `'close'` event does eventually land after this already ran.
   * @param socket - The socket to tear down, or `null` (always a no-op in that case).
   * @returns Nothing.
   */
  private forceReconnect(socket: WebSocket | null): void {
    if (this.ws !== socket) return;
    // Best-effort: request a close (harmless if already closing/closed) so Twitch has a
    // better chance of revoking this session's EventSub subscriptions promptly, rather than
    // leaving them "enabled" until Twitch's own delayed dead-connection detection catches up.
    // We don't wait on it — the next connect() proceeds immediately regardless.
    socket?.close();
    this.clearKeepaliveTimer();
    this.clearConnectTimer();
    this.ws = null;
    this.sessionId = null;
    if (!this.stopped) {
      // If this socket died mid-migration before its welcome landed, drop any reload that
      // was deferred for it — the eventual reconnect's own session_welcome will subscribe
      // with the latest currentData anyway (see onSessionWelcome's non-reconnecting branch).
      this.isReconnecting = false;
      this.reloadPendingAfterMigration = false;
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

  /**
   * Handles the session_welcome message: records the new session id and, on first connect,
   * subscribes for the current streamer data. On a reconnect (session migration), existing
   * subscriptions carry over automatically — but if a reload() was deferred because it ran
   * while the old session id was still stale, it's applied now against the new session id.
   */
  private onSessionWelcome(msg: EventSubMessage): void {
    const session = msg.payload.session!;
    this.sessionId = session.id;
    this.keepaliveTimeoutSecs = session.keepalive_timeout_seconds;
    this.resetKeepaliveTimer();
    if (this.isReconnecting) {
      this.isReconnecting = false;
      log.info(`[${this.name}] Reconnected — session ${this.sessionId}`);
      if (this.reloadPendingAfterMigration) {
        this.reloadPendingAfterMigration = false;
        log.info(`[${this.name}] Applying reload deferred during session migration`);
        this.reloadChain = this.reloadChain
          .then(() => this.subscribeAndHandleEmpty(session.id, 'No subscriptions after reload — disconnecting'))
          .catch((err) => { log.error(`[${this.name}] Deferred reload error:`, err); });
      }
      return;
    }
    log.info(`[${this.name}] Session established: ${this.sessionId}`);
    this.reloadChain = this.reloadChain
      .then(() => this.subscribeAndHandleEmpty(session.id, 'No subscriptions — disconnecting'))
      .catch((err) => { log.error(`[${this.name}] Subscribe error:`, err); });
  }

  private handleSessionReconnect(reconnectUrl: string): void {
    const safeUrl = buildReconnectUrl(reconnectUrl);
    if (!safeUrl) { log.error(`[${this.name}] Invalid reconnect URL — reconnecting`); this.scheduleReconnect(); return; }
    const oldSocket = this.ws;
    this.isReconnecting = true;
    log.info(`[${this.name}] Session reconnect — connecting to new session`);
    this.connect(safeUrl);
    setTimeout(() => { oldSocket?.close(1000, 'reconnect'); }, SESSION_MIGRATION_CLOSE_DELAY_MS);
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); }
    const delay = Math.min(RECONNECT_BACKOFF_MAX_MS, 1_000 * Math.pow(2, this.reconnectAttempts));
    this.reconnectAttempts++;
    log.info(`[${this.name}] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect(); }, delay);
  }

  private clearKeepaliveTimer(): void {
    if (this.keepaliveTimer) { clearTimeout(this.keepaliveTimer); this.keepaliveTimer = null; }
  }

  /**
   * (Re)starts the keepalive watchdog: clears any existing timer and arms a new one that, if no
   * message (including `session_keepalive`) arrives before it fires, force-reconnects immediately
   * rather than waiting on the socket's own `'close'` event — see {@link forceReconnect}.
   */
  private resetKeepaliveTimer(): void {
    this.clearKeepaliveTimer();
    this.keepaliveTimer = setTimeout(() => {
      log.warn(`[${this.name}] Keepalive timeout — reconnecting`);
      const socket = this.ws;
      // Best-effort: ask the socket to close, but don't wait on its 'close' event — see
      // forceReconnect's doc comment for why that event can never arrive.
      socket?.close(4000, 'keepalive timeout');
      this.forceReconnect(socket);
    }, (this.keepaliveTimeoutSecs + 10) * 1_000);
  }
}

// TTL-based dedup: messageId → expiry timestamp (shared across all per-streamer connections)
export const seenMessageIds = new Map<string, number>();

/** Removes all expired entries from the deduplication map. */
export function purgeExpiredMessageIds(): void {
  const now = Date.now();
  for (const [id, expiry] of seenMessageIds) {
    if (expiry < now) seenMessageIds.delete(id);
  }
}

// Purge expired entries on a fixed interval so isDuplicate stays O(1).
setInterval(purgeExpiredMessageIds, MESSAGE_TTL_MS).unref();

/** Returns true if messageId has been seen within MESSAGE_TTL_MS; records it otherwise. */
export function isDuplicate(messageId: string): boolean {
  const now = Date.now();
  const expiry = seenMessageIds.get(messageId);
  if (expiry !== undefined && now <= expiry) return true;
  seenMessageIds.set(messageId, now + MESSAGE_TTL_MS);
  return false;
}

/** Returns true if the ISO timestamp is older than MESSAGE_TTL_MS or unparseable. */
export function isStale(timestamp: string): boolean {
  const ts = Date.parse(timestamp);
  return !Number.isFinite(ts) || Date.now() - ts > MESSAGE_TTL_MS;
}
