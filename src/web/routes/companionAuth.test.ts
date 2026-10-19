import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../../test-utils/loggerMock';

/** Mocks `../../db` so `exchangeCodeForToken` is stubbed instead of hitting a real Twitch/DB call. */
vi.mock('../../db', () => ({
  exchangeCodeForToken: vi.fn(),
  revokeToken: vi.fn(),
}));
vi.mock('../middleware', () => ({
  requireCompanionKey: (req: any, res: any, next: any) => {
    if (req.headers.authorization !== 'Bearer good-token') {
      res.status(401).json({ ok: false, error: 'Unauthorized' });
      return;
    }
    req.companionDiscordId = 'user1';
    next();
  },
}));
/** Mocks the shared logger so route handlers don't write real log output during tests. */
vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));
// authLimiter is a process-wide singleton shared with /auth's routes (see
// rateLimits.ts); stub it out here so the functional tests below aren't subject to
// real rate limiting. Its wiring is verified separately in companionAuth.rateLimit.test.ts.
vi.mock('../rateLimits', () => ({
  authLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('./companionEvents', () => ({ disconnectCompanionConnections: vi.fn() }));

import express from 'express';
import supertest from 'supertest';
import router from './companionAuth';
import { exchangeCodeForToken, revokeToken } from '../../db';
import { disconnectCompanionConnections } from './companionEvents';
import { buildTestApp } from '../../test-utils/expressTestApp';

/** Builds a supertest-ready app: the companion-auth router with a customizable raw session and a render mock that returns the view/locals as JSON. */
function buildApp(sessionOverrides: Record<string, unknown> = {}) {
  return buildTestApp({
    router,
    bodyParser: 'json',
    session: { ...sessionOverrides },
    mockRender: (view, locals, res) => res.status(res.statusCode || 200).json({ view, locals }),
  });
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
    vi.mocked(exchangeCodeForToken).mockResolvedValue({ token: 'plain-token-value', discordId: 'user1' });
    const res = await supertest(buildApp()).post('/api/companion/oauth/token').send({ code: 'good' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ token: 'plain-token-value' });
    expect(exchangeCodeForToken).toHaveBeenCalledWith('good', null);
  });

  it('ends any open companion SSE connections for the user after issuing a new token', async () => {
    // A new token invalidates any prior one, so a connection still open under the old token
    // must be disconnected — otherwise it would keep streaming under a now-replaced credential.
    vi.mocked(exchangeCodeForToken).mockResolvedValue({ token: 'plain-token-value', discordId: 'user1' });
    await supertest(buildApp()).post('/api/companion/oauth/token').send({ code: 'good' });
    expect(disconnectCompanionConnections).toHaveBeenCalledWith('user1');
  });

  it('does not disconnect connections when the code is invalid/expired/used', async () => {
    vi.mocked(exchangeCodeForToken).mockResolvedValue(null);
    await supertest(buildApp()).post('/api/companion/oauth/token').send({ code: 'bad' });
    expect(disconnectCompanionConnections).not.toHaveBeenCalled();
  });

  it('returns 500 when exchangeCodeForToken throws', async () => {
    vi.mocked(exchangeCodeForToken).mockRejectedValue(new Error('DB error'));
    const res = await supertest(buildApp()).post('/api/companion/oauth/token').send({ code: 'good' });
    expect(res.status).toBe(500);
  });
});

// ─── PKCE ─────────────────────────────────────────────────────────────────────

const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';

describe('PKCE on the companion login', () => {
  it('stashes an S256 code_challenge with the pending login', async () => {
    let capturedSession: any;
    const app = express();
    app.use((req: any, _res: any, next: any) => {
      req.session = {};
      capturedSession = req.session;
      next();
    });
    app.use(router);
    const res = await supertest(app).get(
      `/companion/login?redirect_uri=http://127.0.0.1:9999/callback&state=s&code_challenge=${CHALLENGE}&code_challenge_method=S256`,
    );
    expect(res.status).toBe(302);
    expect(capturedSession.companionOAuth.codeChallenge).toBe(CHALLENGE);
  });

  it.each([
    [`code_challenge=${CHALLENGE}&code_challenge_method=plain`],
    [`code_challenge=${CHALLENGE}`],
    ['code_challenge=too-short&code_challenge_method=S256'],
    ['code_challenge_method=S256'],
  ])('rejects invalid PKCE parameters (%s)', async (pkce) => {
    const res = await supertest(buildApp()).get(`/companion/login?redirect_uri=http://127.0.0.1:9999/callback&state=s&${pkce}`);
    expect(res.status).toBe(400);
  });

  it('passes the code_verifier through to the exchange', async () => {
    vi.mocked(exchangeCodeForToken).mockResolvedValue({ token: 't', discordId: 'user1' });
    const res = await supertest(buildApp()).post('/api/companion/oauth/token').send({ code: 'good', code_verifier: VERIFIER });
    expect(res.status).toBe(200);
    expect(exchangeCodeForToken).toHaveBeenCalledWith('good', VERIFIER);
  });

  it.each([['short'], [42], ['x'.repeat(129)], ['has spaces in it that are not allowed by the pkce spec at all']])(
    'rejects a malformed code_verifier (%s)',
    async (codeVerifier) => {
      const res = await supertest(buildApp()).post('/api/companion/oauth/token').send({ code: 'good', code_verifier: codeVerifier });
      expect(res.status).toBe(400);
      expect(exchangeCodeForToken).not.toHaveBeenCalled();
    },
  );
});

// ─── POST /api/companion/token/revoke ─────────────────────────────────────────

describe('POST /api/companion/token/revoke', () => {
  it('revokes the caller\'s token and ends its open SSE connections', async () => {
    const res = await supertest(buildApp()).post('/api/companion/token/revoke').set('Authorization', 'Bearer good-token');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(revokeToken).toHaveBeenCalledWith('user1');
    expect(disconnectCompanionConnections).toHaveBeenCalledWith('user1');
  });

  it('refuses an unknown or already-revoked token', async () => {
    const res = await supertest(buildApp()).post('/api/companion/token/revoke').set('Authorization', 'Bearer stale');
    expect(res.status).toBe(401);
    expect(revokeToken).not.toHaveBeenCalled();
  });

  it('returns 500 when revoking fails', async () => {
    vi.mocked(revokeToken).mockRejectedValueOnce(new Error('DB down'));
    const res = await supertest(buildApp()).post('/api/companion/token/revoke').set('Authorization', 'Bearer good-token');
    expect(res.status).toBe(500);
    expect(disconnectCompanionConnections).not.toHaveBeenCalled();
  });
});
