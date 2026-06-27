import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db', () => ({
  exchangeCodeForToken: vi.fn(),
}));
vi.mock('../../shared/logger', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

import express from 'express';
import supertest from 'supertest';
import router from './companionAuth';
import { authLimiter } from '../rateLimits';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.session = {};
    next();
  });
  app.use(router);
  return app;
}

// authLimiter is a process-wide singleton (shared with /auth's routes), so reset its
// state for the test's IP between cases to keep this file's tests independent.
beforeEach(() => {
  void authLimiter.resetKey('::ffff:127.0.0.1');
  void authLimiter.resetKey('127.0.0.1');
  void authLimiter.resetKey('::1');
});

describe('companion auth routes rate limiting', () => {
  it('is rate-limited (real authLimiter is wired to both companion routes, not skipped)', async () => {
    const app = buildApp();
    let sawRateLimited = false;
    for (let i = 0; i < 15; i++) {
      const res = await supertest(app).post('/api/companion/oauth/token').send({});
      if (res.status === 429) {
        sawRateLimited = true;
        break;
      }
    }
    expect(sawRateLimited).toBe(true);
  });
});
