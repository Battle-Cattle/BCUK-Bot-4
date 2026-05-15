import {
  VoiceConnectionStatus,
  entersState,
  type VoiceConnection,
} from '@discordjs/voice';

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
    console.warn(`[AudioPlayer] Voice DNS lookup failed temporarily${host}; connection will retry via state handler.`);
    return;
  }
  console.error('[AudioPlayer] Voice connection error:', err);
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
    console.warn('[AudioPlayer] Voice connection lost.');
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
  // If the new attempt failed before promoting, previousConnection was never torn down.
  // Destroy it now so scheduleReconnect is not blocked by a stale non-null connection.
  if (previousConnection && deps.getConnection() === previousConnection) {
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
