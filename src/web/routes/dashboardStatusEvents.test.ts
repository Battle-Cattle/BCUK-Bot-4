import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../shared/config', () => ({
  DASHBOARD_STATUS_MAX_SSE_PER_GUILD: 5,
  SSE_MAX_TOTAL_CONNECTIONS: 1000,
}));

vi.mock('../../shared/statusStore', () => ({
  onStatusChanged: vi.fn(),
}));

vi.mock('../guildScopedStatus', () => ({
  getGuildScopedStatus: vi.fn(),
  onGuildStatusInvalidated: vi.fn(),
}));

vi.mock('../../db', () => ({
  findUser: vi.fn(),
  getMemberAccessLevel: vi.fn(),
}));

const { middlewareCallOrder } = vi.hoisted(() => ({ middlewareCallOrder: [] as string[] }));
vi.mock('../middleware', () => ({
  requireGuildContext: (_req: any, _res: any, next: any) => { middlewareCallOrder.push('requireGuildContext'); next(); },
}));

vi.mock('../../shared/logger', () => ({ createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) }));

// The registry itself is tested in sessionStreams.test.ts; here only that this route hands its stream to it.
vi.mock('../sessionStreams', () => ({ registerSessionStream: vi.fn(() => true) }));

import supertest from 'supertest';
import router, { MAX_SSE_CONNECTIONS_PER_GUILD, connections, disconnectGuildStatusConnectionsForMember } from './dashboardStatusEvents';
import { findUser, getMemberAccessLevel } from '../../db';
import { onStatusChanged } from '../../shared/statusStore';
import { getGuildScopedStatus, onGuildStatusInvalidated } from '../guildScopedStatus';
import { registerSessionStream } from '../sessionStreams';
import { buildTestApp } from '../../test-utils/expressTestApp';

// Captured immediately after import, before any beforeEach's clearAllMocks() erases the
// one-time module-load call — dashboardStatusEvents.ts registers this listener as a
// top-level side effect, not per-request, so it's only ever recorded once.
const registeredListener = vi.mocked(onStatusChanged).mock.calls[0]?.[0] as (guildId: string | null) => Promise<void>;
// Same for the guild-info invalidation subscription (#1117): the listener guildScopedStatus calls once it has dropped its cache.
const invalidationListener = vi.mocked(onGuildStatusInvalidated).mock.calls[0]?.[0] as (guildId: string | null) => void;

/** Finds a route's handler function directly from the router's internal stack, bypassing HTTP entirely — needed to control the request's 'close' event deterministically. */
function getRouteHandler(routePath: string): (req: any, res: any, next: any) => void {
  const layer = (router as any).stack.find((l: any) => l.route?.path === routePath);
  return layer.route.stack.at(-1).handle;
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
  middlewareCallOrder.length = 0;
  vi.mocked(findUser).mockResolvedValue({ discord_id: 'discord1', is_owner: false } as any);
  vi.mocked(getMemberAccessLevel).mockResolvedValue(0);
});

describe('MAX_SSE_CONNECTIONS_PER_GUILD', () => {
  it('re-exports the value from config', () => {
    expect(MAX_SSE_CONNECTIONS_PER_GUILD).toBe(5);
  });
});

