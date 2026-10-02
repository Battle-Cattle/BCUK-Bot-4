import { createLogger } from '../../shared/logger';
import { BackoffRetry } from './backoffRetry';
import { shouldSelfStop, type SubscribeOutcome } from './subscribeOutcome';
import { recordEventSubConnected, recordEventSubReconnectAttempt, removeEventSubHealth } from '../../shared/healthStore';
import { subscribeForStreamer, fetchValidEventSubToken, removeSessionSubscriptions, removeStreamerFromMap, StreamerEventSubData } from './twitchEventSubSubscriptions';
import { buildReconnectUrl, rejectionReason, routeEventSubMessage, type EventSubMessage } from './twitchEventSubMessages';

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
/** Grace period before closing the old WebSocket during a session migration (Twitch-specified window). */
const SESSION_MIGRATION_CLOSE_DELAY_MS = 5_000;
/** Base delay before retrying a subscribe pass whose creates failed transiently (5xx, 429, network,
 *  timeout) — doubled per consecutive failed pass, capped at {@link SUBSCRIBE_RETRY_MAX_MS}. */
const SUBSCRIBE_RETRY_BASE_MS = 5_000;
/** Upper bound on the delay between transient-failure subscribe retries. */
const SUBSCRIBE_RETRY_MAX_MS = 5 * 60_000;
/** Consecutive transient-failure subscribe retries attempted before giving up until the next
 *  reload/fresh session (a socket left with no subscriptions is closed by Twitch after ~10s, so
 *  the backed-off reconnect path keeps re-trying on a fresh session regardless). */
const SUBSCRIBE_RETRY_MAX_ATTEMPTS = 8;

