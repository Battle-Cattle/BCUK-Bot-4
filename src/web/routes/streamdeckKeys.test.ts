import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db', () => ({
  requestApiKey: vi.fn().mockResolvedValue({ plain: 'a'.repeat(64), status: 'pending' }),
  getApiKeyStatus: vi.fn().mockResolvedValue(null),
  revokeApiKey: vi.fn().mockResolvedValue(undefined),
  approveApiKey: vi.fn().mockResolvedValue(undefined),
  denyApiKey: vi.fn().mockResolvedValue(undefined),
  getAllApiKeys: vi.fn().mockResolvedValue([]),
  getPendingRequests: vi.fn().mockResolvedValue([]),
}));
vi.mock('../csrf', () => ({
  csrfProtection: (req: any, _res: any, next: any) => {
    req.csrfToken = () => 'test-token';
    next();
  },
}));
vi.mock('../middleware', () => ({
  requireAdmin: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('../../shared/config', () => ({ WEB_PORT: 3000 }));
vi.mock('../../shared/logger', () => ({ createLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }) }));

import express from 'express';
import supertest from 'supertest';
import router from './streamdeckKeys';
import {
  requestApiKey, getApiKeyStatus, revokeApiKey,
  approveApiKey, denyApiKey, getAllApiKeys, getPendingRequests,
} from '../../db';
import { AccessLevel } from '../../db/users';

const GUILD_ID = '900000000000000001';
const SESSION_USER = {
  discordId: '111222333444555666',
  discordName: 'Alice',
  accessLevel: AccessLevel.ADMIN,
  currentGuildId: GUILD_ID,
  isOwner: false,
  guilds: [{ guildId: GUILD_ID, name: 'Test Guild' }],
};
const VALID_DISCORD_ID = '123456789012345678';

function buildApp(sessionUser = SESSION_USER) {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use((req: any, _res: any, next: any) => {
    req.session = { user: sessionUser };
    next();
  });
  app.use((req: any, res: any, next: any) => {
    res.render = (view: string, locals: unknown) => res.json({ view, locals });
    next();
  });
  app.use(router);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requestApiKey).mockResolvedValue({ plain: 'a'.repeat(64), status: 'pending' } as any);
  vi.mocked(getApiKeyStatus).mockResolvedValue(null);
  vi.mocked(getAllApiKeys).mockResolvedValue([]);
  vi.mocked(getPendingRequests).mockResolvedValue([]);
});

// ─── GET /streamdeck-key ──────────────────────────────────────────────────────

describe('GET /streamdeck-key', () => {
  it('renders streamdeck-keys with keyRow and webPort', async () => {
    const keyRow = { discord_id: '1', status: 'pending', requested_at: new Date(), approved_at: null, approved_by: null };
    vi.mocked(getApiKeyStatus).mockResolvedValue(keyRow as any);
    const res = await supertest(buildApp()).get('/streamdeck-key');
    expect(res.status).toBe(200);
    const body = res.body as any;
    expect(body.view).toBe('streamdeck-keys');
    expect(body.locals.keyRow).toMatchObject({ discord_id: '1', status: 'pending' });
    expect(body.locals.webPort).toBe(3000);
    expect(body.locals.newKey).toBeNull();
  });

  it('returns 500 on DB error', async () => {
    vi.mocked(getApiKeyStatus).mockRejectedValueOnce(new Error('DB down'));
    const app = express();
    app.use((req: any, _res: any, next: any) => { req.session = { user: SESSION_USER }; next(); });
    app.use((req: any, res: any, next: any) => {
      (req as any).csrfToken = () => 'tok';
      res.render = (view: string, locals: unknown) => res.status((res as any).statusCode).json({ view, locals });
      next();
    });
    app.use(router);
    const res = await supertest(app).get('/streamdeck-key');
    expect(res.status).toBe(500);
  });
});

// ─── POST /streamdeck-key/request ────────────────────────────────────────────

describe('POST /streamdeck-key/request', () => {
  it('renders streamdeck-keys with the plain key on success', async () => {
    vi.mocked(requestApiKey).mockResolvedValue({ plain: 'abc123'.repeat(10).slice(0, 64), status: 'pending' } as any);
    vi.mocked(getApiKeyStatus).mockResolvedValue({ discord_id: '1', status: 'pending' } as any);
    const res = await supertest(buildApp()).post('/streamdeck-key/request');
    expect(res.status).toBe(200);
    expect((res.body as any).locals.newKey).toBeTruthy();
    expect(vi.mocked(requestApiKey)).toHaveBeenCalledWith(
      SESSION_USER.discordId,
      SESSION_USER.accessLevel,
      GUILD_ID,
    );
  });

  it('redirects to ?error=request_failed on error', async () => {
    vi.mocked(requestApiKey).mockRejectedValueOnce(new Error('denied'));
    const res = await supertest(buildApp()).post('/streamdeck-key/request');
    expect(res.headers.location).toBe('/streamdeck-key?error=request_failed');
  });
});

// ─── POST /streamdeck-key/revoke ──────────────────────────────────────────────

describe('POST /streamdeck-key/revoke', () => {
  it('redirects to /streamdeck-key on success', async () => {
    const res = await supertest(buildApp()).post('/streamdeck-key/revoke');
    expect(res.headers.location).toBe('/streamdeck-key');
    expect(revokeApiKey).toHaveBeenCalledWith(SESSION_USER.discordId);
  });

  it('redirects to ?error=revoke_failed on error', async () => {
    vi.mocked(revokeApiKey).mockRejectedValueOnce(new Error('DB error'));
    const res = await supertest(buildApp()).post('/streamdeck-key/revoke');
    expect(res.headers.location).toBe('/streamdeck-key?error=revoke_failed');
  });
});

