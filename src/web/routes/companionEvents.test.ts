import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../../test-utils/loggerMock';

vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));

// Stub auth: tests drive it via the `x-test-discord-id` header instead of a real token,
// so SSE route behaviour can be exercised without re-testing requireCompanionKey itself
// (that's covered in middleware.test.ts).
vi.mock('../../shared/config', () => ({
  COMPANION_MAX_SSE_PER_TOKEN: 3,
  SSE_MAX_TOTAL_CONNECTIONS: 1000,
  // dashboardEvents.ts (imported here only for its RECENT_EVENTS_LIMIT constant) reads this
  // at module load time too.
  DASHBOARD_EVENTS_MAX_SSE_PER_STREAMER: 5,
}));

vi.mock('../middleware', () => ({
  requireCompanionKey: (req: any, res: any, next: any) => {
    const id = req.headers['x-test-discord-id'];
    if (!id) {
      res.status(401).json({ ok: false, error: 'Unauthorized' });
      return;
    }
    req.companionDiscordId = id;
    next();
  },
}));

vi.mock('../../db', () => ({
  getStreamerByDiscordId: vi.fn(),
  getRecentStreamerEvents: vi.fn(),
  getTokenStatus: vi.fn(),
}));

import supertest from 'supertest';
import router, {
  pushCompanionEvent, disconnectCompanionConnections, MAX_SSE_CONNECTIONS_PER_TOKEN, connections, type CompanionEvent,
} from './companionEvents';
import { RECENT_EVENTS_LIMIT } from './dashboardEvents';
import { getStreamerByDiscordId, getRecentStreamerEvents, getTokenStatus } from '../../db';
import { buildTestApp } from '../../test-utils/expressTestApp';

/** Builds a supertest-ready app: the companion events router with no body parser or session stub (auth is driven via a test header, see requireCompanionKey mock above). */
function buildApp() {
  return buildTestApp({ router });
}

const sampleEvent: CompanionEvent = {
  type: 'channel_points_redemption',
  rewardId: 'r1',
  rewardTitle: 'Test Reward',
  userLogin: 'viewer1',
  userName: 'Viewer1',
  userInput: '',
  redeemedAt: new Date().toISOString(),
};

beforeEach(() => {
  connections.clear();
  vi.clearAllMocks();
  vi.mocked(getTokenStatus).mockResolvedValue({ hasToken: true, createdAt: new Date() });
});

describe('GET /events — auth', () => {
  it('returns 401 when no token-derived discord ID is present', async () => {
    const res = await supertest(buildApp()).get('/events');
    expect(res.status).toBe(401);
  });
});

describe('GET /events — connection limit', () => {
  it('returns 429 when the per-token slot is full', async () => {
    const dummies = new Set(Array.from({ length: MAX_SSE_CONNECTIONS_PER_TOKEN }, () => ({}) as any));
    connections.set('user1', dummies);

    const res = await supertest(buildApp()).get('/events').set('x-test-discord-id', 'user1');
    expect(res.status).toBe(429);
  });

  it('accepts a connection when below the limit', async () => {
    const req = supertest(buildApp()).get('/events').set('x-test-discord-id', 'user1');
    const p = new Promise<{ status: number; close: () => void }>((resolve) => {
      req
        .buffer(false)
        .parse((_res, _cb) => {
          resolve({ status: _res.statusCode ?? 0, close: () => (_res as any).req.emit('close') });
          (_res as any).resume();
        })
        .end();
    });
    const { status, close } = await p;
    expect(status).toBe(200);
    close();
  });
});

describe('GET /events — keepalive ping and connection close cleanup', () => {
  /**
   * Opens an SSE connection and resolves once headers arrive, leaving the stream open.
   * @param discordId - Value sent via the `x-test-discord-id` header to drive the stubbed auth.
   * @returns The response status plus a `close()` callback that emits `'close'` on the
   * underlying request, so tests can release the connection (and its keepalive interval)
   * instead of leaving it open for the rest of the suite.
   */
  function connect(discordId: string) {
    const req = supertest(buildApp()).get('/events').set('x-test-discord-id', discordId);
    return new Promise<{ status: number; close: () => void }>((resolve) => {
      req
        .buffer(false)
        .parse((_res, _cb) => {
          resolve({ status: _res.statusCode ?? 0, close: () => (_res as any).req.emit('close') });
          (_res as any).resume();
        })
        .end();
    });
  }

  it('clears the interval and drops the connection when a keepalive ping write throws', async () => {
    const setIntervalSpy = vi.spyOn(global, 'setInterval');

    const { status } = await connect('user1');
    expect(status).toBe(200);

    const keepaliveCallback = setIntervalSpy.mock.calls[0][0] as () => void;
    const [res] = Array.from(connections.get('user1')!);
    res.write = vi.fn(() => {
      throw new Error('client gone');
    });

    keepaliveCallback();

    expect(connections.has('user1')).toBe(false);
  });

  it('leaves other connections for the same discord ID intact when only one ping fails', async () => {
    const setIntervalSpy = vi.spyOn(global, 'setInterval');

    const { status: status1 } = await connect('user1');
    expect(status1).toBe(200);
    const keepaliveCallback1 = setIntervalSpy.mock.calls[0][0] as () => void;
    const [deadRes] = Array.from(connections.get('user1')!);
    deadRes.write = vi.fn(() => {
      throw new Error('client gone');
    });

    const { status: status2, close: close2 } = await connect('user1');
    expect(status2).toBe(200);

    keepaliveCallback1();

    const remaining = connections.get('user1');
    expect(remaining?.has(deadRes)).toBe(false);
    expect(remaining?.size).toBe(1);

    close2();
  });

  it('removes the connection when the underlying request closes', async () => {
    const { status } = await connect('user1');
    expect(status).toBe(200);
    expect(connections.has('user1')).toBe(true);

    const [res] = Array.from(connections.get('user1')!);
    (res.req as any).emit('close');

    expect(connections.has('user1')).toBe(false);
  });

  it('does nothing on close if the discord ID has already been removed from the map', async () => {
    const { status } = await connect('user1');
    expect(status).toBe(200);

    const [res] = Array.from(connections.get('user1')!);
    connections.delete('user1');

    expect(() => (res.req as any).emit('close')).not.toThrow();
    expect(connections.has('user1')).toBe(false);
  });
});

