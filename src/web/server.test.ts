import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express, { Router } from 'express';
import request from 'supertest';
import { EventEmitter } from 'events';
import http from 'http';
import net from 'net';
import type { AddressInfo } from 'net';
import { waitFor } from '../test-utils/waitFor';

vi.mock('../shared/config', () => ({
  WEB_PORT: 3000,
  WEB_HOST: '127.0.0.1',
  SESSION_SECRET: 'x'.repeat(32),
  DB_HOST: 'localhost',
  DB_PORT: 3306,
  DB_USER: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  SFX_FOLDER: './sfx',
  SFX_MAX_FILE_MB: 10,
}));

// The session pool server.ts hands the session store, and the store's constructor args/close calls.
const { mockPool, storeCtorArgs, storeClose, storeClearExpired, storeGet, storeSet } = vi.hoisted(() => ({
  mockPool: { pool: { marker: 'session-callback-pool' } },
  storeCtorArgs: [] as unknown[][],
  storeGet: vi.fn((_id: string, cb: (err: unknown, session?: unknown) => void) => cb(null, undefined)),
  storeSet: vi.fn((_id: string, _session: unknown, cb?: (err?: unknown) => void) => cb?.()),
  storeClose: vi.fn().mockResolvedValue(undefined),
  storeClearExpired: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../db', () => ({ getSessionPool: () => mockPool }));

vi.mock('express-mysql-session', () => ({
  // Built on the express-session module server.ts passes in, like the real factory, so a session
  // the store returns is inflated (Store#createSession) into a working req.session.
  default: (session: { Store: new () => EventEmitter }) =>
    class MockStore extends session.Store {
      constructor(...args: unknown[]) {
        super();
        storeCtorArgs.push(args);
      }
      close() {
        return storeClose();
      }
      clearExpiredSessions() {
        return storeClearExpired();
      }
      get(id: string, cb: (err: unknown, session?: unknown) => void) {
        storeGet(id, cb);
      }
      set(id: string, session: unknown, cb?: (err?: unknown) => void) {
        storeSet(id, session, cb);
      }
      destroy(_id: string, cb?: (err?: unknown) => void) {
        cb?.();
      }
    },
}));

// One shared logger instance, so the client-error tests can assert which level server.ts logged at.
const { mockLog } = vi.hoisted(() => ({
  mockLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../shared/logger', () => ({ createLogger: () => mockLog }));

vi.mock('./csrf', () => ({
  ensureSessionCsrfToken: vi.fn().mockReturnValue('csrf-token'),
}));

vi.mock('./middleware', () => ({
  requireAuth: vi.fn((_req: unknown, _res: unknown, next: () => void) => next()),
  requireAuthJson: vi.fn((_req: unknown, _res: unknown, next: () => void) => next()),
  requireGuildContext: vi.fn((_req: unknown, _res: unknown, next: () => void) => next()),
  requireMod: vi.fn((_req: unknown, _res: unknown, next: () => void) => next()),
  requireOwner: vi.fn((_req: unknown, _res: unknown, next: () => void) => next()),
}));

/** An empty router, standing in for a real route module whose internals aren't under test. */
function emptyRouter() {
  return Router();
}

/**
 * A router exposing a single `/__marker_${label}` route, so a request only matches the
 * router under test even though several real routers are mounted at the same '/' or
 * '/admin' prefix.
 */
function markerRouter(label: string) {
  const router = Router();
  router.get(`/__marker_${label}`, (_req, res) => res.json({ label }));
  return router;
}

/**
 * Exposes routes that hand an error to `next()`, to drive the csrfErrorHandler and
 * centralised error handler in server.ts without needing a real CSRF/unhandled failure.
 */
function errorTriggerRouter() {
  const router = Router();
  router.get('/__trigger_csrf_error', (_req, _res, next) => {
    const err = Object.assign(new Error('invalid csrf token'), { code: 'EBADCSRFTOKEN' });
    next(err);
  });
  router.get('/__trigger_error', (_req, _res, next) => {
    next(new Error('boom'));
  });
  router.get('/__trigger_bot_pool_queue_error', (_req, _res, next) => {
    next(new Error('Queue limit reached.'));
  });
  // Changes the session, so express-session saves it as the response ends.
  router.get('/__session_save', (req, res) => {
    (req.session as unknown as Record<string, unknown>).visited = true;
    res.send('saved');
  });
  return router;
}

vi.mock('./routes/auth', () => ({ default: emptyRouter() }));
vi.mock('./routes/passkeys', () => ({ default: emptyRouter() }));
vi.mock('./routes/guild', () => ({ default: markerRouter('guild') }));
vi.mock('./routes/eventsubCallback', () => ({ default: emptyRouter() }));
vi.mock('./routes/botAuth', () => ({ default: markerRouter('botAuth') }));
vi.mock('./routes/botAuthCallback', () => ({ default: markerRouter('botAuthCallback') }));
vi.mock('./routes/eventsubAdmin', () => ({ default: markerRouter('eventsubAdmin') }));
vi.mock('./routes/dashboard', () => ({
  default: (() => {
    const router = Router();
    router.use(markerRouter('dashboard'));
    router.use(errorTriggerRouter());
    return router;
  })(),
}));
vi.mock('./routes/admin', () => ({ default: markerRouter('admin') }));
vi.mock('./routes/api', () => ({ default: errorTriggerRouter() }));
vi.mock('./routes/sfx', () => ({ default: emptyRouter() }));
vi.mock('./routes/sfxMutations', () => ({ default: emptyRouter() }));
vi.mock('./routes/sfxPublic', () => ({ default: emptyRouter() }));
vi.mock('./routes/streams', () => ({ default: markerRouter('streams') }));
vi.mock('./routes/commands', () => ({ default: emptyRouter() }));
vi.mock('./routes/counters', () => ({ default: emptyRouter() }));
vi.mock('./routes/counterHistory', () => ({ default: emptyRouter() }));
vi.mock('./routes/loyaltyPoints', () => ({ default: emptyRouter() }));
vi.mock('./routes/streamdeck', () => ({ default: emptyRouter() }));
vi.mock('./routes/streamdeckKeys', () => ({ default: emptyRouter() }));
vi.mock('./routes/userSettings', () => ({ default: emptyRouter() }));
vi.mock('./routes/overlaySource', () => ({ default: emptyRouter() }));
vi.mock('./routes/sharedOverlaySource', () => ({ default: emptyRouter() }));
vi.mock('./routes/sharedOverlayAdmin', () => ({ default: emptyRouter() }));
vi.mock('./routes/overlayAdmin', () => ({ default: emptyRouter() }));
vi.mock('./routes/alertsOverlaySource', () => ({ default: emptyRouter() }));
vi.mock('./routes/alertsAdmin', () => ({ default: emptyRouter() }));
vi.mock('./routes/channelPointsAdmin', () => ({ default: emptyRouter() }));
vi.mock('./routes/timers', () => ({ default: emptyRouter() }));
vi.mock('./routes/dashboardEvents', () => ({ default: emptyRouter() }));
vi.mock('./routes/dashboardStatusEvents', () => ({ default: emptyRouter() }));
vi.mock('./routes/companionAuth', () => ({ default: emptyRouter() }));
vi.mock('./routes/companionEvents', () => ({ default: emptyRouter() }));
vi.mock('./routes/companionRewards', () => ({ default: emptyRouter() }));
vi.mock('./routes/companionCommands', () => ({ default: emptyRouter() }));
vi.mock('./routes/advancedCommands', () => ({ default: emptyRouter() }));
vi.mock('./routes/companionKeys', () => ({ default: emptyRouter() }));
vi.mock('./routes/serviceWorker', () => ({ default: emptyRouter() }));
vi.mock('./routes/health', () => ({ default: markerRouter('health') }));
vi.mock('./routes/healthStatusEvents', () => ({ default: emptyRouter() }));

import { app, generalLimiter, preSessionLimiter, sessionLimiter, startWebPanel, stopWebPanel } from './server';
import { overlayTrafficLimiter } from './rateLimits';
import { createHmac } from 'crypto';
import { requireAuth, requireAuthJson, requireGuildContext } from './middleware';

describe('server route wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('mounts /guild behind requireAuth only, without requireGuildContext', async () => {
    const res = await request(app).get('/guild/__marker_guild');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ label: 'guild' });
    expect(requireAuth).toHaveBeenCalled();
    expect(requireGuildContext).not.toHaveBeenCalled();
  });

  it('mounts /api behind requireAuthJson, so a poll from an expired session gets a 401 instead of the login page', async () => {
    await request(app).get('/api/__trigger_error');
    expect(requireAuthJson).toHaveBeenCalled();
  });

  it('mounts /admin behind both requireAuth and requireGuildContext', async () => {
    const res = await request(app).get('/admin/__marker_admin');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ label: 'admin' });
    expect(requireAuth).toHaveBeenCalled();
    expect(requireGuildContext).toHaveBeenCalled();
  });

  it('mounts the /admin streams router behind both requireAuth and requireGuildContext', async () => {
    const res = await request(app).get('/admin/__marker_streams');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ label: 'streams' });
    // Reaching the marker route means both guards ran for this '/admin' stack. We assert
    // they ran (not an exact count) so the test doesn't break when an unrelated '/' mount
    // is added/removed ahead of it — those also match every path and inflate the totals.
    expect(requireAuth).toHaveBeenCalled();
    expect(requireGuildContext).toHaveBeenCalled();
  });

  it('mounts the /admin eventsub router behind both requireAuth and requireGuildContext', async () => {
    const res = await request(app).get('/admin/__marker_eventsubAdmin');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ label: 'eventsubAdmin' });
    // As above: reaching the marker proves both guards are wired in front of this stack;
    // we don't assert an exact call count that would depend on every earlier '/' mount.
    expect(requireAuth).toHaveBeenCalled();
    expect(requireGuildContext).toHaveBeenCalled();
  });

  it('mounts /admin/health behind requireAuth only, without requireGuildContext (health is not guild-scoped)', async () => {
    const res = await request(app).get('/admin/health/__marker_health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ label: 'health' });
    expect(requireAuth).toHaveBeenCalled();
    expect(requireGuildContext).not.toHaveBeenCalled();
  });

  it('mounts /admin/bot-auth behind requireAuth only, without requireGuildContext (bot chat auth is not guild-scoped)', async () => {
    const res = await request(app).get('/admin/bot-auth/__marker_botAuth');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ label: 'botAuth' });
    expect(requireAuth).toHaveBeenCalled();
    expect(requireGuildContext).not.toHaveBeenCalled();
  });

  it('mounts the dashboard root behind both requireAuth and requireGuildContext', async () => {
    const res = await request(app).get('/__marker_dashboard');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ label: 'dashboard' });
    expect(requireAuth).toHaveBeenCalled();
    expect(requireGuildContext).toHaveBeenCalled();
  });

  it('counts each /auth request against authLimiter once, even when it falls through several /auth mounts', async () => {
    // The botAuthCallback marker is on the last '/auth' mount, so a request to it falls
    // through passkeys/auth/eventsubCallback first. With the limiter on each mount it was
    // counted 3x and the 4th request was blocked; applied once, all 10 of the 10/min fit.
    for (let i = 0; i < 10; i++) {
      const res = await request(app).get('/auth/__marker_botAuthCallback').set('X-Forwarded-For', '203.0.113.77');
      expect(res.status).toBe(200);
    }
    const blocked = await request(app).get('/auth/__marker_botAuthCallback').set('X-Forwarded-For', '203.0.113.77');
    expect(blocked.status).toBe(429);
  });

  it('does not apply the 10/min auth rate limiter to unrelated routes mounted at "/"', async () => {
    // companionAuthRouter is mounted at '/', so authLimiter must live inside that
    // router (applied per-route) rather than on the app.use('/', ...) call itself —
    // otherwise it rate-limits every request on the site after only 10/min.
    for (let i = 0; i < 15; i++) {
      const res = await request(app).get('/__marker_dashboard');
      expect(res.status).toBe(200);
    }
  });
});

