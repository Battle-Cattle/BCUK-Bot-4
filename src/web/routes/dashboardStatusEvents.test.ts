import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../shared/config', () => ({
  DASHBOARD_STATUS_MAX_SSE_PER_GUILD: 5,
  SSE_MAX_TOTAL_CONNECTIONS: 1000,
}));

vi.mock('../../shared/statusStore', () => ({
  getStatus: vi.fn(),
  onStatusChanged: vi.fn(),
}));

import supertest from 'supertest';
import router, { MAX_SSE_CONNECTIONS_PER_GUILD, connections } from './dashboardStatusEvents';
import { getStatus, onStatusChanged } from '../../shared/statusStore';
import { buildTestApp } from '../../test-utils/expressTestApp';

// Captured immediately after import, before any beforeEach's clearAllMocks() erases the
// one-time module-load call — dashboardStatusEvents.ts registers this listener as a
// top-level side effect, not per-request, so it's only ever recorded once.
const registeredListener = vi.mocked(onStatusChanged).mock.calls[0]?.[0] as (guildId: string | null) => void;

/** Finds a route's handler function directly from the router's internal stack, bypassing HTTP entirely — needed to control the request's 'close' event deterministically. */
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

/** Builds a fake Express `req` with a session for `currentGuildId` and a `close`-event hook, plus a `triggerClose()` helper to simulate the client disconnecting. */
function makeSseReq(currentGuildId: string | undefined) {
  let closeCb: (() => void) | undefined;
  return {
    req: {
      session: { user: { discordId: 'discord1', currentGuildId } },
      on: (event: string, cb: () => void) => {
        if (event === 'close') closeCb = cb;
      },
    },
    triggerClose: () => closeCb?.(),
  };
}

/** Builds a supertest-ready app: the dashboard-status-events router with a stubbed session user. Pass `undefined` to simulate no guild selected. */
function buildApp(currentGuildId: string | undefined) {
  return buildTestApp({ router, sessionUser: { discordId: 'discord1', currentGuildId } });
}

beforeEach(() => {
  connections.clear();
  vi.clearAllMocks();
});

describe('MAX_SSE_CONNECTIONS_PER_GUILD', () => {
  it('re-exports the value from config', () => {
    expect(MAX_SSE_CONNECTIONS_PER_GUILD).toBe(5);
  });
});

describe('GET /status/events — auth', () => {
  it('returns 400 when no guild is selected', async () => {
    const res = await supertest(buildApp(undefined)).get('/status/events');
    expect(res.status).toBe(400);
  });
});

describe('GET /status/events — SSE connection limit', () => {
  it('returns 429 when the guild slot is full', async () => {
    const dummies = new Set(
      Array.from({ length: MAX_SSE_CONNECTIONS_PER_GUILD }, () => ({}) as any),
    );
    connections.set('guild-A', dummies);

    const res = await supertest(buildApp('guild-A')).get('/status/events');
    expect(res.status).toBe(429);
  });

  it('accepts a connection when the guild is below the limit', async () => {
    const dummies = new Set(
      Array.from({ length: MAX_SSE_CONNECTIONS_PER_GUILD - 1 }, () => ({}) as any),
    );
    connections.set('guild-A', dummies);

    const handler = getRouteHandler('/status/events');
    const res = makeSseRes();
    const { req, triggerClose } = makeSseReq('guild-A');

    await handler(req, res, vi.fn());

    expect(res.status).not.toHaveBeenCalledWith(429);
    expect(connections.get('guild-A')?.has(res as any)).toBe(true);

    triggerClose(); // clears the 25s keepalive interval so it doesn't leak into other tests
  });
});

describe('GET /status/events — connection lifecycle (direct handler invocation)', () => {
  it('registers a new Set for a guild with no prior connections', async () => {
    const handler = getRouteHandler('/status/events');
    const res = makeSseRes();
    const { req, triggerClose } = makeSseReq('guild-A');

    await handler(req, res, vi.fn());

    expect(connections.get('guild-A')?.has(res as any)).toBe(true);
    expect(res.write).toHaveBeenCalledWith(': connected\n\n');

    triggerClose(); // clears the 25s keepalive interval so it doesn't leak into other tests
  });

  it('removes the client (and empty Set) when the request closes', async () => {
    const handler = getRouteHandler('/status/events');
    const res = makeSseRes();
    const { req, triggerClose } = makeSseReq('guild-A');

    await handler(req, res, vi.fn());
    expect(connections.get('guild-A')?.has(res as any)).toBe(true);

    triggerClose();
    expect(connections.get('guild-A')).toBeUndefined();
  });
});

describe('status-change push (registered via onStatusChanged)', () => {
  it('registered a listener at module load', () => {
    expect(typeof registeredListener).toBe('function');
  });

  it('pushes a guild-scoped snapshot to only that guild when guildId is given', () => {
    const resA = { write: vi.fn() };
    const resB = { write: vi.fn() };
    connections.set('guild-A', new Set([resA] as any));
    connections.set('guild-B', new Set([resB] as any));
    vi.mocked(getStatus).mockImplementation((guildId) => ({ guildId }) as any);

    registeredListener('guild-A');

    expect(getStatus).toHaveBeenCalledWith('guild-A');
    expect(getStatus).not.toHaveBeenCalledWith('guild-B');
    expect(resA.write).toHaveBeenCalledWith(`data: ${JSON.stringify({ guildId: 'guild-A' })}\n\n`);
    expect(resB.write).not.toHaveBeenCalled();
  });

  it('pushes an individually-scoped snapshot to every connected guild when guildId is null', () => {
    const resA = { write: vi.fn() };
    const resB = { write: vi.fn() };
    connections.set('guild-A', new Set([resA] as any));
    connections.set('guild-B', new Set([resB] as any));
    vi.mocked(getStatus).mockImplementation((guildId) => ({ guildId }) as any);

    registeredListener(null);

    expect(getStatus).toHaveBeenCalledWith('guild-A');
    expect(getStatus).toHaveBeenCalledWith('guild-B');
    expect(resA.write).toHaveBeenCalledWith(`data: ${JSON.stringify({ guildId: 'guild-A' })}\n\n`);
    expect(resB.write).toHaveBeenCalledWith(`data: ${JSON.stringify({ guildId: 'guild-B' })}\n\n`);
  });

  it('does nothing when guildId is null and there are no connected guilds', () => {
    registeredListener(null);
    expect(getStatus).not.toHaveBeenCalled();
  });
});
