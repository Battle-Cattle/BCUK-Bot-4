import { createLogger } from '../../shared/logger';
import { BackoffRetry } from './backoffRetry';
import { shouldSelfStop, type SubscribeOutcome } from './subscribeOutcome';
import {
  subscribeForStreamer, fetchValidEventSubToken, removeSessionSubscriptions, type StreamerEventSubData,
} from './twitchEventSubSubscriptions';

// The subscribe side of a StreamerConnection: queuing subscribe passes on one serial chain,
// deciding whether a pass still owns its session (and carrying it over a migration if not),
// acting on the outcome (self-stop, reconnect-backoff reset, transient-failure retry), and
// refreshing the token first. The WebSocket lifecycle stays in twitchEventSubConnection.ts, which
// supplies the session state this needs through {@link SubscribePassHost}.

const log = createLogger('EventSub');

/** Base delay before retrying a subscribe pass whose creates failed transiently (5xx, 429, network,
 *  timeout) — doubled per consecutive failed pass, capped at {@link SUBSCRIBE_RETRY_MAX_MS}. */
const SUBSCRIBE_RETRY_BASE_MS = 5_000;
/** Upper bound on the delay between transient-failure subscribe retries. */
const SUBSCRIBE_RETRY_MAX_MS = 5 * 60_000;
/** Consecutive transient-failure subscribe retries attempted before giving up until the next
 *  reload/fresh session (a socket left with no subscriptions is closed by Twitch after ~10s, so
 *  the backed-off reconnect path keeps re-trying on a fresh session regardless). */
const SUBSCRIBE_RETRY_MAX_ATTEMPTS = 8;

/** One subscribe pass, as queued on a {@link SubscribePassRunner}'s chain. */
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


/** The connection state a {@link SubscribePassRunner} reads and the few writes it makes back. */
export interface SubscribePassHost {
  /** Streamer display name, for log lines. */
  readonly name: string;
  /** The live session's id, or null between sockets. */
  sessionId(): string | null;
  /** Whether `stop()` has been called since the last `start()`. */
  isStopped(): boolean;
  /** Whether a session migration (`session_reconnect`) is in flight. */
  isMigrating(): boolean;
  /** Bumped whenever the session is replaced other than by a migration — see `carryPassOverMigration`. */
  freshSessionGeneration(): number;
  /** Defers a subscribe pass to the migrating session's welcome. */
  deferToMigrationWelcome(): void;
  /** The streamer data subscribe passes use. */
  getData(): StreamerEventSubData;
  /** Replaces the streamer data (after a token refresh). */
  setData(data: StreamerEventSubData): void;
  /** Called when a pass leaves something live: the session is known-good, so reset reconnect backoff. */
  onSubscribeSucceeded(): void;
  /** Stops the connection because it has nothing to subscribe to, and notifies its owner. */
  selfStop(): void;
}

/** Runs a {@link StreamerConnection}'s subscribe passes; see the module comment. */
export class SubscribePassRunner {
  /** Pending retry of a subscribe pass whose creates failed transiently — see `scheduleSubscribeRetry`. */
  readonly retry = new BackoffRetry(SUBSCRIBE_RETRY_BASE_MS, SUBSCRIBE_RETRY_MAX_MS, SUBSCRIBE_RETRY_MAX_ATTEMPTS);
  /** Serial chain every subscribe pass and reload runs on, so two never overlap. */
  chain: Promise<void> = Promise.resolve();

  /**
   * @param host - The owning connection's session state (see {@link SubscribePassHost}).
   */
  constructor(private readonly host: SubscribePassHost) {}

  /**
   * Appends `work` to {@link chain}, logging (not propagating) a failure with `errorLabel`.
   * @param work - The async step to run once everything queued before it has settled.
   * @param errorLabel - Prefix for the error logged if `work` throws.
   */
  enqueue(work: () => Promise<void>, errorLabel: string): void {
    this.chain = this.chain
      .then(work)
      .catch((err: unknown) => { log.error(`[${this.host.name}] ${errorLabel}:`, err); });
  }

  /**
   * Queues a subscribe pass on {@link chain} (see {@link run}), recording
   * the current the host's fresh-session generation so the pass can tell, when it runs, whether its
   * session was replaced by a migration or by a fresh connection. Every queued pass re-resolves the
   * token first ({@link refreshToken}): a queued pass can run long after `currentData` was last
   * loaded (a fresh welcome's pass deferred past a migration, a retry, a carried-over pass), and an
   * expired token fails the listing and every create with a 401, which reads as "all auth failures"
   * and self-stops the connection. Only the connection's `doReload`, which runs with freshly loaded data, skips it.
   * @param sessionId - The session to subscribe on.
   * @param emptyLogMessage - Logged when zero subscriptions result and the connection self-stops.
   * @param errorLabel - Prefix for the error logged if the pass throws.
   */
  queue(sessionId: string, emptyLogMessage: string, errorLabel: string): void {
    const pass: SubscribePass = { sessionId, emptyLogMessage, refreshToken: true, generation: this.host.freshSessionGeneration() };
    this.enqueue(() => this.run(pass), errorLabel);
  }