describe('GET /healthz', () => {
  it('replies 200 ok, uncached, without needing a session', async () => {
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['set-cookie']).toBeUndefined();
  });
});

describe('static assets', () => {
  it('sends Cache-Control: no-cache so browsers always revalidate against the server', async () => {
    const res = await request(app).get('/style.css');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-cache');
  });
});

describe('passkey browser bundle', () => {
  it('serves the @simplewebauthn/browser bundle same-origin with no-cache', async () => {
    const res = await request(app).get('/vendor/simplewebauthn/index.umd.min.js');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('javascript');
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.text).toContain('SimpleWebAuthnBrowser');
  });
});

describe('CSP header', () => {
  it('restricts font-src to self, without falling back to helmet defaults', async () => {
    const res = await request(app).get('/__marker_dashboard');
    const csp = res.headers['content-security-policy'];
    expect(csp).toContain("font-src 'self'");
    expect(csp).not.toMatch(/font-src[^;]*https:/);
  });

  it('allows blob: media, which the shared overlay plays its stored videos from', async () => {
    const res = await request(app).get('/__marker_dashboard');
    const csp = res.headers['content-security-policy'];
    expect(csp).toMatch(/media-src 'self' blob:(;|$)/);
  });

  it('restricts style-src to self, without allowing unsafe-inline', async () => {
    const res = await request(app).get('/__marker_dashboard');
    const csp = res.headers['content-security-policy'];
    expect(csp).toContain("style-src 'self'");
    expect(csp).not.toMatch(/style-src[^;]*unsafe-inline/);
  });
});

