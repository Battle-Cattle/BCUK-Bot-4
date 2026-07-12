import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db', () => ({
  issueToken: vi.fn(),
  getTokenStatus: vi.fn(),
  revokeToken: vi.fn(),
}));
vi.mock('../csrf', () => ({
  csrfProtection: (req: any, _res: any, next: any) => {
    req.csrfToken = () => 'test-token';
    next();
  },
}));
vi.mock('../../shared/logger', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));
vi.mock('../../shared/config', () => ({ WEB_PORT: 3000 }));

import express from 'express';
import supertest from 'supertest';
import router from './companionKeys';
import { issueToken, getTokenStatus, revokeToken } from '../../db';
import { AccessLevel } from '../../db/users';
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
});

// ─── POST /companion-key/revoke ───────────────────────────────────────────────

describe('POST /companion-key/revoke', () => {
  it('redirects to /companion-key on success', async () => {
    const res = await supertest(buildApp()).post('/companion-key/revoke');
    expect(res.headers.location).toBe('/companion-key');
    expect(revokeToken).toHaveBeenCalledWith(SESSION_USER.discordId);
  });

  it('redirects to ?error=revoke_failed on error', async () => {
    vi.mocked(revokeToken).mockRejectedValueOnce(new Error('DB error'));
    const res = await supertest(buildApp()).post('/companion-key/revoke');
    expect(res.headers.location).toBe('/companion-key?error=revoke_failed');
  });
});
