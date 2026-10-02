import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../../test-utils/loggerMock';

vi.mock('../../shared/config', () => ({ SSE_MAX_TOTAL_CONNECTIONS: 10 }));
vi.mock('../../db', () => ({
  getStreamerByDiscordId: vi.fn(),
  getAllStreamersWithGroups: vi.fn(),
  // Pass-through cache: every getCache() call reloads, so each test controls the result via the mock above.
  createManagedLookupCache: (opts: { loadCache: () => Promise<unknown> }) => ({ getCache: () => opts.loadCache(), invalidate: () => {} }),
  DEFAULT_REFRESH_FAILURE_BACKOFF_MS: 5000,
  DEFAULT_REFRESH_FAILURE_MAX_BACKOFF_MS: 60000,
}));
vi.mock('../session', () => ({ getSessionUser: vi.fn() }));

import { attachSseConnection, broadcastToChannel, chainConnectionCleanup } from './sseChannel';
import {
  createSseEventsHandler, createLoginValidator, createStreamerSseEventsHandler, createOverlayStatusEventsHandler,
} from './sseEventsHandlers';
import {
  createSseConnectionPool, isKnownStreamerLogin, unauthenticatedOverlayPool,
  UNAUTH_OVERLAY_SSE_MAX_CONNECTIONS, UNAUTH_OVERLAY_SSE_MAX_PER_IP,
  tryReservePoolSlot, releasePoolSlot,
} from './sseOverlayAccess';
import { getStreamerByDiscordId, getAllStreamersWithGroups } from '../../db';
import { getSessionUser } from '../session';

const log = mockLogger() as any;

const LOGIN_RE = /^[a-zA-Z0-9_]{1,25}$/;
const RESERVED_LOGINS = new Set(['settings']);

// Mirrors real EventEmitter semantics (multiple listeners per event, all fired in registration
// order) rather than keeping only the last one — attachSseConnection and a caller built on top of
// attachSseConnection (e.g. createOverlayStatusEventsHandler) can each register their own 'close'/'error' listener
// on the same req/res, and both must still fire.
function makeRes() {
  const handlers: Record<string, Array<() => void>> = {};
  return {
    setHeader: vi.fn(),
    flushHeaders: vi.fn(),
    write: vi.fn(),
    status: vi.fn().mockReturnThis(),
    end: vi.fn(),
    on: vi.fn((event: string, cb: () => void) => { (handlers[event] ??= []).push(cb); }),
    triggerResClose: () => handlers['close']?.forEach((cb) => cb()),
    triggerResError: () => handlers['error']?.forEach((cb) => cb()),
  };
}

function makeReq(login: string, ip = '10.0.0.1') {
  const closeCbs: Array<() => void> = [];
  return {
    req: {
      params: { login },
      ip,
      on: (event: string, cb: () => void) => {
        if (event === 'close') closeCbs.push(cb);
      },
    },
    triggerClose: () => closeCbs.forEach((cb) => cb()),
  };
}

let connections: Map<string, Set<any>>;

beforeEach(() => {
  connections = new Map();
  vi.clearAllMocks();
});

const isValidLogin = createLoginValidator(LOGIN_RE, RESERVED_LOGINS);

function buildHandler(maxPerChannel = 10, pool = createSseConnectionPool(100, 100)) {
  return createSseEventsHandler({ connections, isValidLogin, maxPerChannel, pool, isKnownLogin: async () => true });
}

describe('createLoginValidator', () => {
  it('returns null for a malformed login', () => {
    expect(isValidLogin('not-valid!')).toBeNull();
  });

  it('returns null for a reserved login', () => {
    expect(isValidLogin('settings')).toBeNull();
    expect(isValidLogin('SETTINGS')).toBeNull();
  });

  it('returns the lowercased login for a valid one', () => {
    expect(isValidLogin('SomeChannel')).toBe('somechannel');
  });
});

