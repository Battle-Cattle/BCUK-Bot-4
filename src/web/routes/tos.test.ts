import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Isolates this test from the real DB module — required at runtime only by shared.ts's
 * requireStreamer/handleReservedOrConflictCommandError, neither of which this route uses,
 * but a real (unmocked) import would otherwise try to build a live connection pool.
 */
vi.mock('../../db', () => ({}));

import express from 'express';
import supertest from 'supertest';
import tosRouter from './tos';

/** Builds a minimal Express app wired with the tos router, a fake session, and a `res.render` stub that echoes its arguments as JSON instead of rendering EJS. */
function buildApp(sessionUser: unknown = null) {
  const app = express();
  app.use((req: any, _res: any, next: any) => {
    req.session = { user: sessionUser };
    next();
  });
  app.use((req: any, res: any, next: any) => {
    res.render = (view: string, locals: unknown) => res.json({ view, locals });
    next();
  });
  app.use(tosRouter);
  return app;
}

describe('GET /tos', () => {
  /** No shared state to reset; each test builds its own app/session via buildApp. */
  beforeEach(() => {
    // no-op: each test builds its own app/session
  });

  it('renders the tos page for anonymous visitors', async () => {
    const res = await supertest(buildApp(null)).get('/tos');
    expect(res.status).toBe(200);
    expect((res.body as any).view).toBe('tos');
    expect((res.body as any).locals.user).toBeNull();
    expect((res.body as any).locals.csrfToken).toBe('');
  });

  it('renders the tos page for signed-in users with a csrf token', async () => {
    const user = { discordId: '42', discordName: 'Alice', accessLevel: 0 };
    const res = await supertest(buildApp(user)).get('/tos');
    expect(res.status).toBe(200);
    expect((res.body as any).view).toBe('tos');
    expect((res.body as any).locals.user).toEqual(user);
    expect(typeof (res.body as any).locals.csrfToken).toBe('string');
    expect((res.body as any).locals.csrfToken.length).toBeGreaterThan(0);
  });
});