describe('HSTS header', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('sends Strict-Transport-Security when NODE_ENV=production', async () => {
    vi.resetModules();
    process.env.NODE_ENV = 'production';
    const { app: prodApp } = await import('./server.js');
    const res = await request(prodApp).get('/__marker_dashboard');
    expect(res.headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');
  });

  it('omits Strict-Transport-Security outside production', async () => {
    vi.resetModules();
    process.env.NODE_ENV = 'test';
    const { app: devApp } = await import('./server.js');
    const res = await request(devApp).get('/__marker_dashboard');
    expect(res.headers['strict-transport-security']).toBeUndefined();
  });
});

describe('404 handler', () => {
  it('renders the error view with a 404 status for an unmatched route', async () => {
    const res = await request(app).get('/__this_route_does_not_exist');
    expect(res.status).toBe(404);
    expect(res.text).toContain('Page not found.');
  });
});

describe('csrfErrorHandler', () => {
  it('renders the error view with a 403 status for a CSRF failure outside /api', async () => {
    const res = await request(app).get('/__trigger_csrf_error');
    expect(res.status).toBe(403);
    expect(res.text).toContain('Your form session expired');
  });

  it('logs a CSRF failure as a warning naming the request, not as an error', async () => {
    mockLog.warn.mockClear();
    mockLog.error.mockClear();
    await request(app).post('/__trigger_csrf_error');
    await request(app).get('/__trigger_csrf_error?token=secret-value');
    // The path only: query values stay out of the log.
    expect(mockLog.warn).toHaveBeenCalledWith('Rejected invalid CSRF token on GET /__trigger_csrf_error');
    expect(JSON.stringify(mockLog.warn.mock.calls)).not.toContain('secret-value');
    expect(mockLog.error).not.toHaveBeenCalled();
  });

  it('responds with JSON for a CSRF failure under /api', async () => {
    const res = await request(app).get('/api/__trigger_csrf_error');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      ok: false,
      error: 'Your form session expired or the request could not be verified. Please reload the page and try again.',
    });
  });

  it('forwards non-CSRF errors to the centralised error handler', async () => {
    const res = await request(app).get('/__trigger_error');
    expect(res.status).toBe(500);
    expect(res.text).toContain('An unexpected error occurred.');
  });
});

