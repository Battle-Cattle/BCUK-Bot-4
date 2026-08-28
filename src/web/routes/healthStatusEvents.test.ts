import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../shared/config', () => ({
  SSE_MAX_TOTAL_CONNECTIONS: 1000,
}));

vi.mock('../../shared/healthStore', () => ({
  onHealthChanged: vi.fn(),
  getHealthSnapshot: vi.fn(),
}));

// Captures the single logger instance createLogger('Web') produces, so tests can assert on
// log.error calls — the module under test keeps its own reference, otherwise unreachable here.
// Built inside vi.hoisted() since vi.mock's factory can run before a plain top-level const
// (referenced by closure) has initialized.
const { webLogger } = vi.hoisted(() => ({ webLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock('../../shared/logger', () => ({ createLogger: () => webLogger }));

vi.mock('../middleware', () => ({
  requireOwner: (req: any, res: any, next: any) => {
    if (req.session?.user?.isOwner) return next();
    res.status(403).json({ error: 'forbidden' });
  },
}));

import supertest from 'supertest';
import router from './healthStatusEvents';
import { onHealthChanged, getHealthSnapshot } from '../../shared/healthStore';
import { buildTestApp } from '../../test-utils/expressTestApp';

/** Finds a route's handler function directly from the router's internal stack, bypassing HTTP entirely — mirrors `dashboardStatusEvents.test.ts`'s helper of the same name. */
function getRouteHandler(routePath: string): (req: any, res: any, next: any) => void {
  const layer = (router as any).stack.find((l: any) => l.route?.path === routePath);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

/** Builds a fake Express `res` covering the SSE-specific methods used by `attachSseConnection`. */
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

/** Builds a fake Express `req` with an owner session and a `close`-event hook, plus a `triggerClose()` helper to simulate the client disconnecting. */
function makeSseReq() {
  let closeCb: (() => void) | undefined;
  return {
    req: {
      session: { user: OWNER_SESSION_USER },
      on: (event: string, cb: () => void) => {
        if (event === 'close') closeCb = cb;
      },
    },
    triggerClose: () => closeCb?.(),
  };
}

const OWNER_SESSION_USER = {
  discordId: '1',
  discordName: 'Owner',
  accessLevel: 3,
  currentGuildId: null,
  isOwner: true,
  guilds: [],
};

const NON_OWNER_SESSION_USER = { ...OWNER_SESSION_USER, isOwner: false };

// Captured once at module load, mirroring dashboardStatusEvents.test.ts's pattern — this
// module registers its listener as a top-level side effect, not per-request.
const registeredListener = vi.mocked(onHealthChanged).mock.calls[0]?.[0] as () => void;

function buildApp(sessionUser: unknown) {
  return buildTestApp({ router, sessionUser });
}

beforeEach(() => {
  vi.mocked(getHealthSnapshot).mockReturnValue({ discordConnected: true } as any);
});

describe('GET /events — auth', () => {
  it('blocks a non-owner with a 403', async () => {
    const res = await supertest(buildApp(NON_OWNER_SESSION_USER)).get('/events');
    expect(res.status).toBe(403);
  });

  it('blocks an unauthenticated request with a 403', async () => {
    const res = await supertest(buildApp(undefined)).get('/events');
    expect(res.status).toBe(403);
  });
});

describe('pushHealthUpdate (registered onHealthChanged listener)', () => {
  it('registers a listener at module load', () => {
    expect(registeredListener).toBeTypeOf('function');
  });

  it('does not throw when there are no connected clients', () => {
    expect(() => registeredListener()).not.toThrow();
  });

  it('logs and swallows an error instead of throwing if building/broadcasting the snapshot fails', () => {
    vi.mocked(getHealthSnapshot).mockImplementationOnce(() => {
      throw new Error('snapshot boom');
    });
    webLogger.error.mockClear();

    expect(() => registeredListener()).not.toThrow();
    expect(webLogger.error).toHaveBeenCalledWith('Failed to push health update:', expect.any(Error));
  });
});

describe('GET /events — initial snapshot push (direct handler invocation)', () => {
  it('pushes the current snapshot immediately once a connection is accepted', async () => {
    vi.mocked(getHealthSnapshot).mockReturnValue({ discordConnected: true, marker: 'initial-push' } as any);
    const handler = getRouteHandler('/events');
    const res = makeSseRes();
    const { req, triggerClose } = makeSseReq();

    await handler(req, res, vi.fn());

    try {
      expect(res.write).toHaveBeenCalledWith(`data: ${JSON.stringify({ discordConnected: true, marker: 'initial-push' })}\n\n`);
    } finally {
      triggerClose(); // clears the keepalive interval so it doesn't leak into other tests, even if the assertion above fails
    }
  });
});