describe('GET /events — post-connect token re-check', () => {
  /**
   * Extracts the `/events` route's actual handler (the last middleware in its stack, after
   * `requireCompanionKey`) so it can be invoked directly with fully-controlled mock req/res —
   * avoids real-socket timing around the async post-connect `getTokenStatus` re-check.
   */
  function getEventsHandler(): (req: any, res: any) => Promise<void> {
    const layer = (router as any).stack.find((l: any) => l.route?.path === '/events');
    const handlers = layer.route.stack;
    return handlers[handlers.length - 1].handle;
  }

  /** Builds a fake Express `res` covering the SSE-specific methods the route handler uses. */
  function makeSseRes() {
    return {
      setHeader: vi.fn(),
      flushHeaders: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
      status: vi.fn().mockReturnThis(),
      on: vi.fn(),
    };
  }

  /** Builds a fake Express `req` with a `close`-event hook, plus a `triggerClose()` helper. */
  function makeSseReq(discordId: string) {
    let closeCb: (() => void) | undefined;
    return {
      req: {
        companionDiscordId: discordId,
        on: (event: string, cb: () => void) => {
          if (event === 'close') closeCb = cb;
        },
      },
      triggerClose: () => closeCb?.(),
    };
  }

  it('leaves the connection open when the token is still active', async () => {
    vi.mocked(getTokenStatus).mockResolvedValue({ hasToken: true, createdAt: new Date() });
    const handler = getEventsHandler();
    const res = makeSseRes();
    const { req, triggerClose } = makeSseReq('user1');

    await handler(req, res);

    expect(getTokenStatus).toHaveBeenCalledWith('user1');
    expect(res.end).not.toHaveBeenCalled();
    expect(connections.get('user1')?.has(res as any)).toBe(true);

    triggerClose();
  });

  it('ends the connection when the token was revoked in the gap between auth and admission', async () => {
    vi.mocked(getTokenStatus).mockResolvedValue({ hasToken: false, createdAt: new Date() });
    const handler = getEventsHandler();
    const res = makeSseRes();
    const { req, triggerClose } = makeSseReq('user1');

    await handler(req, res);

    expect(res.end).toHaveBeenCalled();
    triggerClose(); // clears the 25s keepalive interval so it doesn't leak into other tests — res.end() is mocked here, so it doesn't itself emit 'close'
  });

  it('ends the connection when the token has been deleted entirely', async () => {
    vi.mocked(getTokenStatus).mockResolvedValue(null);
    const handler = getEventsHandler();
    const res = makeSseRes();
    const { req, triggerClose } = makeSseReq('user1');

    await handler(req, res);

    expect(res.end).toHaveBeenCalled();
    triggerClose();
  });

  it('leaves the connection open (logged, not fatal) when the re-check itself fails', async () => {
    vi.mocked(getTokenStatus).mockRejectedValue(new Error('db down'));
    const handler = getEventsHandler();
    const res = makeSseRes();
    const { req, triggerClose } = makeSseReq('user1');

    await expect(handler(req, res)).resolves.toBeUndefined();

    expect(res.end).not.toHaveBeenCalled();
    triggerClose();
  });
});