/** One subscribe pass, as queued on a {@link StreamerConnection}'s reload chain. */
interface SubscribePass {
  /** The session the pass subscribes on. */
  sessionId: string;
  /** Logged when zero subscriptions result and the connection self-stops. */
  emptyLogMessage: string;
  /** Re-resolve a valid token before subscribing. */
  refreshToken: boolean;
  /** The connection's fresh-session generation when the pass was queued. */
  generation: number;
}

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
  private migrationCloseTimer: ReturnType<typeof setTimeout> | null = null;
  // The socket handleSessionReconnect's pending migrationCloseTimer will close once it fires.
  // Tracked alongside the timer (rather than only in its setTimeout closure) so a second
  // session_reconnect arriving before the first's delay elapses can close this immediately and
  // replace both, instead of leaving a still-running native timer that migrationCloseTimer no
  // longer references — see handleSessionReconnect.
  private pendingMigrationOldSocket: WebSocket | null = null;
  private reconnectAttempts = 0;
  // Pending retry of a subscribe pass whose creates failed transiently — see scheduleSubscribeRetry.
  private readonly subscribeRetry = new BackoffRetry(SUBSCRIBE_RETRY_BASE_MS, SUBSCRIBE_RETRY_MAX_MS, SUBSCRIBE_RETRY_MAX_ATTEMPTS);
  private isReconnecting = false;
  // Set when reload() runs while isReconnecting is true — at that point this.sessionId is
  // still the OLD session's id (the new session's welcome hasn't arrived yet), so subscribing
  // now would hit a doomed session. Consumed once onSessionWelcome() lands the new session id.
  private reloadPendingAfterMigration = false;
  // Bumped whenever the session is replaced other than by a migration (stop, force-reconnect, a
  // fresh welcome). A subscribe pass overtaken while this is unchanged was overtaken only by
  // migrations, so nothing else will re-subscribe for it — see carryPassOverMigration.
  private freshSessionGeneration = 0;
  private stopped = false;

  /**
   * Reads `stopped` through a call so a check after an `await` isn't treated as still narrowed
   * to `false` by the check before it — `stop()` can run while that `await` is pending.
   * @returns Whether `stop()` has been called since the last `start()`.
   */
  private isStopped(): boolean {
    return this.stopped;
  }
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

  /**
   * Closes the connection and removes this streamer from the subscription map: cancels every
   * pending timer (keepalive, connect, reconnect, subscribe retry, and any in-flight migration close — the socket
   * that timer was waiting to close is closed immediately instead, with a `'shutdown'` reason),
   * then closes the live socket, if any.
   * @returns void.
   */
  stop(): void {
    this.stopped = true;
    this.isReconnecting = false;
    this.reloadPendingAfterMigration = false;
    this.sessionId = null;
    this.freshSessionGeneration++;
    this.clearKeepaliveTimer();
    this.clearConnectTimer();
    this.subscribeRetry.reset();
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.migrationCloseTimer) {
      clearTimeout(this.migrationCloseTimer);
      this.migrationCloseTimer = null;
      this.pendingMigrationOldSocket?.close(1000, 'shutdown');
      this.pendingMigrationOldSocket = null;
    }
    this.ws?.close(1000, 'shutdown');
    this.ws = null;
    removeEventSubHealth(this.name);
    removeStreamerFromMap(this.uid);
  }

  /** Updates streamer data and re-subscribes on the live session (serialised via reloadChain).
   *  Cancels any pending transient-failure subscribe retry, since this reload subscribes afresh. */
  reload(newData: StreamerEventSubData): void {
    this.currentData = newData;
    this.subscribeRetry.reset();
    this.reloadChain = this.reloadChain
      .then(() => this.doReload())
      .catch((err: unknown) => { log.error(`[${this.name}] EventSub reload error:`, err); });
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
    await this.subscribeAndHandleEmpty({
      sessionId: this.sessionId,
      emptyLogMessage: 'No subscriptions after reload — disconnecting',
      refreshToken: false,
      generation: this.freshSessionGeneration,
    });
  }

  /**
   * Queues a subscribe pass on {@link reloadChain} (see {@link subscribeAndHandleEmpty}), recording
   * the current {@link freshSessionGeneration} so the pass can tell, when it runs, whether its
   * session was replaced by a migration or by a fresh connection. Every queued pass re-resolves the
   * token first ({@link refreshToken}): a queued pass can run long after `currentData` was last
   * loaded (a fresh welcome's pass deferred past a migration, a retry, a carried-over pass), and an
   * expired token fails the listing and every create with a 401, which reads as "all auth failures"
   * and self-stops the connection. Only {@link doReload}, which runs with freshly loaded data, skips it.
   * @param sessionId - The session to subscribe on.
   * @param emptyLogMessage - Logged when zero subscriptions result and the connection self-stops.
   * @param errorLabel - Prefix for the error logged if the pass throws.
   */
  private queueSubscribePass(sessionId: string, emptyLogMessage: string, errorLabel: string): void {
    const pass: SubscribePass = { sessionId, emptyLogMessage, refreshToken: true, generation: this.freshSessionGeneration };
    this.reloadChain = this.reloadChain
      .then(() => this.subscribeAndHandleEmpty(pass))
      .catch((err: unknown) => { log.error(`[${this.name}] ${errorLabel}:`, err); });
  }

  /**
   * Subscribes for the current streamer data on the given session id and stops the connection
   * (notifying onSelfStop) only if nothing is desired, or nothing is live and every failure was an
   * auth/scope failure (retrying can't help until the user reconnects Twitch). If any create failed
   * transiently (5xx, 429, network, timeout), the connection is kept and the subscribe step retried
   * with backoff (see {@link scheduleSubscribeRetry}) instead of dropping the streamer until an
   * unrelated reload. Once anything is live, the session is known-good, so the reconnect backoff is
   * reset here (rather than on socket open — see {@link onOpen}). Shared by doReload(), the
   * welcome handler, the deferred reload applied after a session migration, and the retry timer. No-ops if the
   * connection was already stopped, or if the pass no longer owns its session when it starts (a queued pass
   * can run after another migration replaced it; subscribing then would treat the subscriptions carried
   * to the new session as stale and delete them). If it's stopped while the subscribe call is in flight —
   * e.g. `stop()` called from `twitchEventSub.ts` on shutdown or when a streamer is removed —
   * it deletes whatever that call created on the now-closed session (see
   * {@link removeSessionSubscriptions}) and returns without the zero-count handling, so a
   * zombie API call can't leave live subscriptions behind or double-fire `onSelfStop`.
   * Likewise, if `sessionId` is no longer this connection's live session by the time the call
   * resolves (its socket died and was replaced, or a migration landed a new session), the result
   * is ignored: a zero count from a dead session says nothing about the current one, and acting
   * on it would `stop()` a healthy replacement socket. If only migrations replaced it, the pass is
   * re-run on the migrated session instead of being dropped (see {@link carryPassOverMigration}).
   * @param pass - The session to subscribe on, how to report an empty result, whether to re-resolve
   *   the token first (see {@link refreshToken}), and the generation it was queued under.
   * @returns Resolves once subscribing (and any zero-count handling) is done.
   */
  private async subscribeAndHandleEmpty(pass: SubscribePass): Promise<void> {
    if (this.passOvertaken(pass)) return;
    if (pass.refreshToken) {
      await this.refreshToken();
      if (this.passOvertaken(pass)) return;
    }
    const data = this.currentData;
    const outcome = await subscribeForStreamer(pass.sessionId, data);
    if (this.isStopped()) {
      if (outcome.live > 0) await removeSessionSubscriptions(pass.sessionId, data);
      return;
    }
    if (this.passOvertaken(pass)) return;
    this.handleSubscribeOutcome(outcome, pass.emptyLogMessage);
  }

  /**
   * Checks, before a subscribe pass starts and after each of its awaits, whether it should stop:
   * the connection was stopped, or the pass no longer owns its session — the session was replaced,
   * or a migration away from it is in flight (then {@link carryPassOverMigration} decides whether
   * to re-run it).
   * @param pass - The pass being run.
   * @returns True if the pass should stop here.
   */
  private passOvertaken(pass: SubscribePass): boolean {
    if (this.isStopped()) return true;
    if (this.sessionId === pass.sessionId && !this.isReconnecting) return false;
    this.carryPassOverMigration(pass);
    return true;
  }

  /**
   * Handles a subscribe pass that no longer owns its session (any result it got is ignored). If
   * only session migrations happened since it was queued (`pass.generation` unchanged), nothing else
   * will subscribe for it — a migration welcome doesn't, and a retry timer that already fired is
   * spent — so it's re-queued on the live session, or deferred to the migration's welcome if one is
   * in flight. If the session was replaced any other way (stop, force-reconnect, a fresh welcome),
   * that path subscribes afresh itself, so the pass is dropped.
   * @param pass - The pass that lost its session.
   */
  private carryPassOverMigration(pass: SubscribePass): void {
    if (pass.generation !== this.freshSessionGeneration) {
      log.info(`[${this.name}] Session ${pass.sessionId} replaced by a new connection — dropping its subscribe pass`);
      return;
    }
    const liveSessionId = this.sessionId;
    if (this.isReconnecting || !liveSessionId) {
      log.info(`[${this.name}] Session ${pass.sessionId} is migrating — deferring its subscribe pass to the new session`);
      this.reloadPendingAfterMigration = true;
      return;
    }
    log.info(`[${this.name}] Session ${pass.sessionId} was migrated — re-running its subscribe pass on ${liveSessionId}`);
    this.queueSubscribePass(liveSessionId, pass.emptyLogMessage, 'Migrated subscribe pass error');
  }

  /**
   * Acts on a live session's {@link SubscribeOutcome}: self-stops when nothing is desired or
   * nothing is live with no transient failures (all auth/scope); otherwise keeps the connection,
   * resets the reconnect backoff if anything is live, and schedules a retry if any create failed
   * transiently (or clears the retry counter once a pass has none).
   * @param outcome - The subscribe pass's result.
   * @param emptyLogMessage - Logged when the connection self-stops.
   */
  private handleSubscribeOutcome(outcome: SubscribeOutcome, emptyLogMessage: string): void {
    if (shouldSelfStop(outcome)) {
      log.info(`[${this.name}] ${emptyLogMessage}`);
      this.stop();
      this.onSelfStop?.(this.uid);
      return;
    }
    if (outcome.live > 0) this.reconnectAttempts = 0;
    if (outcome.transientFailures > 0) {
      this.scheduleSubscribeRetry(outcome.transientFailures);
    } else {
      this.subscribeRetry.reset();
    }
  }

  /**
   * Schedules a retry of the subscribe step after a pass with transient create failures, with
   * exponential backoff ({@link SUBSCRIBE_RETRY_BASE_MS} doubling, capped at
   * {@link SUBSCRIBE_RETRY_MAX_MS}), giving up after {@link SUBSCRIBE_RETRY_MAX_ATTEMPTS}
   * consecutive failed passes. The retry targets whatever session is live when it fires (so a
   * session migration in between carries it over) and is cancelled by stop(), reload(), a fresh
   * session welcome, or a force-reconnect — each of which subscribes afresh anyway.
   * @param failures - How many creates failed transiently this pass, for logging.
   */
  private scheduleSubscribeRetry(failures: number): void {
    const delay = this.subscribeRetry.schedule(() => { this.runSubscribeRetry(); });
    if (delay === null) {
      log.error(`[${this.name}] ${failures} EventSub subscription(s) still failing after ${this.subscribeRetry.attempts} retries — giving up until the next reload/reconnect`);
      return;
    }
    log.warn(`[${this.name}] ${failures} EventSub subscription(s) failed transiently — retrying in ${delay}ms (attempt ${this.subscribeRetry.attempts})`);
  }

  /** Runs a scheduled subscribe retry (see {@link scheduleSubscribeRetry}) against the live session. */
  private runSubscribeRetry(): void {
    const sessionId = this.sessionId;
    if (this.isStopped() || !sessionId) return;
    // Mid-migration, sessionId is still the old session's — hand the retry to the new session's
    // welcome via the same deferral reload() uses.
    if (this.isReconnecting) { this.reloadPendingAfterMigration = true; return; }
    this.queueSubscribePass(sessionId, 'No subscriptions after retry — disconnecting', 'Subscribe retry error');
  }

  /**
   * Replaces `currentData.token` with a currently-valid token from the DB (refreshing it if
   * expired) via {@link fetchValidEventSubToken}. The token handed over at construction/reload can
   * be hours old by the time a non-migration reconnect re-subscribes, and an expired one would
   * fail every create with a 401. Skipped if a reload() replaced `currentData` meanwhile (that data
   * already carries a freshly-resolved token); on a lookup error or a null result (failed refresh)
   * the existing token is kept.
   * @returns Resolves once the token has been refreshed (or the attempt logged as failed).
   */
  private async refreshToken(): Promise<void> {
    const data = this.currentData;
    try {
      const token = await fetchValidEventSubToken(data.streamerId);
      // A null token means the refresh failed (transiently during a Twitch outage, or because the
      // grant was revoked). Keep the existing token either way: swapping in null would read as
      // "nothing to subscribe" and self-stop, whereas the old token either still works, fails
      // transiently (and is retried), or 401s and is handled as an auth failure.
      if (token === null) {
        log.warn(`[${this.name}] Could not resolve a fresh EventSub token; subscribing with the existing one`);
        return;
      }
      if (this.currentData === data) this.currentData = { ...data, token };
    } catch (err) {
      log.error(`[${this.name}] Failed to refresh EventSub token before subscribing:`, err);
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
   * the keepalive timer for a connection that may not have opened yet. Deliberately does *not*
   * reset {@link reconnectAttempts}: a socket that opens but ends up with no live subscriptions
   * (e.g. a transient Twitch outage failing every create) is closed by Twitch ~10s later, and
   * resetting here would turn that into a tight reconnect/resubscribe loop. The backoff is reset
   * once the session is known-good instead — a migration welcome, or a subscribe pass with
   * something live (see {@link handleSubscribeOutcome}).
   * @param socket - The socket that emitted the event.
   */
  private onOpen(socket: WebSocket): void {
    if (this.ws !== socket) return;
    log.info(`[${this.name}] WebSocket connected`);
    this.clearConnectTimer();
    this.resetKeepaliveTimer();
    recordEventSubConnected(this.name, true);
  }

  /**
   * WebSocket `message` handler: parses the frame and dispatches it, logging (not throwing) on
   * malformed JSON or handler errors.
   * @param ev - The WebSocket message event.
   */
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
    recordEventSubConnected(this.name, false, `Closed: ${ev.code} ${ev.reason}`);
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
    recordEventSubConnected(this.name, false, 'WebSocket error');
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
   * Always records this connection as disconnected in `healthStore` before doing any of the
   * above — most callers here (`onClose`/`onError`) already record it themselves first, but a
   * watchdog-triggered call (the connect-timeout and keepalive-timeout paths) does not, and
   * without this, `healthStore` would keep reporting `connected: true` while the connection is
   * actually being torn down and retried. A second `recordEventSubConnected(false)` call from
   * an already-recording caller is harmless.
   * @param socket - The socket to tear down, or `null` (always a no-op in that case).
   * @returns Nothing.
   */
  private forceReconnect(socket: WebSocket | null): void {
    if (this.ws !== socket) return;
    recordEventSubConnected(this.name, false);
    // Best-effort: request a close (harmless if already closing/closed) so Twitch has a
    // better chance of revoking this session's EventSub subscriptions promptly, rather than
    // leaving them "enabled" until Twitch's own delayed dead-connection detection catches up.
    // We don't wait on it — the next connect() proceeds immediately regardless.
    socket?.close();
    this.clearKeepaliveTimer();
    this.clearConnectTimer();
    // The next session's welcome subscribes afresh, so a pending retry for this one is moot.
    this.subscribeRetry.cancel();
    this.ws = null;
    this.sessionId = null;
    this.freshSessionGeneration++;
    if (!this.stopped) {
      // If this socket died mid-migration before its welcome landed, drop any reload that
      // was deferred for it — the eventual reconnect's own session_welcome will subscribe
      // with the latest currentData anyway (see onSessionWelcome's non-reconnecting branch).
      this.isReconnecting = false;
      this.reloadPendingAfterMigration = false;
      this.scheduleReconnect();
    }
  }

  /**
   * Dispatches a parsed EventSub message by `message_type` after dropping stale or duplicate
   * messages and resetting the keepalive watchdog.
   * @param msg - The parsed EventSub message.
   */
  private handleMessage(msg: EventSubMessage): void {
    const { message_type, message_id, message_timestamp } = msg.metadata;
    const rejection = rejectionReason(message_id, message_timestamp);
    if (rejection) { log.warn(`[${this.name}] ${rejection} message (${message_type}) — ignoring`); return; }
    this.resetKeepaliveTimer(); // also covers session_keepalive, which needs nothing else
    routeEventSubMessage(msg, {
      onWelcome: (welcome) => { this.onSessionWelcome(welcome); },
      onReconnect: (reconnectUrl) => { this.handleSessionReconnect(reconnectUrl); },
    });
  }

  /**
   * Handles the session_welcome message: records the new session id and, on first connect,
   * subscribes for the current streamer data. On a reconnect (session migration), existing
   * subscriptions carry over automatically — but if a reload() was deferred because it ran
   * while the old session id was still stale, it's applied now against the new session id.
   * A fresh (non-migration) session re-resolves the token first, since it may have expired, and
   * resets the subscribe retry (this welcome's own subscribe pass supersedes any pending retry, and
   * the new session gets its own retry budget — otherwise a budget exhausted on an earlier session
   * would leave a partially-subscribed replacement, kept open by its live subscriptions, with no
   * retries at all). Repeated failing fresh sessions stay bounded by the reconnect backoff, which
   * only resets once a pass gets something live.
   * A migration welcome resets the reconnect backoff (see {@link onOpen}) and leaves a pending
   * retry in place to run against the new session.
   */
  private onSessionWelcome(msg: EventSubMessage): void {
    const session = msg.payload.session!;
    this.sessionId = session.id;
    this.keepaliveTimeoutSecs = session.keepalive_timeout_seconds;
    this.resetKeepaliveTimer();
    if (this.isReconnecting) {
      this.isReconnecting = false;
      // Subscriptions carry over on a migration, so the session is known-good.
      this.reconnectAttempts = 0;
      log.info(`[${this.name}] Reconnected — session ${this.sessionId}`);
      if (this.reloadPendingAfterMigration) {
        this.reloadPendingAfterMigration = false;
        log.info(`[${this.name}] Applying reload deferred during session migration`);
        this.queueSubscribePass(session.id, 'No subscriptions after reload — disconnecting', 'Deferred reload error');
      }
      return;
    }
    log.info(`[${this.name}] Session established: ${this.sessionId}`);
    this.freshSessionGeneration++;
    this.subscribeRetry.reset();
    this.queueSubscribePass(session.id, 'No subscriptions — disconnecting', 'Subscribe error');
  }

  /**
   * Handles a Twitch-initiated session migration: connects to the new session at `reconnectUrl`
   * while leaving the old socket open, then closes that old socket after
   * {@link SESSION_MIGRATION_CLOSE_DELAY_MS} (Twitch's specified grace window) rather than
   * immediately — see {@link pendingMigrationOldSocket} for how a second migration arriving
   * before that delay elapses is handled.
   * @param reconnectUrl - The `reconnect_url` Twitch supplied in the `session_reconnect` message,
   *   validated by {@link buildReconnectUrl} before use.
   * @returns void.
   */
  private handleSessionReconnect(reconnectUrl: string): void {
    const safeUrl = buildReconnectUrl(reconnectUrl);
    if (!safeUrl) {
      log.error(`[${this.name}] Invalid reconnect URL — reconnecting`);
      // Tear down the current socket like every other reconnect path, rather than leaving it open
      // (and leaked) alongside the replacement until Twitch eventually closes it.
      this.forceReconnect(this.ws);
      return;
    }
    const oldSocket = this.ws;
    this.isReconnecting = true;
    log.info(`[${this.name}] Session reconnect — connecting to new session`);
    this.connect(safeUrl);
    // A second session_reconnect arriving before the first's delay elapses would otherwise
    // overwrite migrationCloseTimer without clearing the still-running native timer underneath
    // it — that orphaned timer would still fire later, nulling migrationCloseTimer out from under
    // the second timer (still pending) and letting it survive a stop() that should have cancelled
    // it. Close any already-pending old socket immediately and replace it instead, so there's only
    // ever one migration close in flight for stop() to cancel.
    if (this.migrationCloseTimer) {
      clearTimeout(this.migrationCloseTimer);
      this.pendingMigrationOldSocket?.close(1000, 'reconnect');
    }
    this.pendingMigrationOldSocket = oldSocket;
    this.migrationCloseTimer = setTimeout(() => {
      this.migrationCloseTimer = null;
      this.pendingMigrationOldSocket?.close(1000, 'reconnect');
      this.pendingMigrationOldSocket = null;
    }, SESSION_MIGRATION_CLOSE_DELAY_MS);
  }

  /**
   * Schedules a reconnect attempt after an exponential backoff delay (capped at
   * {@link RECONNECT_BACKOFF_MAX_MS}), replacing any already-pending attempt. Records the
   * attempt in `healthStore` before scheduling.
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); }
    const delay = Math.min(RECONNECT_BACKOFF_MAX_MS, 1_000 * Math.pow(2, this.reconnectAttempts));
    this.reconnectAttempts++;
    log.info(`[${this.name}] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
    recordEventSubReconnectAttempt(this.name);
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect(); }, delay);
  }

  /** Cancels the keepalive watchdog, if armed. */
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
