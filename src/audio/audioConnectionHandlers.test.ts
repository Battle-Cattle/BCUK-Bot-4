import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockLog } = vi.hoisted(() => ({
  mockLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../shared/logger', () => ({
  createLogger: () => mockLog,
}));

vi.mock('@discordjs/voice', () => ({
  VoiceConnectionStatus: { Signalling: 'signalling', Connecting: 'connecting', Disconnected: 'disconnected', Destroyed: 'destroyed' },
  entersState: vi.fn(),
}));

import {
  releasePreviousConnection,
  cleanupFailedConnect,
  setupConnectionHandlers,
  type ConnectionHandlerDeps,
} from './audioConnectionHandlers';
import { entersState } from '@discordjs/voice';

function makeConnection(status: string = 'ready') {
  const handlers = new Map<string, (...args: any[]) => void>();
  return {
    on: vi.fn((event: string, cb: (...args: any[]) => void) => { handlers.set(event, cb); }),
    destroy: vi.fn(),
    state: { status },
    _handlers: handlers,
  };
}

function makeDeps(overrides: Partial<ConnectionHandlerDeps> = {}): ConnectionHandlerDeps {
  return {
    getAttemptId: vi.fn(() => 1),
    getConnection: vi.fn(() => null),
    setConnection: vi.fn(),
    tearDown: vi.fn(),
    scheduleReconnect: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── setupConnectionHandlers / handleConnectionError ─────────────────────────

describe('setupConnectionHandlers — error handler', () => {
  it('registers error and Disconnected listeners', () => {
    const conn = makeConnection();
    setupConnectionHandlers(conn as any, 1, makeDeps());
    expect(conn._handlers.has('error')).toBe(true);
    expect(conn._handlers.has('disconnected')).toBe(true);
  });

  it('logs the error when the attempt is still current', async () => {
    const conn = makeConnection();
    const deps = makeDeps();
    setupConnectionHandlers(conn as any, 1, deps);
    const log = mockLog;

    conn._handlers.get('error')!(new Error('boom'));

    expect(log.error).toHaveBeenCalled();
  });

  it('ignores errors from a stale attempt', async () => {
    const conn = makeConnection();
    const deps = makeDeps({ getAttemptId: vi.fn(() => 2) });
    setupConnectionHandlers(conn as any, 1, deps);
    const log = mockLog;

    conn._handlers.get('error')!(new Error('boom'));

    expect(log.error).not.toHaveBeenCalled();
  });

  it('warns instead of erroring on a transient EAI_AGAIN DNS failure', async () => {
    const conn = makeConnection();
    const deps = makeDeps();
    setupConnectionHandlers(conn as any, 1, deps);
    const log = mockLog;
    const dnsErr = Object.assign(new Error('dns'), { code: 'EAI_AGAIN', hostname: 'voice.discord.gg' });

    conn._handlers.get('error')!(dnsErr);

    expect(log.warn).toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });
});

// ─── handleDisconnected (via setupConnectionHandlers) ─────────────────────────

describe('setupConnectionHandlers — disconnected handler', () => {
  it('does nothing if a reconnect resolves before the grace window elapses', async () => {
    vi.mocked(entersState).mockResolvedValue(undefined as never);
    const conn = makeConnection();
    const deps = makeDeps({ getConnection: vi.fn(() => conn as any) });
    setupConnectionHandlers(conn as any, 1, deps);

    await conn._handlers.get('disconnected')!();

    expect(conn.destroy).not.toHaveBeenCalled();
    expect(deps.tearDown).not.toHaveBeenCalled();
    expect(deps.scheduleReconnect).not.toHaveBeenCalled();
  });

  it('returns early without acting when the callback is already stale', async () => {
    const conn = makeConnection();
    const deps = makeDeps({ getAttemptId: vi.fn(() => 99) });
    setupConnectionHandlers(conn as any, 1, deps);

    await conn._handlers.get('disconnected')!();

    expect(entersState).not.toHaveBeenCalled();
    expect(conn.destroy).not.toHaveBeenCalled();
  });

  it('destroys the connection, tears down, and reschedules when the grace window times out', async () => {
    vi.mocked(entersState).mockRejectedValue(new Error('timeout'));
    const conn = makeConnection();
    const deps = makeDeps({ getConnection: vi.fn(() => conn as any) });
    setupConnectionHandlers(conn as any, 1, deps);

    await conn._handlers.get('disconnected')!();

    expect(conn.destroy).toHaveBeenCalled();
    expect(deps.setConnection).toHaveBeenCalledWith(null);
    expect(deps.tearDown).toHaveBeenCalled();
    expect(deps.scheduleReconnect).toHaveBeenCalledWith('disconnected');
  });

  it('does not clear the connection slot if a newer connection replaces it during the grace window', async () => {
    vi.mocked(entersState).mockRejectedValue(new Error('timeout'));
    const conn = makeConnection();
    const otherConn = makeConnection();
    const getConnection = vi.fn().mockReturnValueOnce(conn as any).mockReturnValue(otherConn as any);
    const deps = makeDeps({ getConnection });
    setupConnectionHandlers(conn as any, 1, deps);

    await conn._handlers.get('disconnected')!();

    // Current at entry, but replaced by the time the grace window times out — bails out before cleanup.
    expect(conn.destroy).not.toHaveBeenCalled();
    expect(deps.setConnection).not.toHaveBeenCalled();
    expect(deps.tearDown).not.toHaveBeenCalled();
  });

  it('skips destroy but still bails out if the connection was already destroyed by a concurrent call', async () => {
    vi.mocked(entersState).mockRejectedValue(new Error('timeout'));
    const conn = makeConnection('destroyed');
    const deps = makeDeps({ getConnection: vi.fn(() => conn as any) });
    setupConnectionHandlers(conn as any, 1, deps);

    await conn._handlers.get('disconnected')!();

    expect(conn.destroy).not.toHaveBeenCalled();
    expect(deps.tearDown).not.toHaveBeenCalled();
    expect(deps.scheduleReconnect).not.toHaveBeenCalled();
  });

  it('re-checks staleness after the grace window before tearing down', async () => {
    vi.mocked(entersState).mockRejectedValue(new Error('timeout'));
    const conn = makeConnection();
    const getAttemptId = vi.fn().mockReturnValueOnce(1).mockReturnValue(2);
    const deps = makeDeps({ getAttemptId, getConnection: vi.fn(() => conn as any) });
    setupConnectionHandlers(conn as any, 1, deps);

    await conn._handlers.get('disconnected')!();

    expect(conn.destroy).not.toHaveBeenCalled();
    expect(deps.tearDown).not.toHaveBeenCalled();
  });
});

// ─── releasePreviousConnection ────────────────────────────────────────────────

describe('releasePreviousConnection', () => {
  it('does nothing when there is no previous connection', () => {
    const joined = makeConnection();
    const deps = makeDeps();
    releasePreviousConnection(null, joined as any, deps);
    expect(deps.setConnection).not.toHaveBeenCalled();
  });

  it('does nothing when the previous connection is the same as the joined one', () => {
    const joined = makeConnection();
    const deps = makeDeps();
    releasePreviousConnection(joined as any, joined as any, deps);
    expect(joined.destroy).not.toHaveBeenCalled();
  });

  it('destroys the previous connection and clears the slot if it is still current', () => {
    const previous = makeConnection();
    const joined = makeConnection();
    const deps = makeDeps({ getConnection: vi.fn(() => previous as any) });
    releasePreviousConnection(previous as any, joined as any, deps);
    expect(previous.destroy).toHaveBeenCalled();
    expect(deps.setConnection).toHaveBeenCalledWith(null);
  });

  it('destroys the previous connection but leaves the slot alone if it was already replaced', () => {
    const previous = makeConnection();
    const joined = makeConnection();
    const deps = makeDeps({ getConnection: vi.fn(() => joined as any) });
    releasePreviousConnection(previous as any, joined as any, deps);
    expect(previous.destroy).toHaveBeenCalled();
    expect(deps.setConnection).not.toHaveBeenCalled();
  });
});

// ─── cleanupFailedConnect ─────────────────────────────────────────────────────

describe('cleanupFailedConnect', () => {
  it('destroys nextConnection and clears state when promotion already happened', () => {
    const next = makeConnection();
    const deps = makeDeps({ getConnection: vi.fn(() => next as any) });
    cleanupFailedConnect(null, next as any, deps);
    expect(next.destroy).toHaveBeenCalled();
    expect(deps.setConnection).toHaveBeenCalledWith(null);
    expect(deps.tearDown).toHaveBeenCalled();
  });

  it('destroys previousConnection and clears state when the failure happened before promotion', () => {
    const previous = makeConnection();
    const next = makeConnection();
    const deps = makeDeps({ getConnection: vi.fn(() => previous as any) });
    cleanupFailedConnect(previous as any, next as any, deps);
    expect(next.destroy).toHaveBeenCalled();
    expect(previous.destroy).toHaveBeenCalled();
    expect(deps.setConnection).toHaveBeenCalledWith(null);
    expect(deps.tearDown).toHaveBeenCalled();
  });

  it('does nothing to shared state when the active connection is unrelated to this attempt', () => {
    const previous = makeConnection();
    const next = makeConnection();
    const unrelated = makeConnection();
    const deps = makeDeps({ getConnection: vi.fn(() => unrelated as any) });
    cleanupFailedConnect(previous as any, next as any, deps);
    expect(next.destroy).toHaveBeenCalled();
    expect(deps.setConnection).not.toHaveBeenCalled();
    expect(deps.tearDown).not.toHaveBeenCalled();
  });

  it('handles a null nextConnection without throwing', () => {
    const previous = makeConnection();
    const deps = makeDeps({ getConnection: vi.fn(() => previous as any) });
    expect(() => cleanupFailedConnect(previous as any, null, deps)).not.toThrow();
    expect(previous.destroy).toHaveBeenCalled();
    expect(deps.tearDown).toHaveBeenCalled();
  });
});
