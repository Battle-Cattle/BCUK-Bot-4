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

vi.mock('./routes/auth', () => ({ default: emptyRouter() }));
vi.mock('./routes/guild', () => ({ default: markerRouter('guild') }));
vi.mock('./routes/eventsubCallback', () => ({ default: emptyRouter() }));
vi.mock('./routes/eventsubAdmin', () => ({ default: markerRouter('eventsubAdmin') }));
vi.mock('./routes/dashboard', () => ({ default: markerRouter('dashboard') }));
vi.mock('./routes/admin', () => ({ default: markerRouter('admin') }));
vi.mock('./routes/api', () => ({ default: emptyRouter() }));
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
    // requireAuth also runs for the three earlier '/' mounts (streamdeckKeys, sfx, sfxMutations)
    // that match every path, plus adminRouter's and streamsRouter's own '/admin' stacks: 3 + 2 = 5.
    // requireGuildContext runs for streamdeckKeys' '/' mount plus the two '/admin' stacks: 3.
    expect(requireAuth).toHaveBeenCalledTimes(5);
    expect(requireGuildContext).toHaveBeenCalledTimes(3);
  });

  it('mounts the /admin eventsub router behind both requireAuth and requireGuildContext', async () => {
    const res = await request(app).get('/admin/__marker_eventsubAdmin');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ label: 'eventsubAdmin' });
    // Same three leading '/' mounts, plus all three '/admin' stacks (admin, streams,
    // eventsubAdmin) run before the eventsubAdmin route responds: 3 + 3 = 6.
    // requireGuildContext runs for streamdeckKeys' '/' mount plus all three '/admin' stacks: 4.
    expect(requireAuth).toHaveBeenCalledTimes(6);
    expect(requireGuildContext).toHaveBeenCalledTimes(4);
  });

  it('mounts the dashboard root behind both requireAuth and requireGuildContext', async () => {
    const res = await request(app).get('/__marker_dashboard');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ label: 'dashboard' });
    expect(requireAuth).toHaveBeenCalled();
    expect(requireGuildContext).toHaveBeenCalled();
  });
});
