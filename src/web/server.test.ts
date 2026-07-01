import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Router } from 'express';
import request from 'supertest';
import { EventEmitter } from 'events';

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

vi.mock('../shared/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('./csrf', () => ({
  ensureSessionCsrfToken: vi.fn().mockReturnValue('csrf-token'),
}));

vi.mock('./middleware', () => ({
  requireAuth: vi.fn((_req: unknown, _res: unknown, next: () => void) => next()),
  requireGuildContext: vi.fn((_req: unknown, _res: unknown, next: () => void) => next()),
  requireMod: vi.fn((_req: unknown, _res: unknown, next: () => void) => next()),
}));

// Each marker path is unique per router so a request only matches the router under
// test, even though several real routers are mounted at the same '/' or '/admin' prefix.
function emptyRouter() {
  return Router();
}
function markerRouter(label: string) {
  const router = Router();
  router.get(`/__marker_${label}`, (_req, res) => res.json({ label }));
  return router;
}
// Exposes routes that hand an error to `next()`, to drive the csrfErrorHandler and
// centralised error handler in server.ts without needing a real CSRF/unhandled failure.
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
vi.mock('./routes/commandMonitor', () => ({ default: emptyRouter() }));
vi.mock('./routes/streamdeck', () => ({ default: emptyRouter() }));
vi.mock('./routes/streamdeckKeys', () => ({ default: emptyRouter() }));
vi.mock('./routes/userSettings', () => ({ default: emptyRouter() }));
vi.mock('./routes/overlaySource', () => ({ default: emptyRouter() }));
vi.mock('./routes/overlayAdmin', () => ({ default: emptyRouter() }));
vi.mock('./routes/companionAuth', () => ({ default: emptyRouter() }));
vi.mock('./routes/companionEvents', () => ({ default: emptyRouter() }));
vi.mock('./routes/companionKeys', () => ({ default: emptyRouter() }));

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
