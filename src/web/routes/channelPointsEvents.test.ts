import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db', () => ({
  getStreamerByDiscordId: vi.fn(),
}));

vi.mock('../../shared/config', () => ({
  CHANNEL_POINTS_MAX_SSE_PER_STREAMER: 5,
}));

vi.mock('../../shared/logger', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

import express from 'express';
import supertest from 'supertest';
import router, { MAX_SSE_CONNECTIONS_PER_STREAMER, connections, pushPricingUpdate } from './channelPointsEvents';
import { getStreamerByDiscordId } from '../../db';

/** Finds a route's handler function directly from the router's internal stack, bypassing HTTP entirely — needed to control fake timers and the request's 'close' event deterministically. */
function getRouteHandler(routePath: string): (req: any, res: any, next: any) => void {
  const layer = (router as any).stack.find((l: any) => l.route?.path === routePath);
  return layer.route.stack[0].handle;
}

function makeSseRes() {
  return {
    setHeader: vi.fn(),
    flushHeaders: vi.fn(),
    write: vi.fn(),
    status: vi.fn().mockReturnThis(),
    end: vi.fn(),
  };
}

function makeSseReq(discordId: string) {
  let closeCb: (() => void) | undefined;
  return {
    req: {
      session: { user: { discordId } },
      on: (event: string, cb: () => void) => {
        if (event === 'close') closeCb = cb;
      },
    },
    triggerClose: () => closeCb?.(),
  };
}

function buildApp() {
  const app = express();
  app.use((req: any, _res, next) => {
    req.session = { user: { discordId: 'discord1' } };
    next();
  });
  app.use(router);
  return app;
}

beforeEach(() => {
  connections.clear();
  vi.clearAllMocks();
  vi.mocked(getStreamerByDiscordId).mockResolvedValue({ id: 123 } as any);
});

describe('MAX_SSE_CONNECTIONS_PER_STREAMER', () => {
  it('re-exports the value from config', () => {
    expect(MAX_SSE_CONNECTIONS_PER_STREAMER).toBe(5);
  });
});

describe('GET /events — auth', () => {
  it('returns 403 when the session user has no streamer row', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(null);
    const res = await supertest(buildApp()).get('/events');
    expect(res.status).toBe(403);
  });

  it('returns 500 (and logs) instead of crashing when req.session.user is missing', async () => {
    const app = express();
    app.use((req: any, _res, next) => {
      req.session = {}; // no `user` — requireAuth normally guarantees this, but the handler shouldn't crash if it didn't run
      next();
    });
    app.use(router);

    const res = await supertest(app).get('/events');
    expect(res.status).toBe(500);
    expect(getStreamerByDiscordId).not.toHaveBeenCalled();
  });

  it('returns 500 (and logs) when getStreamerByDiscordId rejects', async () => {
    vi.mocked(getStreamerByDiscordId).mockRejectedValue(new Error('db down'));
    const res = await supertest(buildApp()).get('/events');
    expect(res.status).toBe(500);
  });
});

describe('GET /events — SSE connection limit', () => {
  it('returns 429 when the streamer slot is full', async () => {
    const dummies = new Set(
      Array.from({ length: MAX_SSE_CONNECTIONS_PER_STREAMER }, () => ({}) as any),
    );
    connections.set(123, dummies);

    const res = await supertest(buildApp()).get('/events');
    expect(res.status).toBe(429);
  });

  it('accepts a connection when the streamer is below the limit', async () => {
    // Invokes the handler directly (as the lifecycle tests below do) rather than a real
    // supertest round-trip: an open SSE response has no natural end, and destroying the
    // underlying socket to clean up after a real connection raises an unhandled
    // 'aborted'/ECONNRESET error from Node's http internals that a client-side listener
    // can't fully suppress.
    const dummies = new Set(
      Array.from({ length: MAX_SSE_CONNECTIONS_PER_STREAMER - 1 }, () => ({}) as any),
    );
    connections.set(123, dummies);

    const handler = getRouteHandler('/events');
    const res = makeSseRes();
    const { req, triggerClose } = makeSseReq('discord1');

    await handler(req, res, vi.fn());

    expect(res.status).not.toHaveBeenCalledWith(429);
    expect(connections.get(123)?.has(res as any)).toBe(true);

    triggerClose(); // clears the 25s keepalive interval so it doesn't leak into other tests
  });
});

