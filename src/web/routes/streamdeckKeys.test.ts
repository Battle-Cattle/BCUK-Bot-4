import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db', () => ({
  hasApiKey: vi.fn().mockResolvedValue(false),
  createApiKeyAndRequestGuildAccess: vi.fn().mockResolvedValue({ plain: 'a'.repeat(64), status: 'pending' }),
  requestGuildAccessForExistingKey: vi.fn().mockResolvedValue({ status: 'pending' }),
  rotateApiKey: vi.fn().mockResolvedValue({ plain: 'b'.repeat(64) }),
  getGuildStatusForKey: vi.fn().mockResolvedValue(null),
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
  hasApiKey, createApiKeyAndRequestGuildAccess, requestGuildAccessForExistingKey, rotateApiKey,
  getGuildStatusForKey, revokeApiKey,
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
  vi.mocked(hasApiKey).mockResolvedValue(false);
  vi.mocked(createApiKeyAndRequestGuildAccess).mockResolvedValue({ plain: 'a'.repeat(64), status: 'pending' } as any);
  vi.mocked(requestGuildAccessForExistingKey).mockResolvedValue({ status: 'pending' } as any);
  vi.mocked(rotateApiKey).mockResolvedValue({ plain: 'b'.repeat(64) } as any);
  vi.mocked(getGuildStatusForKey).mockResolvedValue(null);
  vi.mocked(getAllApiKeys).mockResolvedValue([]);
  vi.mocked(getPendingRequests).mockResolvedValue([]);
});

// ─── GET /streamdeck-key ──────────────────────────────────────────────────────

describe('GET /streamdeck-key', () => {
  it('renders streamdeck-keys with keyRow and webPort', async () => {
    const keyRow = { discord_id: '1', guild_id: GUILD_ID, status: 'pending', requested_at: new Date(), approved_at: null, approved_by: null };
    vi.mocked(getGuildStatusForKey).mockResolvedValue(keyRow as any);
    const res = await supertest(buildApp()).get('/streamdeck-key');
    expect(res.status).toBe(200);
    const body = res.body as any;
    expect(body.view).toBe('streamdeck-keys');
    expect(body.locals.keyRow).toMatchObject({ discord_id: '1', status: 'pending' });
    expect(body.locals.webPort).toBe(3000);
    expect(body.locals.newKey).toBeNull();
    expect(getGuildStatusForKey).toHaveBeenCalledWith(SESSION_USER.discordId, GUILD_ID);
  });

  it('returns 500 on DB error', async () => {
    vi.mocked(getGuildStatusForKey).mockRejectedValueOnce(new Error('DB down'));
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
  it('mints a brand-new key when the user has no existing guild status and no key', async () => {
    vi.mocked(getGuildStatusForKey)
      .mockResolvedValueOnce(null) // pre-check
      .mockResolvedValueOnce({ discord_id: '1', guild_id: GUILD_ID, status: 'pending' } as any); // post-request
    vi.mocked(hasApiKey).mockResolvedValue(false);

    const res = await supertest(buildApp()).post('/streamdeck-key/request');

    expect(res.status).toBe(200);
    expect((res.body as any).locals.newKey).toBeTruthy();
    expect(createApiKeyAndRequestGuildAccess).toHaveBeenCalledWith(SESSION_USER.discordId, SESSION_USER.accessLevel, GUILD_ID);
    expect(requestGuildAccessForExistingKey).not.toHaveBeenCalled();
    expect(rotateApiKey).not.toHaveBeenCalled();
  });

  it('reuses the existing key with no new plaintext when the user already has a key from another guild', async () => {
    vi.mocked(getGuildStatusForKey)
      .mockResolvedValueOnce(null) // no status for this guild yet
      .mockResolvedValueOnce({ discord_id: '1', guild_id: GUILD_ID, status: 'pending' } as any);
    vi.mocked(hasApiKey).mockResolvedValue(true);

    const res = await supertest(buildApp()).post('/streamdeck-key/request');

    expect(res.status).toBe(200);
    expect((res.body as any).locals.newKey).toBeNull();
    expect(requestGuildAccessForExistingKey).toHaveBeenCalledWith(SESSION_USER.discordId, SESSION_USER.accessLevel, GUILD_ID);
    expect(createApiKeyAndRequestGuildAccess).not.toHaveBeenCalled();
  });

  it('rotates the key when a guild status already exists for this guild (lost-key flow)', async () => {
    vi.mocked(getGuildStatusForKey).mockResolvedValue({ discord_id: '1', guild_id: GUILD_ID, status: 'approved' } as any);

    const res = await supertest(buildApp()).post('/streamdeck-key/request');

    expect(res.status).toBe(200);
    expect((res.body as any).locals.newKey).toBeTruthy();
    expect(rotateApiKey).toHaveBeenCalledWith(SESSION_USER.discordId);
    expect(createApiKeyAndRequestGuildAccess).not.toHaveBeenCalled();
    expect(requestGuildAccessForExistingKey).not.toHaveBeenCalled();
  });

  it('redirects to ?error=request_failed when this guild was previously denied', async () => {
    vi.mocked(getGuildStatusForKey).mockResolvedValue({ discord_id: '1', guild_id: GUILD_ID, status: 'denied' } as any);

    const res = await supertest(buildApp()).post('/streamdeck-key/request');

    expect(res.headers.location).toBe('/streamdeck-key?error=request_failed');
    expect(rotateApiKey).not.toHaveBeenCalled();
  });

  it('redirects to ?error=request_failed on error', async () => {
    vi.mocked(createApiKeyAndRequestGuildAccess).mockRejectedValueOnce(new Error('DB error'));
    const res = await supertest(buildApp()).post('/streamdeck-key/request');
    expect(res.headers.location).toBe('/streamdeck-key?error=request_failed');
  });
});

// ─── POST /streamdeck-key/revoke ──────────────────────────────────────────────

describe('POST /streamdeck-key/revoke', () => {
  it('redirects to /streamdeck-key on success, scoped to the current guild', async () => {
    const res = await supertest(buildApp()).post('/streamdeck-key/revoke');
    expect(res.headers.location).toBe('/streamdeck-key');
    expect(revokeApiKey).toHaveBeenCalledWith(SESSION_USER.discordId, GUILD_ID);
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
