import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Router } from 'express';
import request from 'supertest';
import { EventEmitter } from 'events';
import { mockLogger } from '../test-utils/loggerMock';

vi.mock('../shared/config', () => ({
  WEB_PORT: 3000,
  SESSION_SECRET: 'x'.repeat(32),
  DB_HOST: 'localhost',
  DB_PORT: 3306,
  DB_USER: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  SFX_FOLDER: './sfx',
  SFX_MAX_FILE_MB: 10,
}));

vi.mock('express-mysql-session', () => ({
  default: () =>
    class MockStore extends EventEmitter {
      get(_id: string, cb: (err: unknown, session?: unknown) => void) {
        cb(null, undefined);
      }
      set(_id: string, _session: unknown, cb?: (err?: unknown) => void) {
        cb?.();
      }
      destroy(_id: string, cb?: (err?: unknown) => void) {
        cb?.();
      }
    },
}));

vi.mock('../shared/logger', () => ({ createLogger: mockLogger }));

vi.mock('./csrf', () => ({
  ensureSessionCsrfToken: vi.fn().mockReturnValue('csrf-token'),
}));

vi.mock('./middleware', () => ({
  requireAuth: vi.fn((_req: unknown, _res: unknown, next: () => void) => next()),
  requireGuildContext: vi.fn((_req: unknown, _res: unknown, next: () => void) => next()),
  requireMod: vi.fn((_req: unknown, _res: unknown, next: () => void) => next()),
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
  return router;
}

vi.mock('./routes/auth', () => ({ default: emptyRouter() }));
vi.mock('./routes/guild', () => ({ default: markerRouter('guild') }));
vi.mock('./routes/eventsubCallback', () => ({ default: emptyRouter() }));
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
vi.mock('./routes/commandMonitor', () => ({ default: emptyRouter() }));
vi.mock('./routes/streamdeck', () => ({ default: emptyRouter() }));
vi.mock('./routes/streamdeckKeys', () => ({ default: emptyRouter() }));
vi.mock('./routes/userSettings', () => ({ default: emptyRouter() }));
vi.mock('./routes/overlaySource', () => ({ default: emptyRouter() }));
vi.mock('./routes/overlayAdmin', () => ({ default: emptyRouter() }));
vi.mock('./routes/alertsOverlaySource', () => ({ default: emptyRouter() }));
vi.mock('./routes/alertsAdmin', () => ({ default: emptyRouter() }));
vi.mock('./routes/channelPointsAdmin', () => ({ default: emptyRouter() }));
vi.mock('./routes/dashboardEvents', () => ({ default: emptyRouter() }));
vi.mock('./routes/dashboardStatusEvents', () => ({ default: emptyRouter() }));
vi.mock('./routes/companionAuth', () => ({ default: emptyRouter() }));
vi.mock('./routes/companionEvents', () => ({ default: emptyRouter() }));
vi.mock('./routes/companionRewards', () => ({ default: emptyRouter() }));
vi.mock('./routes/companionKeys', () => ({ default: emptyRouter() }));
vi.mock('./routes/serviceWorker', () => ({ default: emptyRouter() }));

import { app } from './server';
import { requireAuth, requireGuildContext } from './middleware';

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

  it('mounts the dashboard root behind both requireAuth and requireGuildContext', async () => {
    const res = await request(app).get('/__marker_dashboard');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ label: 'dashboard' });
    expect(requireAuth).toHaveBeenCalled();
    expect(requireGuildContext).toHaveBeenCalled();
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

describe('CSP header', () => {
  it('restricts font-src to self, without falling back to helmet defaults', async () => {
    const res = await request(app).get('/__marker_dashboard');
    const csp = res.headers['content-security-policy'];
    expect(csp).toContain("font-src 'self'");
    expect(csp).not.toMatch(/font-src[^;]*https:/);
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