describe('createSseEventsHandler', () => {
  it('calls next() for a malformed login', async () => {
    const handler = buildHandler();
    const next = vi.fn();
    const { req } = makeReq('not-valid!');
    await handler(req as any, makeRes() as any, next);
    expect(next).toHaveBeenCalled();
  });

  it('calls next() for a reserved login', async () => {
    const handler = buildHandler();
    const next = vi.fn();
    const { req } = makeReq('settings');
    await handler(req as any, makeRes() as any, next);
    expect(next).toHaveBeenCalled();
  });

  it('registers the connection and sends the SSE handshake for a valid login', async () => {
    const handler = buildHandler();
    const res = makeRes();
    const { req, triggerClose } = makeReq('freshchannel');

    await handler(req as any, res as any, vi.fn());

    expect(connections.get('freshchannel')?.has(res as any)).toBe(true);
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(res.write).toHaveBeenCalledWith(': connected\n\n');

    triggerClose();
  });

  it('lowercases the login before using it as a connection key', async () => {
    const handler = buildHandler();
    const res = makeRes();
    const { req, triggerClose } = makeReq('SomeChannel');

    await handler(req as any, res as any, vi.fn());

    expect(connections.has('somechannel')).toBe(true);
    triggerClose();
  });

  it('returns 429 when the per-channel connection limit is exceeded', async () => {
    const handler = buildHandler(2);
    connections.set('full', new Set([{}, {}] as any));
    const res = makeRes();
    const { req } = makeReq('full');

    await handler(req as any, res as any, vi.fn());

    expect(res.status).toHaveBeenCalledWith(429);
    expect(connections.get('full')?.has(res as any)).toBe(false);
  });

  it('sends a ping every 25 seconds', async () => {
    vi.useFakeTimers();
    try {
      const handler = buildHandler();
      const res = makeRes();
      const { req, triggerClose } = makeReq('pingchannel');

      await handler(req as any, res as any, vi.fn());
      res.write.mockClear();

      vi.advanceTimersByTime(25_000);
      expect(res.write).toHaveBeenCalledWith(': ping\n\n');
      triggerClose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('evicts the client and clears the interval when a ping write fails', async () => {
    vi.useFakeTimers();
    try {
      const handler = buildHandler();
      const res = makeRes();
      const { req } = makeReq('brokenpipe');

      await handler(req as any, res as any, vi.fn());
      res.write.mockImplementation(() => {
        throw new Error('broken pipe');
      });

      vi.advanceTimersByTime(25_000);

      expect(connections.get('brokenpipe')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('removes the client (and empty Set) when the request closes', async () => {
    const handler = buildHandler();
    const res = makeRes();
    const { req, triggerClose } = makeReq('closingchannel');

    await handler(req as any, res as any, vi.fn());
    expect(connections.get('closingchannel')?.has(res as any)).toBe(true);

    triggerClose();
    expect(connections.get('closingchannel')).toBeUndefined();
  });

  it('removes only the closing client, keeping the channel entry when others remain', async () => {
    const handler = buildHandler();
    const res1 = makeRes();
    const res2 = makeRes();
    const { req: req1, triggerClose: closeReq1 } = makeReq('sharedchannel');
    const { req: req2, triggerClose: closeReq2 } = makeReq('sharedchannel');

    await handler(req1 as any, res1 as any, vi.fn());
    await handler(req2 as any, res2 as any, vi.fn());

    closeReq1();
    expect(connections.get('sharedchannel')?.has(res1 as any)).toBe(false);
    expect(connections.get('sharedchannel')?.has(res2 as any)).toBe(true);
    closeReq2();
  });
});

describe('createSseEventsHandler — unauthenticated overlay protections', () => {
  it('replies 404 without attaching for a well-formed login that is not a registered streamer', async () => {
    const pool = createSseConnectionPool(100, 100);
    const handler = createSseEventsHandler({
      connections, isValidLogin, maxPerChannel: 10, pool, isKnownLogin: async () => false,
    });
    const res = makeRes();
    const next = vi.fn();
    const { req } = makeReq('nobodyhere');

    await handler(req as any, res as any, next);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(next).not.toHaveBeenCalled();
    expect(connections.has('nobodyhere')).toBe(false);
    expect(res.flushHeaders).not.toHaveBeenCalled();
    expect(pool.count).toBe(0);
  });

  it('replies 503 when the known-login lookup fails', async () => {
    const handler = createSseEventsHandler({
      connections, isValidLogin, maxPerChannel: 10, pool: createSseConnectionPool(100, 100),
      isKnownLogin: async () => { throw new Error('db down'); },
    });
    const res = makeRes();
    const { req } = makeReq('somechannel');

    await handler(req as any, res as any, vi.fn());

    expect(res.status).toHaveBeenCalledWith(503);
    expect(connections.has('somechannel')).toBe(false);
  });

  it('does not attach when the client disconnected while the lookup was pending', async () => {
    const pool = createSseConnectionPool(100, 100);
    const handler = buildHandler(10, pool);
    const res = Object.assign(makeRes(), { closed: true });
    const { req } = makeReq('gonechannel');

    await handler(req as any, res as any, vi.fn());

    expect(connections.has('gonechannel')).toBe(false);
    expect(pool.count).toBe(0);
  });

  it('replies 429 once the unauthenticated sub-cap is reached, while an authenticated stream still attaches', async () => {
    const pool = createSseConnectionPool(2, 100);
    const handler = buildHandler(10, pool);
    const closers: Array<() => void> = [];
    for (let i = 0; i < 2; i++) {
      const { req, triggerClose } = makeReq(`chan${i}`, `10.0.0.${i + 1}`);
      await handler(req as any, makeRes() as any, vi.fn());
      closers.push(triggerClose);
    }

    const overflowRes = makeRes();
    const { req: overflowReq } = makeReq('chan9', '10.0.0.99');
    await handler(overflowReq as any, overflowRes as any, vi.fn());
    expect(overflowRes.status).toHaveBeenCalledWith(429);
    expect(connections.has('chan9')).toBe(false);

    const authRes = makeRes();
    const { req: authReq, triggerClose: closeAuth } = makeReq('unused');
    const attached = attachSseConnection(authReq as any, authRes as any, { connections, key: 'companion', maxPerChannel: 10 });
    expect(attached).toBe(true);

    closeAuth();
    closers.forEach((close) => close());
  });

  it('replies 429 once one IP reaches the per-IP cap, while another IP still attaches', async () => {
    const pool = createSseConnectionPool(100, 2);
    const handler = buildHandler(10, pool);
    const closers: Array<() => void> = [];
    for (let i = 0; i < 2; i++) {
      const { req, triggerClose } = makeReq('streamer', '203.0.113.5');
      await handler(req as any, makeRes() as any, vi.fn());
      closers.push(triggerClose);
    }

    const sameIpRes = makeRes();
    const { req: sameIpReq } = makeReq('streamer', '203.0.113.5');
    await handler(sameIpReq as any, sameIpRes as any, vi.fn());
    expect(sameIpRes.status).toHaveBeenCalledWith(429);

    const otherIpRes = makeRes();
    const { req: otherIpReq, triggerClose } = makeReq('streamer', '198.51.100.7');
    await handler(otherIpReq as any, otherIpRes as any, vi.fn());
    expect(otherIpRes.status).not.toHaveBeenCalled();
    expect(connections.get('streamer')?.has(otherIpRes as any)).toBe(true);

    triggerClose();
    closers.forEach((close) => close());
  });

  it('decrements the pool and per-IP counters on close, freeing the slot for a new connection', async () => {
    const pool = createSseConnectionPool(1, 1);
    const handler = buildHandler(10, pool);
    const res = makeRes();
    const { req, triggerClose } = makeReq('streamer', '203.0.113.5');
    await handler(req as any, res as any, vi.fn());
    expect(pool.count).toBe(1);
    expect(pool.byIp.size).toBe(1);

    triggerClose();
    res.triggerResClose(); // idempotent: a second close event must not double-decrement
    expect(pool.count).toBe(0);
    expect(pool.byIp.size).toBe(0);

    const res2 = makeRes();
    const { req: req2, triggerClose: close2 } = makeReq('streamer', '203.0.113.5');
    await handler(req2 as any, res2 as any, vi.fn());
    expect(res2.status).not.toHaveBeenCalled();
    expect(pool.count).toBe(1);
    close2();
  });

  it('releases pool counters when a broadcast write fails', async () => {
    const pool = createSseConnectionPool(100, 100);
    const handler = buildHandler(10, pool);
    const res = makeRes();
    const { req } = makeReq('streamer');
    await handler(req as any, res as any, vi.fn());
    res.write.mockImplementation(() => { throw new Error('broken pipe'); });

    broadcastToChannel(connections, 'streamer', { hi: 1 });

    expect(pool.count).toBe(0);
    expect(pool.byIp.size).toBe(0);
  });

  it('defaults to the shared unauthenticated overlay pool sized from the process-wide cap', async () => {
    // SSE_MAX_TOTAL_CONNECTIONS is mocked to 10 at the top of this file → 40% = 4.
    expect(UNAUTH_OVERLAY_SSE_MAX_CONNECTIONS).toBe(4);
    expect(UNAUTH_OVERLAY_SSE_MAX_PER_IP).toBe(20);
    expect(unauthenticatedOverlayPool.maxConnections).toBe(4);

    const handler = createSseEventsHandler({ connections, isValidLogin, maxPerChannel: 10, isKnownLogin: async () => true });
    const { req, triggerClose } = makeReq('streamer');
    await handler(req as any, makeRes() as any, vi.fn());
    expect(unauthenticatedOverlayPool.count).toBe(1);
    triggerClose();
    expect(unauthenticatedOverlayPool.count).toBe(0);
  });
});

describe('isKnownStreamerLogin', () => {
  it('matches registered streamer logins case-insensitively and ignores streamers without a Twitch name', async () => {
    vi.mocked(getAllStreamersWithGroups).mockResolvedValue([
      { twitch_name: 'KnownStreamer' }, { twitch_name: null },
    ] as any);

    await expect(isKnownStreamerLogin('knownstreamer')).resolves.toBe(true);
    await expect(isKnownStreamerLogin('someoneelse')).resolves.toBe(false);
  });
});

describe('attachSseConnection', () => {
  it('registers the connection under an arbitrary key type (e.g. a numeric streamer ID)', () => {
    const numericConnections = new Map<number, Set<any>>();
    const res = makeRes();
    const { req, triggerClose } = makeReq('unused');

    const attached = attachSseConnection(req as any, res as any, { connections: numericConnections, key: 42, maxPerChannel: 5 });

    expect(attached).toBe(true);
    expect(numericConnections.get(42)?.has(res as any)).toBe(true);
    expect(res.write).toHaveBeenCalledWith(': connected\n\n');
    triggerClose();
  });

  it('returns false and replies 429 when the key is already at its connection limit', () => {
    const res = makeRes();
    const { req } = makeReq('unused');
    connections.set('full', new Set([{}, {}] as any));

    const attached = attachSseConnection(req as any, res as any, { connections, key: 'full', maxPerChannel: 2 });

    expect(attached).toBe(false);
    expect(res.status).toHaveBeenCalledWith(429);
    expect(connections.get('full')?.has(res as any)).toBe(false);
  });

  it('cleans up on request close', () => {
    const res = makeRes();
    const { req, triggerClose } = makeReq('unused');

    attachSseConnection(req as any, res as any, { connections, key: 'somekey', maxPerChannel: 5 });
    expect(connections.get('somekey')?.has(res as any)).toBe(true);

    triggerClose();
    expect(connections.get('somekey')).toBeUndefined();
  });

  it('cleans up on a response close event, even if the request never closes', () => {
    const res = makeRes();
    const { req } = makeReq('unused');

    attachSseConnection(req as any, res as any, { connections, key: 'somekey', maxPerChannel: 5 });
    expect(connections.get('somekey')?.has(res as any)).toBe(true);

    res.triggerResClose();
    expect(connections.get('somekey')).toBeUndefined();
  });

  it('cleans up on a response error event, even if the request never closes', () => {
    const res = makeRes();
    const { req } = makeReq('unused');

    attachSseConnection(req as any, res as any, { connections, key: 'somekey', maxPerChannel: 5 });
    expect(connections.get('somekey')?.has(res as any)).toBe(true);

    res.triggerResError();
    expect(connections.get('somekey')).toBeUndefined();
  });

  it('only cleans up once when close and error both fire for the same connection', () => {
    vi.useFakeTimers();
    try {
      const res = makeRes();
      const { req, triggerClose } = makeReq('unused');

      attachSseConnection(req as any, res as any, { connections, key: 'somekey', maxPerChannel: 5 });

      res.triggerResError();
      triggerClose();
      res.triggerResClose();

      // Idempotent cleanup means the keepalive interval was cleared once — advancing time
      // shouldn't produce a further ping write attempt on the already-evicted response.
      res.write.mockClear();
      vi.advanceTimersByTime(25_000);
      expect(res.write).not.toHaveBeenCalled();
      expect(connections.get('somekey')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('runs cleanup and rethrows when sending the handshake throws (e.g. a dead socket)', () => {
    const res = makeRes();
    res.flushHeaders.mockImplementation(() => { throw new Error('socket hang up'); });
    const { req } = makeReq('unused');

    expect(() =>
      attachSseConnection(req as any, res as any, { connections, key: 'somekey', maxPerChannel: 5 }),
    ).toThrow('socket hang up');

    // Cleanup ran even though close/error never fired — the connection isn't left registered.
    expect(connections.get('somekey')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// createStreamerSseEventsHandler
// ---------------------------------------------------------------------------
describe('createStreamerSseEventsHandler', () => {
  const numericConnections = new Map<number, Set<any>>();

  beforeEach(() => {
    numericConnections.clear();
    vi.mocked(getSessionUser).mockReturnValue({ discordId: 'discord1' } as any);
  });

  function buildStreamerHandler(maxPerChannel = 10) {
    return createStreamerSseEventsHandler({
      connections: numericConnections, maxPerChannel, resolveKey: (streamer) => streamer.id, log,
    });
  }

  it('returns 403 when the session user has no streamer row', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(null);
    const handler = buildStreamerHandler();
    const res = makeRes();
    const { req } = makeReq('unused');

    await handler(req as any, res as any);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(numericConnections.size).toBe(0);
  });

  it('returns 500 and logs when the streamer lookup rejects', async () => {
    vi.mocked(getStreamerByDiscordId).mockRejectedValue(new Error('db down'));
    const handler = buildStreamerHandler();
    const res = makeRes();
    const { req } = makeReq('unused');

    await handler(req as any, res as any);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(log.error).toHaveBeenCalled();
  });

  it('attaches the connection under the key derived by resolveKey', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue({ id: 42 } as any);
    const handler = buildStreamerHandler();
    const res = makeRes();
    const { req, triggerClose } = makeReq('unused');

    await handler(req as any, res as any);

    expect(numericConnections.get(42)?.has(res as any)).toBe(true);
    expect(res.write).toHaveBeenCalledWith(': connected\n\n');
    triggerClose();
  });

  it('returns 429 when the resolved streamer is already at its connection limit', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue({ id: 42 } as any);
    numericConnections.set(42, new Set([{}, {}] as any));
    const handler = buildStreamerHandler(2);
    const res = makeRes();
    const { req } = makeReq('unused');

    await handler(req as any, res as any);

    expect(res.status).toHaveBeenCalledWith(429);
  });
});

// ---------------------------------------------------------------------------
// createOverlayStatusEventsHandler
// ---------------------------------------------------------------------------
describe('createOverlayStatusEventsHandler', () => {
  const statusConnections = new Map<number, Set<any>>();
  const overlayConnections = new Map<string, Set<any>>();

  beforeEach(() => {
    statusConnections.clear();
    overlayConnections.clear();
    vi.mocked(getSessionUser).mockReturnValue({ discordId: 'discord1' } as any);
    vi.mocked(getStreamerByDiscordId).mockResolvedValue({ id: 7, twitch_name: 'somestreamer' } as any);
  });

  function buildOverlayStatusHandler(pollIntervalMs = 3000, maxPerChannel = 10) {
    return createOverlayStatusEventsHandler({
      statusConnections, overlayConnections, maxPerChannel, pollIntervalMs, log,
    });
  }

  it('returns 403 when the streamer has no linked Twitch channel', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue({ id: 7, twitch_name: null } as any);
    const handler = buildOverlayStatusHandler();
    const res = makeRes();
    const { req } = makeReq('unused');

    await handler(req as any, res as any);

    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('clears the poll interval when the response closes without the request ever closing', async () => {
    vi.useFakeTimers();
    try {
      const handler = buildOverlayStatusHandler();
      const res = makeRes();
      const { req } = makeReq('unused');

      await handler(req as any, res as any);
      res.write.mockClear();
      res.triggerResClose(); // an abrupt socket failure — req never fires 'close'

      overlayConnections.set('somestreamer', new Set([{} as any]));
      vi.advanceTimersByTime(10_000);

      expect(res.write).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the poll interval when the very first status write fails, before any state change', async () => {
    vi.useFakeTimers();
    try {
      const handler = buildOverlayStatusHandler();
      const res = makeRes();
      let writeCount = 0;
      res.write.mockImplementation(() => {
        writeCount++;
        // 1st write is the SSE handshake (': connected\n\n'); 2nd is the initial check()'s
        // broadcast, fired synchronously inside the handler before the interval/wrapper race
        // could otherwise leave nothing owning this interval's cleanup.
        if (writeCount === 2) throw new Error('write failed');
      });
      const { req } = makeReq('unused');

      await handler(req as any, res as any);

      expect(statusConnections.has(7)).toBe(false);

      res.write.mockClear();
      overlayConnections.set('somestreamer', new Set([{} as any]));
      vi.advanceTimersByTime(10_000);

      expect(res.write).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the poll interval when a broadcast write fails, with no close/error event ever emitted', async () => {
    vi.useFakeTimers();
    try {
      const handler = buildOverlayStatusHandler();
      const res = makeRes();
      const { req } = makeReq('unused');

      await handler(req as any, res as any);
      expect(statusConnections.get(7)?.has(res as any)).toBe(true);

      // Simulate broadcastToChannel's write failing on the next state-change push — this evicts
      // the response via attachSseConnection's own cleanup, without ever firing 'close'/'error'.
      res.write.mockImplementationOnce(() => { throw new Error('write failed'); });
      overlayConnections.set('somestreamer', new Set([{} as any]));
      vi.advanceTimersByTime(3000);

      expect(statusConnections.has(7)).toBe(false);

      res.write.mockClear();
      overlayConnections.delete('somestreamer');
      vi.advanceTimersByTime(10_000);

      expect(res.write).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the poll interval when the response errors without the request ever closing', async () => {
    vi.useFakeTimers();
    try {
      const handler = buildOverlayStatusHandler();
      const res = makeRes();
      const { req } = makeReq('unused');

      await handler(req as any, res as any);
      res.write.mockClear();
      res.triggerResError();

      overlayConnections.set('somestreamer', new Set([{} as any]));
      vi.advanceTimersByTime(10_000);

      expect(res.write).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Process-wide SSE connection cap (SSE_MAX_TOTAL_CONNECTIONS, mocked to 10 above)
// ---------------------------------------------------------------------------
describe('attachSseConnection — process-wide connection cap', () => {
  it('rejects with 429 once the process-wide cap is reached, even under distinct keys well under their own maxPerChannel', () => {
    const opened: Array<() => void> = [];
    for (let i = 0; i < 10; i++) {
      const res = makeRes();
      const { req, triggerClose } = makeReq('unused');
      const attached = attachSseConnection(req as any, res as any, { connections, key: `key-${i}`, maxPerChannel: 100 });
      expect(attached).toBe(true);
      opened.push(triggerClose);
    }

    const overflowRes = makeRes();
    const { req: overflowReq } = makeReq('unused');
    const attached = attachSseConnection(overflowReq as any, overflowRes as any, { connections, key: 'key-overflow', maxPerChannel: 100 });

    expect(attached).toBe(false);
    expect(overflowRes.status).toHaveBeenCalledWith(429);
    expect(connections.get('key-overflow')).toBeUndefined();

    opened.forEach((close) => close());
  });

  it('frees a slot when a connection cleans up, allowing a new one to attach', () => {
    const opened: Array<() => void> = [];
    for (let i = 0; i < 10; i++) {
      const res = makeRes();
      const { req, triggerClose } = makeReq('unused');
      attachSseConnection(req as any, res as any, { connections, key: `key-${i}`, maxPerChannel: 100 });
      opened.push(triggerClose);
    }

    opened[0]!();

    const res = makeRes();
    const { req, triggerClose } = makeReq('unused');
    const attached = attachSseConnection(req as any, res as any, { connections, key: 'key-new', maxPerChannel: 100 });

    expect(attached).toBe(true);
    triggerClose();
    opened.slice(1).forEach((close) => close());
  });

  it('releases its process-wide connection slot when the handshake throws, instead of leaking it', () => {
    const badRes = makeRes();
    badRes.flushHeaders.mockImplementation(() => { throw new Error('dead socket'); });
    const { req: badReq } = makeReq('unused');

    expect(() =>
      attachSseConnection(badReq as any, badRes as any, { connections, key: 'bad', maxPerChannel: 100 }),
    ).toThrow();

    // If the failed handshake had leaked its slot, only 9 of these would fit under the
    // process-wide cap of 10 (mocked at the top of this file).
    const opened: Array<() => void> = [];
    for (let i = 0; i < 10; i++) {
      const res = makeRes();
      const { req, triggerClose } = makeReq('unused');
      const attached = attachSseConnection(req as any, res as any, { connections, key: `key-${i}`, maxPerChannel: 100 });
      expect(attached).toBe(true);
      opened.push(triggerClose);
    }

    opened.forEach((close) => close());
  });
});

// ---------------------------------------------------------------------------
// broadcastToChannel
// ---------------------------------------------------------------------------
describe('broadcastToChannel', () => {
  it('returns null and writes nothing when no clients are connected under the key', () => {
    const result = broadcastToChannel(connections, 'nobody', { hello: 'world' });
    expect(result).toBeNull();
  });

  it('writes the JSON-serialized payload as an SSE data frame to every connected client', () => {
    const res1 = makeRes();
    const res2 = makeRes();
    connections.set('somekey', new Set([res1 as any, res2 as any]));

    const result = broadcastToChannel(connections, 'somekey', { hello: 'world' });

    expect(result).toBe(2);
    expect(res1.write).toHaveBeenCalledWith('data: {"hello":"world"}\n\n');
    expect(res2.write).toHaveBeenCalledWith('data: {"hello":"world"}\n\n');
  });

  it('evicts a client whose write fails and returns the remaining count', () => {
    const good = makeRes();
    const dead = makeRes();
    dead.write.mockImplementation(() => { throw new Error('broken pipe'); });
    connections.set('somekey', new Set([good as any, dead as any]));

    const result = broadcastToChannel(connections, 'somekey', { x: 1 });

    expect(result).toBe(1);
    expect(connections.get('somekey')?.has(dead as any)).toBe(false);
    expect(connections.get('somekey')?.has(good as any)).toBe(true);
  });

  it('deletes the map entry and returns 0 when every client fails to write', () => {
    const dead = makeRes();
    dead.write.mockImplementation(() => { throw new Error('broken pipe'); });
    connections.set('somekey', new Set([dead as any]));

    const result = broadcastToChannel(connections, 'somekey', { x: 1 });

    expect(result).toBe(0);
    expect(connections.has('somekey')).toBe(false);
  });

  it('clears the keepalive interval for a client registered via attachSseConnection whose broadcast write fails', () => {
    vi.useFakeTimers();
    try {
      const res = makeRes();
      const { req } = makeReq('unused');
      attachSseConnection(req as any, res as any, { connections, key: 'somekey', maxPerChannel: 5 });

      res.write.mockImplementation(() => { throw new Error('broken pipe'); });
      const result = broadcastToChannel(connections, 'somekey', { x: 1 });

      expect(result).toBe(0);
      expect(connections.has('somekey')).toBe(false);

      // If the keepalive interval hadn't been cleared by the broadcast-triggered cleanup, the
      // next tick would attempt another write on this already-evicted response.
      res.write.mockClear();
      vi.advanceTimersByTime(25_000);
      expect(res.write).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('frees a process-wide connection slot immediately on a failed broadcast write, not just on the next keepalive tick', () => {
    const opened: Array<() => void> = [];
    for (let i = 0; i < 9; i++) {
      const res = makeRes();
      const { req, triggerClose } = makeReq('unused');
      attachSseConnection(req as any, res as any, { connections, key: `key-${i}`, maxPerChannel: 100 });
      opened.push(triggerClose);
    }

    const deadRes = makeRes();
    const { req: deadReq } = makeReq('unused');
    attachSseConnection(deadReq as any, deadRes as any, { connections, key: 'dead', maxPerChannel: 100 });
    // 10 connections now open, at the process-wide cap of 10 (mocked at the top of this file).

    deadRes.write.mockImplementation(() => { throw new Error('broken pipe'); });
    broadcastToChannel(connections, 'dead', { x: 1 });

    // The cap should already have room again, without waiting on a keepalive tick.
    const res = makeRes();
    const { req, triggerClose } = makeReq('unused');
    const attached = attachSseConnection(req as any, res as any, { connections, key: 'new', maxPerChannel: 100 });

    expect(attached).toBe(true);
    triggerClose();
    opened.forEach((close) => close());
  });
});

describe('tryReservePoolSlot / releasePoolSlot', () => {
  const reqFrom = (ip: string) => ({ ip, socket: { remoteAddress: ip } }) as any;

  it('reserves under the pool and per-IP limits and releases back to empty', () => {
    const pool = createSseConnectionPool(3, 2);
    const ip = tryReservePoolSlot(pool, reqFrom('1.1.1.1'));
    expect(ip).not.toBeNull();
    expect(tryReservePoolSlot(pool, reqFrom('1.1.1.1'))).not.toBeNull();
    expect(tryReservePoolSlot(pool, reqFrom('1.1.1.1'))).toBeNull(); // per-IP limit
    expect(tryReservePoolSlot(pool, reqFrom('2.2.2.2'))).not.toBeNull();
    expect(tryReservePoolSlot(pool, reqFrom('3.3.3.3'))).toBeNull(); // pool limit
    expect(pool.count).toBe(3);
    releasePoolSlot(pool, ip!);
    expect(pool.count).toBe(2);
    expect(pool.byIp.get(ip!)).toBe(1);
  });

  it('drops an IP entry once its count reaches zero', () => {
    const pool = createSseConnectionPool(3, 2);
    const ip = tryReservePoolSlot(pool, reqFrom('1.1.1.1'))!;
    releasePoolSlot(pool, ip);
    expect(pool.byIp.has(ip)).toBe(false);
    expect(pool.count).toBe(0);
  });
});

describe('chainConnectionCleanup', () => {
  it('returns false and chains nothing for a response that was never attached', () => {
    const extra = vi.fn();
    expect(chainConnectionCleanup(makeRes() as any, extra)).toBe(false);
    expect(extra).not.toHaveBeenCalled();
  });

  it('runs the extra teardown once when a failed broadcast evicts the connection', () => {
    const connections = new Map<string, Set<any>>();
    const { req } = makeReq('k');
    const res = makeRes() as any;
    attachSseConnection(req as any, res, { connections, key: 'k', maxPerChannel: 5 });
    const extra = vi.fn();
    expect(chainConnectionCleanup(res, extra)).toBe(true);
    res.write.mockImplementation(() => { throw new Error('socket gone'); });
    broadcastToChannel(connections, 'k', { hi: 1 });
    expect(extra).toHaveBeenCalledTimes(1);
    expect(connections.has('k')).toBe(false);
  });
});
