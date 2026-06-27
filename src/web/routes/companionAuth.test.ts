import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db', () => ({
  exchangeCodeForToken: vi.fn(),
}));
vi.mock('../../shared/logger', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));
// authLimiter is a process-wide singleton shared with /auth's routes (see
// rateLimits.ts); stub it out here so the functional tests below aren't subject to
// real rate limiting. Its wiring is verified separately in companionAuth.rateLimit.test.ts.
vi.mock('../rateLimits', () => ({
  authLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import express from 'express';
import supertest from 'supertest';
import router from './companionAuth';
import { exchangeCodeForToken } from '../../db';

function buildApp(sessionOverrides: Record<string, unknown> = {}) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.session = { ...sessionOverrides };
    next();
  });
  app.use((req: any, res: any, next: any) => {
    res.render = (view: string, locals: unknown) =>
      res.status((res as any).statusCode || 200).json({ view, locals });
    next();
  });
  app.use(router);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── GET /companion/login ─────────────────────────────────────────────────────

describe('GET /companion/login', () => {
  it('renders error 400 when redirect_uri is missing', async () => {
    const res = await supertest(buildApp()).get('/companion/login?state=abc');
    expect(res.status).toBe(400);
  });

  it('renders error 400 when state is missing', async () => {
    const res = await supertest(buildApp()).get('/companion/login?redirect_uri=http://127.0.0.1:9999/callback');
    expect(res.status).toBe(400);
  });

  it('renders error 400 when redirect_uri is not a loopback host', async () => {
    const res = await supertest(buildApp())
      .get('/companion/login?redirect_uri=https://evil.example/cb&state=abc');
    expect(res.status).toBe(400);
  });

  it('renders error 400 when redirect_uri uses https on a loopback host (scheme must be http)', async () => {
    const res = await supertest(buildApp())
      .get('/companion/login?redirect_uri=https://127.0.0.1:9999/cb&state=abc');
    expect(res.status).toBe(400);
  });

  it('renders error 400 when redirect_uri is unparseable', async () => {
    const res = await supertest(buildApp())
      .get('/companion/login?redirect_uri=not-a-url&state=abc');
    expect(res.status).toBe(400);
  });

  it('accepts a 127.0.0.1 loopback redirect_uri, stashes session state, and redirects to /auth/discord', async () => {
    let capturedSession: any;
    const app = express();
    app.use((req: any, _res: any, next: any) => {
      req.session = {};
      capturedSession = req.session;
      next();
    });
    app.use(router);
    const res = await supertest(app)
      .get('/companion/login?redirect_uri=http://127.0.0.1:9999/callback&state=appstate1');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/auth/discord');
    expect(capturedSession.companionOAuth).toMatchObject({
      redirectUri: 'http://127.0.0.1:9999/callback',
      appState: 'appstate1',
    });
  });

  it('accepts a localhost loopback redirect_uri', async () => {
    const res = await supertest(buildApp())
      .get('/companion/login?redirect_uri=http://localhost:9999/callback&state=abc');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/auth/discord');
  });
});

// ─── POST /api/companion/oauth/token ──────────────────────────────────────────

describe('POST /api/companion/oauth/token', () => {
  it('returns 400 when code is missing', async () => {
    const res = await supertest(buildApp()).post('/api/companion/oauth/token').send({});
    expect(res.status).toBe(400);
    expect(exchangeCodeForToken).not.toHaveBeenCalled();
  });

  it('returns 400 when exchangeCodeForToken reports the code is invalid/expired/used', async () => {
    vi.mocked(exchangeCodeForToken).mockResolvedValue(null);
    const res = await supertest(buildApp()).post('/api/companion/oauth/token').send({ code: 'bad' });
    expect(res.status).toBe(400);
  });

  it('returns a token when the code is valid', async () => {
    vi.mocked(exchangeCodeForToken).mockResolvedValue('plain-token-value');
    const res = await supertest(buildApp()).post('/api/companion/oauth/token').send({ code: 'good' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ token: 'plain-token-value' });
    expect(exchangeCodeForToken).toHaveBeenCalledWith('good');
  });

  it('returns 500 when exchangeCodeForToken throws', async () => {
    vi.mocked(exchangeCodeForToken).mockRejectedValue(new Error('DB error'));
    const res = await supertest(buildApp()).post('/api/companion/oauth/token').send({ code: 'good' });
    expect(res.status).toBe(500);
  });
});
