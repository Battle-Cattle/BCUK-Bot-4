import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../../test-utils/loggerMock';

vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));

// Stub auth: tests drive it via the `x-test-discord-id` header instead of a real token,
// so SSE route behaviour can be exercised without re-testing requireCompanionKey itself
// (that's covered in middleware.test.ts).
vi.mock('../../shared/config', () => ({
  COMPANION_MAX_SSE_PER_TOKEN: 3,
  SSE_MAX_TOTAL_CONNECTIONS: 1000,
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

import supertest from 'supertest';
import router, { pushCompanionEvent, MAX_SSE_CONNECTIONS_PER_TOKEN, connections, type CompanionEvent } from './companionEvents';
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
