import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../../test-utils/loggerMock';

/** Mocks `../../db` so `exchangeCodeForToken` is stubbed instead of hitting a real Twitch/DB call. */
vi.mock('../../db', () => ({
  exchangeCodeForToken: vi.fn(),
}));
/** Mocks the shared logger so route handlers don't write real log output during tests. */
vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));
vi.mock('./companionEvents', () => ({ disconnectCompanionConnections: vi.fn() }));

import supertest from 'supertest';
import router from './companionAuth';
import { authLimiter } from '../rateLimits';
import { buildTestApp } from '../../test-utils/expressTestApp';

/** Builds a supertest-ready app: the companion auth router with a JSON body parser and an empty (no-user) session. */
function buildApp() {
  return buildTestApp({ router, bodyParser: 'json', session: {} });
}

// authLimiter is a process-wide singleton (shared with /auth's routes), so reset its
// state for the test's IP between cases to keep this file's tests independent.
beforeEach(() => {
  void authLimiter.resetKey('::ffff:127.0.0.1');
  void authLimiter.resetKey('127.0.0.1');
  void authLimiter.resetKey('::1');
});

describe('companion auth routes rate limiting', () => {
  it.each([
    ['POST', '/api/companion/oauth/token'] as const,
    ['GET', '/companion/login?redirect_uri=http://127.0.0.1:9999/cb&state=abc'] as const,
  ])('rate-limits repeated %s %s requests (authLimiter is wired, not skipped)', async (method, path) => {
    const app = buildApp();
    let sawRateLimited = false;
    for (let i = 0; i < 15; i++) {
      const res = method === 'GET' ? await supertest(app).get(path) : await supertest(app).post(path).send({});
      if (res.status === 429) {
        sawRateLimited = true;
        break;
      }
    }
    expect(sawRateLimited).toBe(true);
  });
});
