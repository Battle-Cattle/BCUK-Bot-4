import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../../test-utils/loggerMock';
import { ACCESS_LEVEL_MOCK } from '../../test-utils/accessLevelMock';

vi.mock('../../db', () => ({
  issueToken: vi.fn(),
  getTokenStatus: vi.fn(),
  revokeToken: vi.fn(),
  AccessLevel: ACCESS_LEVEL_MOCK,
}));
vi.mock('../csrf', () => ({
  csrfProtection: (req: any, _res: any, next: any) => {
    req.csrfToken = () => 'test-token';
    next();
  },
}));
vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));
vi.mock('../../shared/config', () => ({ WEB_PORT: 3000 }));
vi.mock('./companionEvents', () => ({ disconnectCompanionConnections: vi.fn() }));

import express from 'express';
import supertest from 'supertest';
import router, { __resetRecentIssuesForTests } from './companionKeys';
import { issueToken, getTokenStatus, revokeToken } from '../../db';
import { AccessLevel } from '../../db';
import { disconnectCompanionConnections } from './companionEvents';
import { buildTestApp } from '../../test-utils/expressTestApp';

const GUILD_ID = '900000000000000001';
const SESSION_USER = {
  discordId: '111222333444555666',
  discordName: 'Alice',
  accessLevel: AccessLevel.USER,
  currentGuildId: GUILD_ID,
  isOwner: false,
  guilds: [{ guildId: GUILD_ID, name: 'Test Guild' }],
};

/** Builds a supertest-ready app: the companion keys router with a stubbed session and a render mock that nests locals under a `locals` key. */
function buildApp(sessionUser = SESSION_USER) {
  return buildTestApp({ router, bodyParser: 'urlencoded', sessionUser, mockRender: 'nested' });
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetRecentIssuesForTests();
  vi.mocked(getTokenStatus).mockResolvedValue(null);
  vi.mocked(issueToken).mockResolvedValue('a'.repeat(64));
  vi.mocked(revokeToken).mockResolvedValue(undefined);
});

// ─── GET /companion-key ────────────────────────────────────────────────────────

describe('GET /companion-key', () => {
  it('renders companion-keys with tokenStatus and webPort', async () => {
    const tokenStatus = { hasToken: true, createdAt: new Date() };
    vi.mocked(getTokenStatus).mockResolvedValue(tokenStatus as any);
    const res = await supertest(buildApp()).get('/companion-key');
    expect(res.status).toBe(200);
    const body = res.body as any;
    expect(body.view).toBe('companion-keys');
    expect(body.locals.tokenStatus).toMatchObject({ hasToken: true });
    expect(body.locals.newToken).toBeNull();
    expect(getTokenStatus).toHaveBeenCalledWith(SESSION_USER.discordId);
  });

  it('returns 500 on DB error', async () => {
    vi.mocked(getTokenStatus).mockRejectedValueOnce(new Error('DB down'));
    const app = express();
    app.use((req: any, _res: any, next: any) => { req.session = { user: SESSION_USER }; next(); });
    app.use((req: any, res: any, next: any) => {
      (req as any).csrfToken = () => 'tok';
      res.render = (view: string, locals: unknown) => res.status((res as any).statusCode).json({ view, locals });
      next();
    });
    app.use(router);
    const res = await supertest(app).get('/companion-key');
    expect(res.status).toBe(500);
  });
});

// ─── POST /companion-key/request ──────────────────────────────────────────────

