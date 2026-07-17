import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../../test-utils/loggerMock';

vi.mock('../../db', () => ({
  getStreamerByDiscordId: vi.fn(),
  getRecentStreamerEvents: vi.fn(),
}));

vi.mock('../../shared/config', () => ({
  DASHBOARD_EVENTS_MAX_SSE_PER_STREAMER: 5,
  SSE_MAX_TOTAL_CONNECTIONS: 1000,
}));

vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));

import express from 'express';
import supertest from 'supertest';
import router, { MAX_SSE_CONNECTIONS_PER_STREAMER, RECENT_EVENTS_LIMIT, connections, pushDashboardEvent } from './dashboardEvents';
import { getStreamerByDiscordId, getRecentStreamerEvents } from '../../db';
import { buildTestApp } from '../../test-utils/expressTestApp';

/** Finds a route's handler function directly from the router's internal stack, bypassing HTTP entirely — needed to control fake timers and the request's 'close' event deterministically. */
function getRouteHandler(routePath: string): (req: any, res: any, next: any) => void {
  const layer = (router as any).stack.find((l: any) => l.route?.path === routePath);
  return layer.route.stack[0].handle;
}

/** Builds a fake Express `res` covering the SSE-specific methods (`setHeader`, `flushHeaders`, `write`, `end`) used by the events route handler. */
function makeSseRes() {
  return {
    setHeader: vi.fn(),
    flushHeaders: vi.fn(),
    write: vi.fn(),
    status: vi.fn().mockReturnThis(),
    end: vi.fn(),
    on: vi.fn(),
  };
}

/** Builds a fake Express `req` with a session for `discordId` and a `close`-event hook, plus a `triggerClose()` helper to simulate the client disconnecting. */
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

/** Builds a supertest-ready app: the dashboard-events router with a stubbed session user. */
function buildApp() {
  return buildTestApp({ router, sessionUser: { discordId: 'discord1' } });
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

  it('removes the client (and empty Set) when the request closes', async () => {
    const handler = getRouteHandler('/events');
    const res = makeSseRes();
    const { req, triggerClose } = makeSseReq('discord1');

    await handler(req, res, vi.fn());
    expect(connections.get(123)?.has(res as any)).toBe(true);

    triggerClose();
    expect(connections.get(123)).toBeUndefined();
  });
});

describe('GET /events/recent', () => {
  it('returns 403 when the session user has no streamer row', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(null);
    const res = await supertest(buildApp()).get('/events/recent');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ ok: false });
  });

  it('returns 500 (and logs) when getStreamerByDiscordId rejects', async () => {
    vi.mocked(getStreamerByDiscordId).mockRejectedValue(new Error('db down'));
    const res = await supertest(buildApp()).get('/events/recent');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false });
  });

  it('returns 500 with the same JSON error contract (and logs) when getRecentStreamerEvents rejects', async () => {
    vi.mocked(getRecentStreamerEvents).mockRejectedValue(new Error('db down'));
    const res = await supertest(buildApp()).get('/events/recent');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false });
  });

  it('returns the mapped recent events for the resolved streamer', async () => {
    const occurredAt = new Date('2026-07-17T12:00:00Z');
    vi.mocked(getRecentStreamerEvents).mockResolvedValue([
      { eventType: 'raid', displayName: 'raider1', detail: '12 viewers', occurredAt },
    ]);

    const res = await supertest(buildApp()).get('/events/recent');

    expect(res.status).toBe(200);
    expect(getRecentStreamerEvents).toHaveBeenCalledWith(123, RECENT_EVENTS_LIMIT);
    expect(res.body).toEqual({
      ok: true,
      events: [{ eventType: 'raid', displayName: 'raider1', detail: '12 viewers', occurredAt: occurredAt.toISOString() }],
    });
  });

  it('returns an empty events array when the streamer has no recent activity', async () => {
    vi.mocked(getRecentStreamerEvents).mockResolvedValue([]);
    const res = await supertest(buildApp()).get('/events/recent');
    expect(res.body).toEqual({ ok: true, events: [] });
  });
});

describe('pushDashboardEvent', () => {
  const sample = { eventType: 'follow' as const, displayName: 'someviewer', detail: null, occurredAt: '2026-07-17T12:00:00.000Z' };

  it('does nothing when there are no connections for the streamer', () => {
    expect(() => pushDashboardEvent(999, sample)).not.toThrow();
  });

  it('writes the event payload to every connected client', () => {
    const res1 = { write: vi.fn() };
    const res2 = { write: vi.fn() };
    connections.set(123, new Set([res1, res2] as any));

    pushDashboardEvent(123, sample);

    const expectedPayload = `data: ${JSON.stringify(sample)}\n\n`;
    expect(res1.write).toHaveBeenCalledWith(expectedPayload);
    expect(res2.write).toHaveBeenCalledWith(expectedPayload);
  });

  it('drops a client whose write throws but keeps the others', () => {
    const good = { write: vi.fn() };
    const dead = { write: vi.fn(() => { throw new Error('broken pipe'); }) };
    connections.set(123, new Set([good, dead] as any));

    pushDashboardEvent(123, sample);

    const clients = connections.get(123);
    expect(clients?.has(good as any)).toBe(true);
    expect(clients?.has(dead as any)).toBe(false);
  });
});