describe('GET /events — connection lifecycle (direct handler invocation)', () => {
  it('registers a new Set for a streamer with no prior connections', async () => {
    const handler = getRouteHandler('/events');
    const res = makeSseRes();
    const { req, triggerClose } = makeSseReq('discord1');

    await handler(req, res, vi.fn());

    expect(connections.get(123)?.has(res as any)).toBe(true);
    expect(res.write).toHaveBeenCalledWith(': connected\n\n');

    triggerClose(); // clears the 25s keepalive interval so it doesn't leak into other tests
  });

  it('sends a ping every 25 seconds', async () => {
    vi.useFakeTimers();
    try {
      const handler = getRouteHandler('/events');
      const res = makeSseRes();
      const { req, triggerClose } = makeSseReq('discord1');

      await handler(req, res, vi.fn());
      res.write.mockClear();

      vi.advanceTimersByTime(25_000);
      expect(res.write).toHaveBeenCalledWith(': ping\n\n');
      triggerClose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the interval and evicts the client when a ping write fails', async () => {
    vi.useFakeTimers();
    try {
      const handler = getRouteHandler('/events');
      const res = makeSseRes();
      const { req } = makeSseReq('discord1');

      await handler(req, res, vi.fn());
      res.write.mockImplementation(() => {
        throw new Error('broken pipe');
      });

      vi.advanceTimersByTime(25_000);

      expect(connections.get(123)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('removes the client (and empty Set) when the request closes', async () => {
    const handler = getRouteHandler('/events');
    const res = makeSseRes();
    const { req, triggerClose } = makeSseReq('discord1');

    await handler(req, res, vi.fn());
    expect(connections.get(123)?.has(res as any)).toBe(true);

    triggerClose();
    expect(connections.get(123)).toBeUndefined();
  });

  it('removes only the closing client, keeping the streamer entry when others remain', async () => {
    const handler = getRouteHandler('/events');
    const res1 = makeSseRes();
    const res2 = makeSseRes();
    const { req: req1, triggerClose: closeReq1 } = makeSseReq('discord1');
    const { req: req2 } = makeSseReq('discord1');

    await handler(req1, res1, vi.fn());
    await handler(req2, res2, vi.fn());

    closeReq1();
    expect(connections.get(123)?.has(res1 as any)).toBe(false);
    expect(connections.get(123)?.has(res2 as any)).toBe(true);
  });
});

describe('pushPricingUpdate', () => {
  const sample = { rewardId: 'rwd1', cost: 500, demand: 0.5, recordedAt: 1_700_000_000_000 };

  it('does nothing when there are no connections for the streamer', () => {
    expect(() => pushPricingUpdate(999, sample)).not.toThrow();
  });

  it('writes the update payload to every connected client', () => {
    const res1 = { write: vi.fn() };
    const res2 = { write: vi.fn() };
    connections.set(123, new Set([res1, res2] as any));

    pushPricingUpdate(123, sample);

    const expectedPayload = `data: ${JSON.stringify(sample)}\n\n`;
    expect(res1.write).toHaveBeenCalledWith(expectedPayload);
    expect(res2.write).toHaveBeenCalledWith(expectedPayload);
  });

  it('drops a client whose write throws but keeps the others', () => {
    const good = { write: vi.fn() };
    const dead = { write: vi.fn(() => { throw new Error('broken pipe'); }) };
    connections.set(123, new Set([good, dead] as any));

    pushPricingUpdate(123, sample);

    const clients = connections.get(123);
    expect(clients?.has(good as any)).toBe(true);
    expect(clients?.has(dead as any)).toBe(false);
  });

  it('deletes the map entry once every client has been dropped', () => {
    const dead = { write: vi.fn(() => { throw new Error('broken pipe'); }) };
    connections.set(123, new Set([dead] as any));

    pushPricingUpdate(123, sample);

    expect(connections.has(123)).toBe(false);
  });
});
