import { createLogger } from './logger';
import {
  VoiceConnectionStatus,
  entersState,
  type VoiceConnection,
} from '@discordjs/voice';

const log = createLogger('AudioConn');

export interface ConnectionHandlerDeps {
  getAttemptId: () => number;
  getConnection: () => VoiceConnection | null;
  setConnection: (c: VoiceConnection | null) => void;
  tearDown: () => void;
  scheduleReconnect: (reason: string) => void;
}

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

    joinedConnection.destroy();
    if (deps.getConnection() === joinedConnection) deps.setConnection(null);
    deps.tearDown();
    log.warn('Voice connection lost.');
    deps.scheduleReconnect('disconnected');
  }
}

export function releasePreviousConnection(
  previousConnection: VoiceConnection | null,
  joinedConnection: VoiceConnection,
  deps: ConnectionHandlerDeps,
): void {
  if (!previousConnection || previousConnection === joinedConnection) return;
  previousConnection.destroy();
  if (deps.getConnection() === previousConnection) deps.setConnection(null);
}

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