  /**
   * Subscribes for the current streamer data on the given session id and stops the connection
   * (notifying onSelfStop) only if nothing is desired, or nothing is live and every failure was an
   * auth/scope failure (retrying can't help until the user reconnects Twitch). If any create failed
   * transiently (5xx, 429, network, timeout), the connection is kept and the subscribe step retried
   * with backoff (see {@link scheduleSubscribeRetry}) instead of dropping the streamer until an
   * unrelated reload. Once anything is live, the session is known-good, so the reconnect backoff is
   * reset here (rather than on socket open — see `onOpen` in `twitchEventSubConnection.ts`). Shared by the connection's doReload(), the
   * welcome handler, the deferred reload applied after a session migration, and the retry timer. No-ops if the
   * connection was already stopped, or if the pass no longer owns its session when it starts (a queued pass
   * can run after another migration replaced it; subscribing then would treat the subscriptions carried
   * to the new session as stale and delete them). If it's stopped while the subscribe call is in flight —
   * e.g. `stop()` called from `twitchEventSub.ts` on shutdown or when a streamer is removed —
   * it deletes whatever that call created on the now-closed session (see
   * `removeSessionSubscriptions`) and returns without the zero-count handling, so a
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
  async run(pass: SubscribePass): Promise<void> {
    if (this.passOvertaken(pass)) return;
    if (pass.refreshToken) {
      await this.refreshToken();
      if (this.passOvertaken(pass)) return;
    }
    const data = this.host.getData();
    const outcome = await subscribeForStreamer(pass.sessionId, data);
    if (this.host.isStopped()) {
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
    if (this.host.isStopped()) return true;
    if (this.host.sessionId() === pass.sessionId && !this.host.isMigrating()) return false;
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
    if (pass.generation !== this.host.freshSessionGeneration()) {
      log.info(`[${this.host.name}] Session ${pass.sessionId} replaced by a new connection — dropping its subscribe pass`);
      return;
    }
    const liveSessionId = this.host.sessionId();
    if (this.host.isMigrating() || !liveSessionId) {
      log.info(`[${this.host.name}] Session ${pass.sessionId} is migrating — deferring its subscribe pass to the new session`);
      this.host.deferToMigrationWelcome();
      return;
    }
    log.info(`[${this.host.name}] Session ${pass.sessionId} was migrated — re-running its subscribe pass on ${liveSessionId}`);
    this.queue(liveSessionId, pass.emptyLogMessage, 'Migrated subscribe pass error');
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
      log.info(`[${this.host.name}] ${emptyLogMessage}`);
      this.host.selfStop();
      return;
    }
    if (outcome.live > 0) this.host.onSubscribeSucceeded();
    if (outcome.transientFailures > 0) {
      this.scheduleSubscribeRetry(outcome.transientFailures);
    } else {
      this.retry.reset();
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
    const delay = this.retry.schedule(() => { this.runSubscribeRetry(); });
    if (delay === null) {
      log.error(`[${this.host.name}] ${failures} EventSub subscription(s) still failing after ${this.retry.attempts} retries — giving up until the next reload/reconnect`);
      return;
    }
    log.warn(`[${this.host.name}] ${failures} EventSub subscription(s) failed transiently — retrying in ${delay}ms (attempt ${this.retry.attempts})`);
  }

  /** Runs a scheduled subscribe retry (see {@link scheduleSubscribeRetry}) against the live session. */
  private runSubscribeRetry(): void {
    const sessionId = this.host.sessionId();
    if (this.host.isStopped() || !sessionId) return;
    // Mid-migration, sessionId is still the old session's — hand the retry to the new session's
    // welcome via the same deferral reload() uses.
    if (this.host.isMigrating()) { this.host.deferToMigrationWelcome(); return; }
    this.queue(sessionId, 'No subscriptions after retry — disconnecting', 'Subscribe retry error');
  }

  /**
   * Replaces `currentData.token` with a currently-valid token from the DB (refreshing it if
   * expired) via `fetchValidEventSubToken`. The token handed over at construction/reload can
   * be hours old by the time a non-migration reconnect re-subscribes, and an expired one would
   * fail every create with a 401. Skipped if a reload() replaced `currentData` meanwhile (that data
   * already carries a freshly-resolved token); on a lookup error or a null result (failed refresh)
   * the existing token is kept.
   * @returns Resolves once the token has been refreshed (or the attempt logged as failed).
   */
  private async refreshToken(): Promise<void> {
    const data = this.host.getData();
    try {
      const token = await fetchValidEventSubToken(data.streamerId);
      // A null token means the refresh failed (transiently during a Twitch outage, or because the
      // grant was revoked). Keep the existing token either way: swapping in null would read as
      // "nothing to subscribe" and self-stop, whereas the old token either still works, fails
      // transiently (and is retried), or 401s and is handled as an auth failure.
      if (token === null) {
        log.warn(`[${this.host.name}] Could not resolve a fresh EventSub token; subscribing with the existing one`);
        return;
      }
      if (this.host.getData() === data) this.host.setData({ ...data, token });
    } catch (err) {
      log.error(`[${this.host.name}] Failed to refresh EventSub token before subscribing:`, err);
    }
  }
}