describe('POST /companion-key/request', () => {
  it('renders companion-keys with the plain token on success', async () => {
    vi.mocked(issueToken).mockResolvedValue('plain-token-value');
    vi.mocked(getTokenStatus).mockResolvedValue({ hasToken: true, createdAt: new Date() } as any);
    const res = await supertest(buildApp()).post('/companion-key/request');
    expect(res.status).toBe(200);
    expect((res.body as any).locals.newToken).toBe('plain-token-value');
    expect(issueToken).toHaveBeenCalledWith(SESSION_USER.discordId);
  });

  it('redirects to ?error=request_failed on error', async () => {
    vi.mocked(issueToken).mockRejectedValueOnce(new Error('denied'));
    const res = await supertest(buildApp()).post('/companion-key/request');
    expect(res.headers.location).toBe('/companion-key?error=request_failed');
  });

  it('ends any open companion SSE connections for the user after issuing a new token', async () => {
    vi.mocked(issueToken).mockResolvedValue('plain-token-value');
    vi.mocked(getTokenStatus).mockResolvedValue({ hasToken: true, createdAt: new Date() } as any);
    await supertest(buildApp()).post('/companion-key/request');
    // A new token invalidates any prior one, so a connection still open under the old token
    // must be disconnected — otherwise it would keep streaming under a now-replaced credential.
    expect(disconnectCompanionConnections).toHaveBeenCalledWith(SESSION_USER.discordId);
  });

  it('does not disconnect connections when issuing the token itself fails', async () => {
    vi.mocked(issueToken).mockRejectedValueOnce(new Error('denied'));
    await supertest(buildApp()).post('/companion-key/request');
    expect(disconnectCompanionConnections).not.toHaveBeenCalled();
  });

  it('a rapid duplicate request within the dedupe window reuses the first token instead of issuing again', async () => {
    vi.mocked(issueToken).mockResolvedValue('first-plain-token');

    const app = buildApp();
    const first = await supertest(app).post('/companion-key/request');
    expect((first.body as any).locals.newToken).toBe('first-plain-token');

    // If the dedupe guard failed to kick in, this second call would return whatever
    // issueToken resolves to now — which is unchanged, so a regression here wouldn't be
    // masked by a queued "once" value.
    const second = await supertest(app).post('/companion-key/request');

    expect((second.body as any).locals.newToken).toBe('first-plain-token');
    expect(issueToken).toHaveBeenCalledOnce();
    expect(disconnectCompanionConnections).toHaveBeenCalledOnce();
  });

  it('issues again once the dedupe window has passed', async () => {
    const dateNowSpy = vi.spyOn(Date, 'now');
    try {
      vi.mocked(issueToken).mockResolvedValueOnce('first-plain-token');
      dateNowSpy.mockReturnValue(1_000_000);

      const app = buildApp();
      const first = await supertest(app).post('/companion-key/request');
      expect((first.body as any).locals.newToken).toBe('first-plain-token');

      vi.mocked(issueToken).mockResolvedValueOnce('second-plain-token');
      dateNowSpy.mockReturnValue(1_000_000 + 10_000 + 1);

      const second = await supertest(app).post('/companion-key/request');

      expect((second.body as any).locals.newToken).toBe('second-plain-token');
      expect(issueToken).toHaveBeenCalledTimes(2);
    } finally {
      dateNowSpy.mockRestore();
    }
  });
});

// ─── POST /companion-key/revoke ───────────────────────────────────────────────

describe('POST /companion-key/revoke', () => {
  it('redirects to /companion-key on success', async () => {
    const res = await supertest(buildApp()).post('/companion-key/revoke');
    expect(res.headers.location).toBe('/companion-key');
    expect(revokeToken).toHaveBeenCalledWith(SESSION_USER.discordId);
  });

  it('ends any open companion SSE connections for the user after a successful revoke', async () => {
    await supertest(buildApp()).post('/companion-key/revoke');
    expect(disconnectCompanionConnections).toHaveBeenCalledWith(SESSION_USER.discordId);
  });

  it('redirects to ?error=revoke_failed on error', async () => {
    vi.mocked(revokeToken).mockRejectedValueOnce(new Error('DB error'));
    const res = await supertest(buildApp()).post('/companion-key/revoke');
    expect(res.headers.location).toBe('/companion-key?error=revoke_failed');
  });

  it('does not disconnect connections when the revoke itself fails', async () => {
    vi.mocked(revokeToken).mockRejectedValueOnce(new Error('DB error'));
    await supertest(buildApp()).post('/companion-key/revoke');
    expect(disconnectCompanionConnections).not.toHaveBeenCalled();
  });

  it('clears the issue dedupe cache, so a request right after a revoke issues a fresh token', async () => {
    vi.mocked(issueToken).mockResolvedValueOnce('first-plain-token');
    const app = buildApp();
    await supertest(app).post('/companion-key/request');

    await supertest(app).post('/companion-key/revoke');

    vi.mocked(issueToken).mockResolvedValueOnce('second-plain-token');
    const res = await supertest(app).post('/companion-key/request');

    expect((res.body as any).locals.newToken).toBe('second-plain-token');
    expect(issueToken).toHaveBeenCalledTimes(2);
  });
});