describe('centralised error handler — client errors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('answers a body with an unsupported Content-Encoding with 415, not 500', async () => {
    const res = await request(app)
      .post('/__marker_dashboard')
      .set('Content-Type', 'application/json')
      .set('Content-Encoding', 'x')
      .send('{}');
    expect(res.status).toBe(415);
    expect(res.text).toContain('The request could not be processed.');
    expect(mockLog.warn).toHaveBeenCalled();
    expect(mockLog.error).not.toHaveBeenCalled();
  });

  it('answers a corrupt Brotli body with 400, not 500', async () => {
    const res = await request(app)
      .post('/__marker_dashboard')
      .set('Content-Type', 'application/json')
      .set('Content-Encoding', 'br')
      .send('definitely not brotli');
    expect(res.status).toBe(400);
    expect(res.text).toContain('The request could not be processed.');
    expect(mockLog.warn).toHaveBeenCalled();
    expect(mockLog.error).not.toHaveBeenCalled();
  });

  it('answers malformed JSON with 400', async () => {
    const res = await request(app)
      .post('/__marker_dashboard')
      .set('Content-Type', 'application/json')
      .send('{not json');
    expect(res.status).toBe(400);
    expect(res.text).toContain('The request could not be processed.');
    expect(mockLog.warn).toHaveBeenCalled();
    expect(mockLog.error).not.toHaveBeenCalled();
  });
});

/**
 * Mounts the real `generalLimiter`/`sessionLimiter` instances exported from server.ts behind
 * a stub session middleware, so a request loop can drive them past their threshold directly —
 * without needing hundreds of requests through the full mocked app to reach 100/600 hits.
 * Because these are the exact singleton objects `server.ts` calls `app.use()` with, a
 * copy/paste mistake swapping which keyGenerator/skip pair is attached to which limiter
 * (see #477) shows up here as a limiter that fails to block, or blocks when it shouldn't.
 *
 * @param limiter - The `generalLimiter` or `sessionLimiter` instance under test.
 * @param sessionUser - Value to stub as `req.session.user` on every request (undefined for unauthenticated).
 * @returns A minimal Express app: session stub → `limiter` → a 200-returning probe route.
 */
function buildLimiterTestApp(limiter: express.RequestHandler, sessionUser: unknown): express.Express {
  const testApp = express();
  /** Stubs `req.session.user` to `sessionUser` so the limiter's keyGenerator/skip can be exercised without real login. */
  testApp.use((req, _res, next) => {
    (req as unknown as { session: { user: unknown } }).session = { user: sessionUser };
    next();
  });
  testApp.use(limiter);
  /** Probe route: returns 200 unless a limiter ahead of it in the chain has already rejected the request. */
  testApp.get('/__limiter_probe', (_req, res) => res.json({ ok: true }));
  return testApp;
}

/**
 * Sends `limit` requests through `testApp` and asserts every one succeeds (200), then sends
 * one more and asserts it's rejected (429) — pinning the exact threshold instead of merely
 * observing that a 429 eventually appears somewhere in a longer, looser loop.
 *
 * @param testApp - App built by {@link buildLimiterTestApp}.
 * @param limit - The limiter's configured request cap for the window.
 * @returns Resolves once all `limit` + 1 requests have completed and been asserted.
 */