describe('pushCompanionEvent', () => {
  it('writes the event payload to all connected clients for the given discord ID', () => {
    const res = { write: vi.fn() } as any;
    connections.set('user1', new Set([res]));

    pushCompanionEvent('user1', sampleEvent);

    expect(res.write).toHaveBeenCalledWith(`data: ${JSON.stringify(sampleEvent)}\n\n`);
  });

  it('does not deliver events to a different discord ID', () => {
    const resA = { write: vi.fn() } as any;
    const resB = { write: vi.fn() } as any;
    connections.set('userA', new Set([resA]));
    connections.set('userB', new Set([resB]));

    pushCompanionEvent('userA', sampleEvent);

    expect(resA.write).toHaveBeenCalled();
    expect(resB.write).not.toHaveBeenCalled();
  });

  it('removes dead connections that throw on write', () => {
    const deadRes = { write: vi.fn(() => { throw new Error('client gone'); }) } as any;
    const liveRes = { write: vi.fn() } as any;
    connections.set('user1', new Set([deadRes, liveRes]));

    pushCompanionEvent('user1', sampleEvent);

    expect(connections.get('user1')?.has(deadRes)).toBe(false);
    expect(connections.get('user1')?.has(liveRes)).toBe(true);
  });

  it('removes the discord ID entry entirely once all its connections are dead', () => {
    const deadRes = { write: vi.fn(() => { throw new Error('client gone'); }) } as any;
    connections.set('user1', new Set([deadRes]));

    pushCompanionEvent('user1', sampleEvent);

    expect(connections.has('user1')).toBe(false);
  });

  it('is a no-op when no clients are connected for the discord ID', () => {
    expect(() => pushCompanionEvent('nobody', sampleEvent)).not.toThrow();
  });
});

describe('disconnectCompanionConnections', () => {
  it('ends every open connection for the given discord ID', () => {
    const resA = { end: vi.fn() } as any;
    const resB = { end: vi.fn() } as any;
    connections.set('user1', new Set([resA, resB]));

    disconnectCompanionConnections('user1');

    expect(resA.end).toHaveBeenCalled();
    expect(resB.end).toHaveBeenCalled();
  });

  it('does not end connections for a different discord ID', () => {
    const resA = { end: vi.fn() } as any;
    const resB = { end: vi.fn() } as any;
    connections.set('userA', new Set([resA]));
    connections.set('userB', new Set([resB]));

    disconnectCompanionConnections('userA');

    expect(resA.end).toHaveBeenCalled();
    expect(resB.end).not.toHaveBeenCalled();
  });

  it('is a no-op when no clients are connected for the discord ID', () => {
    expect(() => disconnectCompanionConnections('nobody')).not.toThrow();
  });

  it('logs and continues when one connection throws on end()', () => {
    const throwing = { end: vi.fn(() => { throw new Error('already destroyed'); }) } as any;
    const live = { end: vi.fn() } as any;
    connections.set('user1', new Set([throwing, live]));

    expect(() => disconnectCompanionConnections('user1')).not.toThrow();

    expect(throwing.end).toHaveBeenCalled();
    expect(live.end).toHaveBeenCalled();
  });
});

describe('GET /events/recent', () => {
  it('returns 401 when no token-derived discord ID is present', async () => {
    const res = await supertest(buildApp()).get('/events/recent');
    expect(res.status).toBe(401);
  });

  it('returns an empty events array when the discord ID has no linked streamer', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(null);
    const res = await supertest(buildApp()).get('/events/recent').set('x-test-discord-id', 'user1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, events: [] });
    expect(getRecentStreamerEvents).not.toHaveBeenCalled();
  });

  it('sends Cache-Control: no-store, since the response is identity-scoped activity data', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue({ id: 123 } as any);
    vi.mocked(getRecentStreamerEvents).mockResolvedValue([]);
    const res = await supertest(buildApp()).get('/events/recent').set('x-test-discord-id', 'user1');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('returns 500 (and logs) when getStreamerByDiscordId rejects', async () => {
    vi.mocked(getStreamerByDiscordId).mockRejectedValue(new Error('db down'));
    const res = await supertest(buildApp()).get('/events/recent').set('x-test-discord-id', 'user1');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false });
  });

  it('returns 500 (and logs) when getRecentStreamerEvents rejects', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue({ id: 123 } as any);
    vi.mocked(getRecentStreamerEvents).mockRejectedValue(new Error('db down'));
    const res = await supertest(buildApp()).get('/events/recent').set('x-test-discord-id', 'user1');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false });
  });

  it('returns activity events mapped to the companion shape, filtering out redemption rows', async () => {
    const occurredAt = new Date('2026-07-17T12:00:00Z');
    vi.mocked(getStreamerByDiscordId).mockResolvedValue({ id: 123 } as any);
    vi.mocked(getRecentStreamerEvents).mockResolvedValue([
      { eventType: 'raid', displayName: 'raider1', detail: '12 viewers', occurredAt },
      { eventType: 'redemption', displayName: 'redeemer1', detail: 'Cool Reward', occurredAt },
    ]);

    const res = await supertest(buildApp()).get('/events/recent').set('x-test-discord-id', 'user1');

    expect(res.status).toBe(200);
    expect(getRecentStreamerEvents).toHaveBeenCalledWith(123, RECENT_EVENTS_LIMIT);
    expect(res.body).toEqual({
      ok: true,
      events: [{ type: 'raid', displayName: 'raider1', detail: '12 viewers', occurredAt: occurredAt.toISOString() }],
    });
  });
});