// ─── GET /admin/streamdeck-keys ───────────────────────────────────────────────

describe('GET /admin/streamdeck-keys', () => {
  it('renders streamdeck-keys-admin with pending and all lists', async () => {
    vi.mocked(getPendingRequests).mockResolvedValue([{ discord_id: '1', status: 'pending' }] as any);
    vi.mocked(getAllApiKeys).mockResolvedValue([{ discord_id: '1', status: 'approved' }] as any);
    const res = await supertest(buildApp()).get('/admin/streamdeck-keys');
    expect(res.status).toBe(200);
    const body = res.body as any;
    expect(body.view).toBe('streamdeck-keys-admin');
    expect(body.locals.pending).toHaveLength(1);
    expect(body.locals.all).toHaveLength(1);
  });

  it('returns 500 on DB error', async () => {
    vi.mocked(getPendingRequests).mockRejectedValueOnce(new Error('DB down'));
    const app = express();
    app.use((req: any, _res: any, next: any) => { req.session = { user: SESSION_USER }; next(); });
    app.use((req: any, res: any, next: any) => {
      (req as any).csrfToken = () => 'tok';
      res.render = (view: string, locals: unknown) => res.status((res as any).statusCode).json({ view, locals });
      next();
    });
    app.use(router);
    const res = await supertest(app).get('/admin/streamdeck-keys');
    expect(res.status).toBe(500);
  });
});

// ─── POST /admin/streamdeck-keys/approve ─────────────────────────────────────

describe('POST /admin/streamdeck-keys/approve', () => {
  it('approves key and redirects to /admin/streamdeck-keys', async () => {
    const res = await supertest(buildApp()).post('/admin/streamdeck-keys/approve').send(`discord_id=${VALID_DISCORD_ID}`);
    expect(res.headers.location).toBe('/admin/streamdeck-keys');
    expect(approveApiKey).toHaveBeenCalledWith(VALID_DISCORD_ID, SESSION_USER.discordId, GUILD_ID);
  });

  it('redirects to ?error=invalid_discord_id for invalid ID', async () => {
    const res = await supertest(buildApp()).post('/admin/streamdeck-keys/approve').send('discord_id=bad');
    expect(res.headers.location).toBe('/admin/streamdeck-keys?error=invalid_discord_id');
  });

  it('redirects to ?error=approve_failed on DB error', async () => {
    vi.mocked(approveApiKey).mockRejectedValueOnce(new Error('DB error'));
    const res = await supertest(buildApp()).post('/admin/streamdeck-keys/approve').send(`discord_id=${VALID_DISCORD_ID}`);
    expect(res.headers.location).toBe('/admin/streamdeck-keys?error=approve_failed');
  });
});

// ─── POST /admin/streamdeck-keys/deny ────────────────────────────────────────

describe('POST /admin/streamdeck-keys/deny', () => {
  it('denies key and redirects', async () => {
    const res = await supertest(buildApp()).post('/admin/streamdeck-keys/deny').send(`discord_id=${VALID_DISCORD_ID}`);
    expect(res.headers.location).toBe('/admin/streamdeck-keys');
    expect(denyApiKey).toHaveBeenCalledWith(VALID_DISCORD_ID, GUILD_ID);
  });

  it('redirects to ?error=invalid_discord_id for invalid ID', async () => {
    const res = await supertest(buildApp()).post('/admin/streamdeck-keys/deny').send('discord_id=bad');
    expect(res.headers.location).toBe('/admin/streamdeck-keys?error=invalid_discord_id');
  });

  it('redirects to ?error=deny_failed on DB error', async () => {
    vi.mocked(denyApiKey).mockRejectedValueOnce(new Error('DB error'));
    const res = await supertest(buildApp()).post('/admin/streamdeck-keys/deny').send(`discord_id=${VALID_DISCORD_ID}`);
    expect(res.headers.location).toBe('/admin/streamdeck-keys?error=deny_failed');
  });
});

// ─── POST /admin/streamdeck-keys/revoke ──────────────────────────────────────

describe('POST /admin/streamdeck-keys/revoke', () => {
  it('revokes key and redirects', async () => {
    const res = await supertest(buildApp()).post('/admin/streamdeck-keys/revoke').send(`discord_id=${VALID_DISCORD_ID}`);
    expect(res.headers.location).toBe('/admin/streamdeck-keys');
    expect(revokeApiKey).toHaveBeenCalledWith(VALID_DISCORD_ID, GUILD_ID);
  });

  it('redirects to ?error=invalid_discord_id for invalid ID', async () => {
    const res = await supertest(buildApp()).post('/admin/streamdeck-keys/revoke').send('discord_id=bad');
    expect(res.headers.location).toBe('/admin/streamdeck-keys?error=invalid_discord_id');
  });

  it('redirects to ?error=revoke_failed on DB error', async () => {
    vi.mocked(revokeApiKey).mockRejectedValueOnce(new Error('DB error'));
    const res = await supertest(buildApp()).post('/admin/streamdeck-keys/revoke').send(`discord_id=${VALID_DISCORD_ID}`);
    expect(res.headers.location).toBe('/admin/streamdeck-keys?error=revoke_failed');
  });
});