describe('GET /status/events — auth', () => {
  it('runs requireGuildContext first, so a stale or revoked currentGuildId is re-checked before attaching', async () => {
    await supertest(buildApp(undefined)).get('/status/events');
    expect(middlewareCallOrder).toEqual(['requireGuildContext']);
  });

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

describe('GET /status/events — session end (#1112)', () => {
  it('registers the attached stream with the session registry before the access re-check runs', async () => {
    const order: string[] = [];
    vi.mocked(registerSessionStream).mockImplementationOnce(() => { order.push('register'); return true; });
    vi.mocked(findUser).mockImplementationOnce(async () => { order.push('access check'); return { discord_id: 'discord1', is_owner: true } as any; });
    const handler = getRouteHandler('/status/events');
    const res = makeSseRes();
    const { req, triggerClose } = makeSseReq('guild-A');

    await handler(req, res, vi.fn());

    expect(registerSessionStream).toHaveBeenCalledWith(req, res, 'status');
    expect(order).toEqual(['register', 'access check']);
    triggerClose();
  });

  it('stops without an access re-check when the registry refuses the stream (its session already ended)', async () => {
    vi.mocked(registerSessionStream).mockReturnValueOnce(false);
    const handler = getRouteHandler('/status/events');
    const res = makeSseRes();
    const { req, triggerClose } = makeSseReq('guild-A');

    await handler(req, res, vi.fn());

    expect(findUser).not.toHaveBeenCalled();
    expect(connections.get('guild-A')?.has(res as any)).toBe(true); // the registry ended the response; its close event removes it
    triggerClose();
  });

  it('does not register a stream that was refused at attach (over the guild limit)', async () => {
    const handler = getRouteHandler('/status/events');
    const open: { triggerClose: () => void }[] = [];
    for (let i = 0; i < MAX_SSE_CONNECTIONS_PER_GUILD; i++) {
      const { req, triggerClose } = makeSseReq('guild-A');
      await handler(req, makeSseRes(), vi.fn());
      open.push({ triggerClose });
    }
    vi.mocked(registerSessionStream).mockClear();
    const { req } = makeSseReq('guild-A');
    const res = makeSseRes();

    await handler(req, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(429);
    expect(registerSessionStream).not.toHaveBeenCalled();
    open.forEach((o) => o.triggerClose());
  });
});

describe('GET /status/events — access re-check after attaching', () => {
  it('keeps the connection open for a current member', async () => {
    const handler = getRouteHandler('/status/events');
    const res = makeSseRes();
    const { req, triggerClose } = makeSseReq('guild-A');

    await handler(req, res, vi.fn());

    expect(getMemberAccessLevel).toHaveBeenCalledWith('guild-A', 'discord1');
    expect(res.end).not.toHaveBeenCalled();
    triggerClose();
  });

  it('keeps the connection open for a bot owner without a membership row', async () => {
    vi.mocked(findUser).mockResolvedValue({ discord_id: 'discord1', is_owner: true } as any);
    vi.mocked(getMemberAccessLevel).mockResolvedValue(null);
    const handler = getRouteHandler('/status/events');
    const res = makeSseRes();
    const { req, triggerClose } = makeSseReq('guild-A');

    await handler(req, res, vi.fn());

    expect(res.end).not.toHaveBeenCalled();
    triggerClose();
  });

  it('ends the connection when the membership was removed before it attached', async () => {
    vi.mocked(getMemberAccessLevel).mockResolvedValue(null);
    const handler = getRouteHandler('/status/events');
    const res = makeSseRes();
    const { req, triggerClose } = makeSseReq('guild-A');

    await handler(req, res, vi.fn());

    expect(res.end).toHaveBeenCalled();
    triggerClose();
  });

  it('ends the connection when the user row no longer exists', async () => {
    vi.mocked(findUser).mockResolvedValue(null);
    const handler = getRouteHandler('/status/events');
    const res = makeSseRes();
    const { req, triggerClose } = makeSseReq('guild-A');

    await handler(req, res, vi.fn());

    expect(res.end).toHaveBeenCalled();
    triggerClose();
  });

  it('fails closed, ending the connection, when the re-check itself errors', async () => {
    vi.mocked(findUser).mockRejectedValue(new Error('DB down'));
    const handler = getRouteHandler('/status/events');
    const res = makeSseRes();
    const { req, triggerClose } = makeSseReq('guild-A');

    await handler(req, res, vi.fn());

    expect(res.end).toHaveBeenCalled();
    triggerClose();
  });

  it('withholds status broadcasts until the re-check passes, then delivers them', async () => {
    let resolveUser!: (user: any) => void;
    vi.mocked(findUser).mockReturnValue(new Promise((resolve) => { resolveUser = resolve; }));
    vi.mocked(getGuildScopedStatus).mockResolvedValue({ guildId: 'guild-A' } as any);
    const handler = getRouteHandler('/status/events');
    const res = makeSseRes();
    const { req, triggerClose } = makeSseReq('guild-A');

    const pending = handler(req, res, vi.fn());
    await registeredListener('guild-A');
    expect(res.write).not.toHaveBeenCalledWith(expect.stringMatching(/^data: /));

    resolveUser({ discord_id: 'discord1', is_owner: false });
    await pending;
    await registeredListener('guild-A');
    expect(res.write).toHaveBeenCalledWith(`data: ${JSON.stringify({ guildId: 'guild-A' })}\n\n`);
    triggerClose();
  });

  it('never broadcasts to a connection whose re-check fails', async () => {
    vi.mocked(getMemberAccessLevel).mockResolvedValue(null);
    vi.mocked(getGuildScopedStatus).mockResolvedValue({ guildId: 'guild-A' } as any);
    const handler = getRouteHandler('/status/events');
    const res = makeSseRes();
    const { req, triggerClose } = makeSseReq('guild-A');

    await handler(req, res, vi.fn());
    await registeredListener('guild-A');

    expect(res.write).not.toHaveBeenCalledWith(expect.stringMatching(/^data: /));
    triggerClose();
  });

  it('does not re-check access when the connection was refused at the limit', async () => {
    connections.set('guild-A', new Set(Array.from({ length: MAX_SSE_CONNECTIONS_PER_GUILD }, () => ({}) as any)));
    await supertest(buildApp('guild-A')).get('/status/events');
    expect(findUser).not.toHaveBeenCalled();
  });
});

describe('disconnectGuildStatusConnectionsForMember', () => {
  it('ends only the removed member\'s connections in that guild', async () => {
    const handler = getRouteHandler('/status/events');
    const removed = makeSseRes();
    const removedReq = makeSseReq('guild-A');
    const other = makeSseRes();
    const otherReq = makeSseReq('guild-A');
    otherReq.req.session.user.discordId = 'discord2';
    const elsewhere = makeSseRes();
    const elsewhereReq = makeSseReq('guild-B');
    await handler(removedReq.req, removed, vi.fn());
    await handler(otherReq.req, other, vi.fn());
    await handler(elsewhereReq.req, elsewhere, vi.fn());

    disconnectGuildStatusConnectionsForMember('guild-A', 'discord1');

    expect(removed.end).toHaveBeenCalled();
    expect(other.end).not.toHaveBeenCalled();
    expect(elsewhere.end).not.toHaveBeenCalled();
    removedReq.triggerClose();
    otherReq.triggerClose();
    elsewhereReq.triggerClose();
  });

  it('is a no-op for a guild with no connections', () => {
    expect(() => disconnectGuildStatusConnectionsForMember('guild-none', 'discord1')).not.toThrow();
  });

  it('keeps closing the rest when one connection throws on end()', async () => {
    const handler = getRouteHandler('/status/events');
    const first = makeSseRes();
    const firstReq = makeSseReq('guild-A');
    const second = makeSseRes();
    const secondReq = makeSseReq('guild-A');
    await handler(firstReq.req, first, vi.fn());
    await handler(secondReq.req, second, vi.fn());
    first.end.mockImplementation(() => { throw new Error('socket gone'); });

    disconnectGuildStatusConnectionsForMember('guild-A', 'discord1');

    expect(second.end).toHaveBeenCalled();
    firstReq.triggerClose();
    secondReq.triggerClose();
  });
});

describe('status-change push (registered via onStatusChanged)', () => {
  it('registered a listener at module load', () => {
    expect(typeof registeredListener).toBe('function');
  });

  it('pushes a guild-scoped snapshot to only that guild when guildId is given', async () => {
    const resA = { write: vi.fn() };
    const resB = { write: vi.fn() };
    connections.set('guild-A', new Set([resA] as any));
    connections.set('guild-B', new Set([resB] as any));
    vi.mocked(getGuildScopedStatus).mockImplementation(async (guildId) => ({ guildId }) as any);

    await registeredListener('guild-A');

    expect(getGuildScopedStatus).toHaveBeenCalledWith('guild-A');
    expect(getGuildScopedStatus).not.toHaveBeenCalledWith('guild-B');
    expect(resA.write).toHaveBeenCalledWith(`data: ${JSON.stringify({ guildId: 'guild-A' })}\n\n`);
    expect(resB.write).not.toHaveBeenCalled();
  });

  it('pushes an individually-scoped snapshot to every connected guild when guildId is null', async () => {
    const resA = { write: vi.fn() };
    const resB = { write: vi.fn() };
    connections.set('guild-A', new Set([resA] as any));
    connections.set('guild-B', new Set([resB] as any));
    vi.mocked(getGuildScopedStatus).mockImplementation(async (guildId) => ({ guildId }) as any);

    await registeredListener(null);

    expect(getGuildScopedStatus).toHaveBeenCalledWith('guild-A');
    expect(getGuildScopedStatus).toHaveBeenCalledWith('guild-B');
    expect(resA.write).toHaveBeenCalledWith(`data: ${JSON.stringify({ guildId: 'guild-A' })}\n\n`);
    expect(resB.write).toHaveBeenCalledWith(`data: ${JSON.stringify({ guildId: 'guild-B' })}\n\n`);
  });

  it('does nothing when guildId is null and there are no connected guilds', async () => {
    await registeredListener(null);
    expect(getGuildScopedStatus).not.toHaveBeenCalled();
  });

  it('a rejected lookup for one guild does not stop the broadcast to other connected guilds', async () => {
    const resA = { write: vi.fn() };
    const resB = { write: vi.fn() };
    connections.set('guild-A', new Set([resA] as any));
    connections.set('guild-B', new Set([resB] as any));
    vi.mocked(getGuildScopedStatus).mockImplementation(async (guildId) => {
      if (guildId === 'guild-A') throw new Error('DB down');
      return { guildId } as any;
    });

    await registeredListener(null);

    expect(resA.write).not.toHaveBeenCalled();
    expect(resB.write).toHaveBeenCalledWith(`data: ${JSON.stringify({ guildId: 'guild-B' })}\n\n`);
  });

  it('serializes same-guild pushes so a slow first lookup cannot resolve after (and clobber) a later one', async () => {
    const resA = { write: vi.fn() };
    connections.set('guild-A', new Set([resA] as any));

    let resolveFirstLookup!: () => void;
    const firstLookupGate = new Promise<void>((resolve) => { resolveFirstLookup = resolve; });
    let lookupsStarted = 0;
    vi.mocked(getGuildScopedStatus).mockImplementation(async () => {
      lookupsStarted += 1;
      if (lookupsStarted === 1) {
        await firstLookupGate;
        return { value: 'first' } as any;
      }
      return { value: 'second' } as any;
    });

    const firstPush = registeredListener('guild-A');
    const secondPush = registeredListener('guild-A');

    // The second push's lookup must not start until the first one (still gated) finishes —
    // otherwise a faster second DB round-trip could broadcast before the first, leaving the
    // client stuck on stale data.
    await Promise.resolve();
    await Promise.resolve();
    expect(lookupsStarted).toBe(1);

    resolveFirstLookup();
    await Promise.all([firstPush, secondPush]);

    expect(resA.write).toHaveBeenNthCalledWith(1, `data: ${JSON.stringify({ value: 'first' })}\n\n`);
    expect(resA.write).toHaveBeenNthCalledWith(2, `data: ${JSON.stringify({ value: 'second' })}\n\n`);
  });

  it('does not serialize pushes for different guilds against each other', async () => {
    const resA = { write: vi.fn() };
    const resB = { write: vi.fn() };
    connections.set('guild-A', new Set([resA] as any));
    connections.set('guild-B', new Set([resB] as any));

    let resolveGuildALookup!: () => void;
    const guildALookupGate = new Promise<void>((resolve) => { resolveGuildALookup = resolve; });
    vi.mocked(getGuildScopedStatus).mockImplementation(async (guildId) => {
      if (guildId === 'guild-A') {
        await guildALookupGate;
        return { guildId } as any;
      }
      return { guildId } as any;
    });

    const guildAPush = registeredListener('guild-A');
    const guildBPush = registeredListener('guild-B');

    // guild-B's push must complete even while guild-A's is still gated — they don't share a queue.
    await guildBPush;
    expect(resB.write).toHaveBeenCalledWith(`data: ${JSON.stringify({ guildId: 'guild-B' })}\n\n`);
    expect(resA.write).not.toHaveBeenCalled();

    resolveGuildALookup();
    await guildAPush;
    expect(resA.write).toHaveBeenCalledWith(`data: ${JSON.stringify({ guildId: 'guild-A' })}\n\n`);
  });
});

describe('push after a guild-info change (#1117)', () => {
  /** Lets the push the listener started (it returns nothing to await) run to completion. */
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  it('subscribed to guildScopedStatus at module load, not to the db event directly', () => {
    expect(typeof invalidationListener).toBe('function');
  });

  it('pushes a fresh snapshot to only the changed guild\'s dashboards', async () => {
    const resA = { write: vi.fn() };
    const resB = { write: vi.fn() };
    connections.set('guild-A', new Set([resA] as any));
    connections.set('guild-B', new Set([resB] as any));
    vi.mocked(getGuildScopedStatus).mockImplementation(async (guildId) => ({ guildId }) as any);

    invalidationListener('guild-A');
    await settle();

    expect(getGuildScopedStatus).toHaveBeenCalledWith('guild-A');
    expect(getGuildScopedStatus).not.toHaveBeenCalledWith('guild-B');
    expect(resA.write).toHaveBeenCalledWith(`data: ${JSON.stringify({ guildId: 'guild-A' })}\n\n`);
    expect(resB.write).not.toHaveBeenCalled();
  });

  it('pushes each connected guild its own snapshot for a change that can touch any guild (null)', async () => {
    const resA = { write: vi.fn() };
    const resB = { write: vi.fn() };
    connections.set('guild-A', new Set([resA] as any));
    connections.set('guild-B', new Set([resB] as any));
    vi.mocked(getGuildScopedStatus).mockImplementation(async (guildId) => ({ guildId }) as any);

    invalidationListener(null);
    await settle();

    expect(resA.write).toHaveBeenCalledWith(`data: ${JSON.stringify({ guildId: 'guild-A' })}\n\n`);
    expect(resB.write).toHaveBeenCalledWith(`data: ${JSON.stringify({ guildId: 'guild-B' })}\n\n`);
  });

  it('reaches only the two guilds involved when a member moves from one to the other (a remove then an add)', async () => {
    const resA = { write: vi.fn() };
    const resB = { write: vi.fn() };
    const resC = { write: vi.fn() };
    connections.set('guild-A', new Set([resA] as any));
    connections.set('guild-B', new Set([resB] as any));
    connections.set('guild-C', new Set([resC] as any));
    vi.mocked(getGuildScopedStatus).mockImplementation(async (guildId) => ({ guildId }) as any);

    invalidationListener('guild-A');
    invalidationListener('guild-B');
    await settle();

    expect(resA.write).toHaveBeenCalledWith(`data: ${JSON.stringify({ guildId: 'guild-A' })}\n\n`);
    expect(resB.write).toHaveBeenCalledWith(`data: ${JSON.stringify({ guildId: 'guild-B' })}\n\n`);
    expect(resC.write).not.toHaveBeenCalled();
  });

  it('does nothing for a guild nobody has a dashboard open on', async () => {
    invalidationListener('guild-A');
    await settle();
    expect(getGuildScopedStatus).not.toHaveBeenCalled();
  });

  it('builds the snapshot after the change reached the status cache: it queues behind an earlier push for the same guild', async () => {
    const resA = { write: vi.fn() };
    connections.set('guild-A', new Set([resA] as any));
    let releaseFirst!: (value: unknown) => void;
    vi.mocked(getGuildScopedStatus)
      .mockImplementationOnce(() => new Promise((resolve) => { releaseFirst = resolve; }) as any)
      .mockResolvedValueOnce({ fresh: true } as any);

    const earlier = registeredListener('guild-A');
    invalidationListener('guild-A');
    await settle();
    expect(getGuildScopedStatus).toHaveBeenCalledTimes(1);

    releaseFirst({ stale: true });
    await earlier;
    await settle();

    expect(resA.write.mock.calls.map(([chunk]) => chunk)).toEqual([
      `data: ${JSON.stringify({ stale: true })}\n\n`,
      `data: ${JSON.stringify({ fresh: true })}\n\n`,
    ]);
  });

  it('does not throw to the writer when a lookup fails, and still pushes to the other guilds', async () => {
    const resA = { write: vi.fn() };
    const resB = { write: vi.fn() };
    connections.set('guild-A', new Set([resA] as any));
    connections.set('guild-B', new Set([resB] as any));
    vi.mocked(getGuildScopedStatus).mockImplementation(async (guildId) => {
      if (guildId === 'guild-A') throw new Error('db down');
      return { guildId } as any;
    });

    expect(() => invalidationListener(null)).not.toThrow();
    await settle();

    expect(resB.write).toHaveBeenCalledWith(`data: ${JSON.stringify({ guildId: 'guild-B' })}\n\n`);
  });
});
