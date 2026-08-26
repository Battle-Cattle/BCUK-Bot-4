import { createLogger } from '../shared/logger';
import {
  VoiceConnectionStatus,
  entersState,
  type VoiceConnection,
} from '@discordjs/voice';

const log = createLogger('AudioConn');

/**
 * Callbacks injected into the connection handler functions so they can read
 * and mutate per-guild voice state without a direct import cycle.
 */
export interface ConnectionHandlerDeps {
  /** Returns the current attempt ID for the guild, used to detect stale callbacks. */
  getAttemptId: () => number;
  /** Returns the guild's current active voice connection, or null if none. */
  getConnection: () => VoiceConnection | null;
  /** Replaces the guild's active connection reference. */
  setConnection: (c: VoiceConnection | null) => void;
  /** Tears down guild playback state after the voice connection is lost. */
  tearDown: () => void;
  /** Schedules an exponential-backoff reconnect attempt for the guild. */
  scheduleReconnect: (reason: string) => void;
}

/** Logs the connection error, suppressing transient DNS failures that self-resolve via the state handler. */
function handleConnectionError(err: Error, attemptId: number, deps: ConnectionHandlerDeps): void {
  if (attemptId !== deps.getAttemptId()) return;

  const netErr = err as NodeJS.ErrnoException & { hostname?: string };
  if (netErr.code === 'EAI_AGAIN') {
    const host = netErr.hostname ? ` (${netErr.hostname})` : '';
    log.warn(`Voice DNS lookup failed temporarily${host}; connection will retry via state handler.`);
    return;
  }
  log.error('Voice connection error:', err);
}

/** Handles a voice connection drop, allowing a brief reconnect window before tearing down and scheduling a retry. */
async function handleDisconnected(
  joinedConnection: VoiceConnection,
  attemptId: number,
  deps: ConnectionHandlerDeps,
): Promise<void> {
  const isStale = (): boolean => {
    const c = deps.getConnection();
    return attemptId !== deps.getAttemptId() || (c !== null && c !== joinedConnection);
  };

  if (isStale()) return;

  try {
    await Promise.race([
      entersState(joinedConnection, VoiceConnectionStatus.Signalling, 5_000),
      entersState(joinedConnection, VoiceConnectionStatus.Connecting, 5_000),
    ]);
    // Reconnecting — no cleanup needed.
  } catch {
    if (isStale()) return;

    // Guard against a concurrent handleDisconnected call that already destroyed this connection.
    if (joinedConnection.state.status === VoiceConnectionStatus.Destroyed) return;

    // This handler is attached as a bare `.on()` callback (see setupConnectionHandlers) —
    // ESLint allows that only because it's expected to catch its own errors internally. A
    // throw here (e.g. from a future onStatusChanged listener called via deps.tearDown())
    // would otherwise become an unhandled rejection and crash the whole process over what
    // should be an isolated per-guild voice hiccup. scheduleReconnect runs in `finally` so a
    // cleanup failure can't also strand the guild with no reconnect attempt scheduled.
    try {
      joinedConnection.destroy();
      if (deps.getConnection() === joinedConnection) deps.setConnection(null);
      deps.tearDown();
      log.warn('Voice connection lost.');
    } catch (cleanupErr) {
      log.error('Error while cleaning up a lost voice connection:', cleanupErr);
    } finally {
      try {
        deps.scheduleReconnect('disconnected');
      } catch (reconnectErr) {
        log.error('Error while scheduling a voice reconnect:', reconnectErr);
      }
    }
  }
}

/**
 * Destroys the previous connection if it differs from the newly joined one,
 * cleaning up state so only the active connection is tracked.
 *
 * @param previousConnection - The connection held before this connect attempt, or null.
 * @param joinedConnection - The connection that just became ready.
 * @param deps - Per-guild state accessors.
 */
export function releasePreviousConnection(
  previousConnection: VoiceConnection | null,
  joinedConnection: VoiceConnection,
  deps: ConnectionHandlerDeps,
): void {
  if (!previousConnection || previousConnection === joinedConnection) return;
  previousConnection.destroy();
  if (deps.getConnection() === previousConnection) deps.setConnection(null);
}

/**
 * Tears down connections after a failed connect attempt, restoring the state
 * machine so a reconnect can be scheduled.
 *
 * @param previousConnection - The connection held before the failed attempt, or null.
 * @param nextConnection - The partially-created connection that failed, or null.
 * @param deps - Per-guild state accessors.
 */
export function cleanupFailedConnect(
  previousConnection: VoiceConnection | null,
  nextConnection: VoiceConnection | null,
  deps: ConnectionHandlerDeps,
): void {
  nextConnection?.destroy();
  const current = deps.getConnection();
  if (nextConnection && current === nextConnection) {
    // Promotion already occurred before the failure; nextConnection is now destroyed so
    // clear it to allow scheduleReconnect to fire.
    deps.setConnection(null);
    deps.tearDown();
  } else if (previousConnection && current === previousConnection) {
    // Failed before promoting; previousConnection was never released.
    previousConnection.destroy();
    deps.setConnection(null);
    deps.tearDown();
  }
}

/**
 * Attaches error and disconnect event handlers to a newly joined connection.
 *
 * @param joinedConnection - The voice connection to attach handlers to.
 * @param attemptId - The attempt ID at the time of joining; stale callbacks check against this.
 * @param deps - Per-guild state accessors used within the handlers.
 */
export function setupConnectionHandlers(
  joinedConnection: VoiceConnection,
  attemptId: number,
  deps: ConnectionHandlerDeps,
): void {
  joinedConnection.on('error', (err) => handleConnectionError(err, attemptId, deps));
  joinedConnection.on(VoiceConnectionStatus.Disconnected, () =>
    handleDisconnected(joinedConnection, attemptId, deps),
  );
}