async function expectExactThreshold(testApp: express.Express, limit: number): Promise<void> {
  await withListeningServer(testApp, async (probe) => {
    await expectProbeStatuses(probe, limit, 200);
    await expectProbeStatuses(probe, 1, 429);
  });
}

/**
 * Starts `testApp` on one ephemeral loopback port for the duration of `fn`, then closes it.
 * Passing an app straight to `request()` makes supertest listen on and tear down a fresh server
 * for every single request, and supertest opens a new connection per request even against a
 * listening server; either dominates the cost of the hundreds-of-requests limiter loops here.
 * Instead the probes go over one keep-alive connection to one listening server, which keeps the
 * requests (and limiter keys) identical but cheap.
 *
 * @param testApp - App built by {@link buildLimiterTestApp}.
 * @param fn - Receives a function that sends one probe request and resolves with its status.
 * @param headers - Extra headers sent with every probe (e.g. `X-Forwarded-For`).
 * @returns Resolves once `fn` has finished and the server has closed.
 */
/** How many probe requests {@link expectProbeStatuses} keeps in flight at once (and sockets per probe agent). */
const PROBE_BATCH_SIZE = 16;

async function withListeningServer(
  testApp: express.Express,
  fn: (probe: () => Promise<number>) => Promise<void>,
  headers: http.OutgoingHttpHeaders = {},
): Promise<void> {
  const server = http.createServer(testApp);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const agent = new http.Agent({ keepAlive: true, maxSockets: PROBE_BATCH_SIZE });
  /**
   * Sends one GET to the probe route over the shared keep-alive sockets, draining the body so the
   * socket is reused. Rejects on a request/response error or a response cut off before its end,
   * so a broken probe fails the test at once instead of hanging the loop until the timeout.
   */
  const probe = (): Promise<number> => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/__limiter_probe', agent, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
      res.on('error', reject);
      res.on('close', () => {
        if (!res.complete) reject(new Error('Probe response closed before completion'));
      });
    }).on('error', reject);
  });
  try {
    await fn(probe);
  } finally {
    agent.destroy();
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

/**
 * Sends `count` probe requests in parallel batches of {@link PROBE_BATCH_SIZE}, asserting each
 * returns `status`. Batching keeps the counts exact: every request here expects the same status,
 * the limiters count each hit as it arrives, and the next call only starts once these have all
 * finished, so a threshold check right after still sees exactly `count` earlier hits. It just
 * skips waiting for each round trip in turn, which made the 1800-request tests take seconds.
 *
 * @param probe - Probe sender from {@link withListeningServer}.
 * @param count - Number of requests to send.
 * @param status - Expected HTTP status for every one of them.
 * @returns Resolves once all `count` requests have completed and been asserted.
 */
async function expectProbeStatuses(probe: () => Promise<number>, count: number, status: number): Promise<void> {
  for (let sent = 0; sent < count; sent += PROBE_BATCH_SIZE) {
    const batch = Math.min(PROBE_BATCH_SIZE, count - sent);
    const statuses = await Promise.all(Array.from({ length: batch }, () => probe()));
    expect(statuses).toEqual(Array.from({ length: batch }, () => status));
  }
}

describe('generalLimiter wiring (server.ts)', () => {
  beforeEach(async () => {
    // Reset the per-IP bucket so earlier tests' requests through the shared `app`
    // (same singleton limiter) don't make this test's threshold non-deterministic.
    await generalLimiter.resetKey('::ffff:127.0.0.1');
    await generalLimiter.resetKey('127.0.0.1');
    await generalLimiter.resetKey('::1');
  });

  it('allows exactly 100 requests then blocks the 101st for an unauthenticated caller', async () => {
    const testApp = buildLimiterTestApp(generalLimiter, undefined);
    await expectExactThreshold(testApp, 100);
  });

  it('skips an authenticated caller (per-account throttling is sessionLimiter’s job)', async () => {
    const testApp = buildLimiterTestApp(generalLimiter, { discordId: 'general-limiter-skip-test' });
    await withListeningServer(testApp, (probe) => expectProbeStatuses(probe, 105, 200));
  });
});

describe('overlay traffic and the general limiter (#1011)', () => {
  const LOOPBACK_KEYS = ['::ffff:127.0.0.1', '127.0.0.1', '::1'];

  beforeEach(async () => {
    for (const key of LOOPBACK_KEYS) {
      await generalLimiter.resetKey(key);
      await overlayTrafficLimiter.resetKey(key);
    }
  });

  /** The real general and overlay limiters, as server.ts mounts them, in front of 200-returning routes. */
  function buildOverlayTestApp(): express.Express {
    const testApp = express();
    testApp.use((req, _res, next) => {
      (req as unknown as { session: Record<string, unknown> }).session = {};
      next();
    });
    testApp.use(generalLimiter);
    testApp.use(overlayTrafficLimiter);
    testApp.all(/.*/, (_req, res) => res.json({ ok: true }));
    return testApp;
  }

  it('lets an OBS shared-overlay sync run without tripping the general limit, which still limits other routes', async () => {
    const server = http.createServer(buildOverlayTestApp());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    /** Sends one request over the shared keep-alive socket and resolves with its status. */
    const send = (method: string, path: string): Promise<number> => new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path, method, agent }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      });
      req.on('error', reject);
      req.end();
    });
    try {
      // 150 preload range requests and 60 readiness reports: well past the general limit of 100.
      for (let i = 0; i < 150; i++) expect(await send('GET', '/overlay/shared/videos/a.webm?preload=1')).toBe(200);
      for (let i = 0; i < 60; i++) expect(await send('POST', '/overlay/shared/streamer1/report')).toBe(200);
      // The streamer's other overlay requests from the same IP still go through.
      expect(await send('GET', '/overlay/videos/5/clip.webm')).toBe(200);
      expect(await send('GET', '/alerts/streamer1/events')).toBe(200);
      expect(await send('GET', '/alerts/assets/5/ding.mp3')).toBe(200);
      // An unrelated unauthenticated route is still limited at 100 per window.
      for (let i = 0; i < 100; i++) expect(await send('GET', '/auth/login')).toBe(200);
      expect(await send('GET', '/auth/login')).toBe(429);
    } finally {
      agent.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('sessionLimiter wiring (server.ts)', () => {
  it('skips an unauthenticated caller (per-IP throttling is generalLimiter’s job)', async () => {
    const testApp = buildLimiterTestApp(sessionLimiter, undefined);
    await withListeningServer(testApp, (probe) => expectProbeStatuses(probe, 105, 200));
  });

  it('allows exactly 600 requests then blocks the 601st for an authenticated account', async () => {
    const testApp = buildLimiterTestApp(sessionLimiter, { discordId: 'session-limiter-block-test' });
    await expectExactThreshold(testApp, 600);
  });
});

describe('startWebPanel / stopWebPanel', () => {
  afterEach(async () => {
    await stopWebPanel();
  });

  it('rejects with the listen error instead of reporting success when the port is taken', async () => {
    const blocker = http.createServer();
    // Same address the panel binds by default: Windows lets a specific-address bind share a port
    // with a wildcard listener, so a wildcard blocker wouldn't make the panel's listen fail there.
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const { port } = blocker.address() as AddressInfo;
    try {
      await expect(startWebPanel(port)).rejects.toMatchObject({ code: 'EADDRINUSE' });
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it("keeps Node's default request and header deadlines, since uploads arrive in short pieces", async () => {
    const server = await startWebPanel(0);
    expect(server.requestTimeout).toBe(5 * 60_000);
    expect(server.headersTimeout).toBeLessThanOrEqual(60_000);
    await stopWebPanel();
  });

  it('closes the server and drops in-flight connections on stop', async () => {
    const server = await startWebPanel(0);
    const { port } = server.address() as AddressInfo;
    const accepted = new Promise<net.Socket>((resolve) => server.once('connection', resolve));
    const socket = net.connect(port, '127.0.0.1');
    const socketClosed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    socket.on('error', () => {});
    await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
    // A half-sent request keeps the connection active, so a plain server.close() would wait on it.
    socket.write('GET / HTTP/1.1\r\nHost: localhost\r\n');
    // Wait until the server has read it: before then the connection is idle, and server.close()
    // alone would drop it, so the test couldn't tell whether stop drops in-flight connections.
    const serverSocket = await accepted;
    await waitFor(() => expect(serverSocket.bytesRead).toBeGreaterThan(0));

    await stopWebPanel();

    await socketClosed;
    expect(server.listening).toBe(false);
  });

  it('binds the configured host, loopback by default', async () => {
    const server = await startWebPanel(0);
    expect((server.address() as AddressInfo).address).toBe('127.0.0.1');
  });

  it('binds the host it is given', async () => {
    const server = await startWebPanel(0, '0.0.0.0');
    expect((server.address() as AddressInfo).address).toBe('0.0.0.0');
  });

  it('is a no-op when the panel is not running', async () => {
    await expect(stopWebPanel()).resolves.toBeUndefined();
    expect(storeClose).not.toHaveBeenCalled();
  });

  it('closes the session store after the server on stop', async () => {
    const server = await startWebPanel(0);
    storeClose.mockClear();
    await stopWebPanel();
    expect(server.listening).toBe(false);
    expect(storeClose).toHaveBeenCalledOnce();
  });
});

describe('expired-session cleanup', () => {
  const FIFTEEN_MINUTES = 15 * 60 * 1000;

  beforeEach(() => {
    storeClearExpired.mockReset().mockResolvedValue(undefined);
    mockLog.warn.mockClear();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  });

  afterEach(async () => {
    await stopWebPanel();
    vi.useRealTimers();
  });

  it('does not run until the panel starts, then runs every 15 minutes', async () => {
    await vi.advanceTimersByTimeAsync(FIFTEEN_MINUTES);
    expect(storeClearExpired).not.toHaveBeenCalled();
    await startWebPanel(0);
    await vi.advanceTimersByTimeAsync(FIFTEEN_MINUTES);
    expect(storeClearExpired).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(FIFTEEN_MINUTES);
    expect(storeClearExpired).toHaveBeenCalledTimes(2);
  });

  it('logs a failed cleanup as a warning instead of rejecting', async () => {
    const failure = new Error('db down');
    storeClearExpired.mockRejectedValueOnce(failure);
    await startWebPanel(0);
    await vi.advanceTimersByTimeAsync(FIFTEEN_MINUTES);
    expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to clear expired sessions'), failure);
  });

  it('stops when the panel stops', async () => {
    await startWebPanel(0);
    await stopWebPanel();
    await vi.advanceTimersByTimeAsync(FIFTEEN_MINUTES * 2);
    expect(storeClearExpired).not.toHaveBeenCalled();
  });
});

/**
 * A validly signed `connect.sid` cookie for session id `sid` (signed the way express-session's
 * cookie-signature does it), so express-session looks it up in the store.
 */
function signedSessionCookie(sid: string): string {
  const mac = createHmac('sha256', 'x'.repeat(32)).update(sid).digest('base64').replace(/=+$/, '');
  return `connect.sid=${encodeURIComponent(`s:${sid}.${mac}`)}`;
}

describe('preSessionLimiter (server.ts)', () => {
  const CLIENT_IP = '203.0.113.9';

  beforeEach(async () => {
    await preSessionLimiter.resetKey(CLIENT_IP);
    storeGet.mockClear();
  });

  it('allows exactly 2000 requests per IP, then cuts the client off', async () => {
    // A bare app around the same limiter instance (so the same counters) keeps the 2000-request
    // loop cheap; trust proxy matches server.ts, so the key is the X-Forwarded-For client.
    const testApp = express();
    testApp.set('trust proxy', 1);
    testApp.use(preSessionLimiter);
    testApp.get('/__limiter_probe', (_req, res) => res.json({ ok: true }));
    await withListeningServer(testApp, async (probe) => {
      await expectProbeStatuses(probe, 2000, 200);
      await expectProbeStatuses(probe, 1, 429);
    }, { 'x-forwarded-for': CLIENT_IP });
  }, 30_000);

  it('turns a cut-off IP away before its replayed session cookie reaches the store', async () => {
    const cookie = signedSessionCookie('replayed-session');
    await request(app).get('/__pre_session_probe').set('Cookie', cookie).set('X-Forwarded-For', CLIENT_IP);
    expect(storeGet).toHaveBeenCalledOnce();

    // Use up the rest of the IP's budget through a bare app sharing the limiter's counters.
    const testApp = express();
    testApp.set('trust proxy', 1);
    testApp.use(preSessionLimiter);
    testApp.get('/__limiter_probe', (_req, res) => res.json({ ok: true }));
    await withListeningServer(testApp, (probe) => expectProbeStatuses(probe, 1999, 200), { 'x-forwarded-for': CLIENT_IP });

    storeGet.mockClear();
    const res = await request(app).get('/__pre_session_probe').set('Cookie', cookie).set('X-Forwarded-For', CLIENT_IP);
    expect(res.status).toBe(429);
    expect(storeGet).not.toHaveBeenCalled();
  }, 30_000);

  it("lets three signed-in accounts behind one IP poll the whole app up to each account's own cap", async () => {
    // Through the full middleware chain (session lookup included): the per-account sessionLimiter
    // (600) is what stops a busy account, and three accounts at that cap still leave the shared
    // IP under preSessionLimiter's 2000.
    const accounts = ['poll-a', 'poll-b', 'poll-c'];
    await Promise.all(accounts.map((discordId) => sessionLimiter.resetKey(discordId)));
    storeGet.mockImplementation((sid, cb) =>
      cb(null, { cookie: { originalMaxAge: 60_000, expires: new Date(Date.now() + 60_000).toISOString() }, user: { discordId: sid } }));
    // Every probe 404s through the error page. Express only caches compiled views in production,
    // so without this EJS recompiles error.ejs and its partials 1800 times, most of this test's time.
    const viewCache = app.enabled('view cache');
    app.enable('view cache');
    try {
      for (const discordId of accounts) {
        await withListeningServer(app, async (probe) => {
          // The probe path has no route, so 404 means every limiter and the session lookup let it through.
          await expectProbeStatuses(probe, 600, 404);
          expect(await probe()).toBe(429); // the account's own cap, not the IP's
        }, { cookie: signedSessionCookie(discordId), 'x-forwarded-for': CLIENT_IP });
      }
      // 1803 requests from the IP so far: under 2000, so a visitor without a session still gets in.
      const res = await request(app).get('/__limiter_probe').set('X-Forwarded-For', CLIENT_IP);
      expect(res.status).toBe(404);
    } finally {
      app.set('view cache', viewCache);
      storeGet.mockImplementation((_id, cb) => cb(null, undefined));
      await Promise.all(accounts.map((discordId) => sessionLimiter.resetKey(discordId)));
    }
  }, 60_000);

  it('leaves the Streamdeck API to its own limiters', async () => {
    const testApp = express();
    testApp.use(preSessionLimiter);
    testApp.get('/api/streamdeck/ping', (_req, res) => res.json({ ok: true }));
    await preSessionLimiter.resetKey('::ffff:127.0.0.1');
    for (let i = 0; i < 3; i++) {
      await request(testApp).get('/api/streamdeck/ping').expect(200);
    }
    // Skipped requests never touch the bucket, so the IP still has its full budget.
    const res = await request(testApp).get('/api/streamdeck/ping');
    expect(res.headers['ratelimit']).toBeUndefined();
  });
});

describe('session store overload', () => {
  beforeEach(() => {
    mockLog.warn.mockClear();
    mockLog.error.mockClear();
  });

  afterEach(() => {
    storeGet.mockImplementation((_id, cb) => cb(null, undefined));
  });

  it('answers a full session-pool queue with a 503 instead of a 500', async () => {
    storeGet.mockImplementation((_id, cb) => cb(new Error('Queue limit reached.')));
    const res = await request(app)
      .get('/anything')
      .set('Cookie', signedSessionCookie('busy-session'))
      .set('X-Forwarded-For', '198.51.100.7');
    expect(res.status).toBe(503);
    expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining('Session store busy'), expect.objectContaining({ message: 'Queue limit reached.' }));
    expect(mockLog.error).not.toHaveBeenCalled();
  });

  it("answers the bot pool's full queue with a 500, not the session-store 503", async () => {
    const res = await request(app).get('/__trigger_bot_pool_queue_error').set('X-Forwarded-For', '198.51.100.9');
    expect(res.status).toBe(500);
    expect(mockLog.warn).not.toHaveBeenCalledWith(expect.stringContaining('Session store busy'), expect.anything());
  });

  it('logs a session save that fails after the response went out, instead of rendering an error page into it', async () => {
    storeSet.mockImplementationOnce((_id, _session, cb) => cb?.(new Error('Queue limit reached.')));
    const res = await request(app).get('/__session_save').set('X-Forwarded-For', '198.51.100.10');

    // The page itself already went out; the failed save is only logged.
    expect(res.status).toBe(200);
    expect(res.text).toBe('saved');
    await waitFor(() =>
      expect(mockLog.warn).toHaveBeenCalledWith(
        'Error after GET /__session_save was already answered:',
        expect.objectContaining({ message: 'Queue limit reached.' }),
      ),
    );
    expect(mockLog.warn).not.toHaveBeenCalledWith(expect.stringContaining('Session store busy'), expect.anything());
    // Called on the logger itself: a detached winston level method would drop the module label.
    expect(mockLog.warn.mock.contexts.at(-1)).toBe(mockLog);
  });

  it('logs any other failure after the response went out as an error', async () => {
    storeSet.mockImplementationOnce((_id, _session, cb) => cb?.(new Error('connect ECONNREFUSED')));
    const res = await request(app).get('/__session_save').set('X-Forwarded-For', '198.51.100.11');

    expect(res.status).toBe(200);
    await waitFor(() =>
      expect(mockLog.error).toHaveBeenCalledWith(
        'Error after GET /__session_save was already answered:',
        expect.objectContaining({ message: 'connect ECONNREFUSED' }),
      ),
    );
    expect(mockLog.error.mock.contexts.at(-1)).toBe(mockLog);
  });

  it('still answers any other store failure with a 500', async () => {
    storeGet.mockImplementation((_id, cb) => cb(new Error('connect ECONNREFUSED')));
    const res = await request(app)
      .get('/anything')
      .set('Cookie', signedSessionCookie('broken-session'))
      .set('X-Forwarded-For', '198.51.100.8');
    expect(res.status).toBe(500);
  });
});

describe('session store', () => {
  it('runs on the dedicated session pool and leaves table creation to the migrations', () => {
    // Other tests in this file re-import server.ts, so check every store it has built.
    expect(storeCtorArgs.length).toBeGreaterThan(0);
    for (const [options, connection] of storeCtorArgs) {
      expect(connection).toBe(mockPool.pool);
      expect(options).toMatchObject({ createDatabaseTable: false, clearExpired: false, schema: { tableName: 'sessions' } });
      expect(options).not.toHaveProperty('host');
    }
  });
});
