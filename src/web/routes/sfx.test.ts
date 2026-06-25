import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db', () => ({
  getAllSfxTriggers: vi.fn().mockResolvedValue([]),
  getAllCategories: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../shared/logger', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));
vi.mock('../../shared/config', () => ({ SFX_MAX_FILE_MB: 10 }));
vi.mock('../csrf', () => ({
  csrfProtection: (req: any, _res: any, next: any) => {
    req.csrfToken = () => 'test-csrf-token';
    next();
  },
}));
vi.mock('../../db/users', () => ({
  AccessLevel: { USER: 0, MOD: 1, MANAGER: 2, ADMIN: 3 },
}));

import express from 'express';
import supertest from 'supertest';
import router from './sfx';
import { getAllSfxTriggers, getAllCategories } from '../../db';
import { AccessLevel } from '../../db/users';

/**
 * Build a supertest GET request against the SFX view router with a stubbed session
 * and a render mock that echoes the view name and locals as JSON.
 * @param sessionUser Session user to attach to the request (defaults to a level-0 user).
 * @param query Optional query string appended to `/sfx` (e.g. `?error=invalid_id`).
 * @returns A supertest request for `GET /sfx`.
 */
function buildApp(sessionUser: any = { discordId: '1', accessLevel: AccessLevel.USER }, query = '') {
  const app = express();
  app.use((req: any, _res: any, next: any) => {
    req.session = { user: sessionUser };
    next();
  });
  app.use((_req: any, res: any, next: any) => {
    res.render = (view: string, locals: unknown) => res.json({ view, locals });
    next();
  });
  app.use(router);
  return supertest(app).get('/sfx' + query);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAllSfxTriggers).mockResolvedValue([]);
  vi.mocked(getAllCategories).mockResolvedValue([]);
});

describe('GET /sfx', () => {
  it('renders the sfx view with triggers and categories', async () => {
    vi.mocked(getAllCategories).mockResolvedValue([{ id: 1, name: 'Reactions' }]);
    const res = await buildApp();
    expect(res.status).toBe(200);
    expect((res.body as any).view).toBe('sfx');
    expect((res.body as any).locals.categories).toEqual([{ id: 1, name: 'Reactions' }]);
    expect((res.body as any).locals.maxUploadMb).toBe(10);
  });

  it('sets canManage=false for a level-0 user', async () => {
    const res = await buildApp({ discordId: '1', accessLevel: AccessLevel.USER });
    expect((res.body as any).locals.canManage).toBe(false);
  });

  it('sets canManage=true for a Mod', async () => {
    const res = await buildApp({ discordId: '1', accessLevel: AccessLevel.MOD });
    expect((res.body as any).locals.canManage).toBe(true);
  });

  it('passes through a known error query param and ignores unknown ones', async () => {
    const known = await buildApp({ discordId: '1', accessLevel: AccessLevel.MOD }, '?error=command_taken');
    expect((known.body as any).locals.error).toBe('command_taken');
    const unknown = await buildApp({ discordId: '1', accessLevel: AccessLevel.MOD }, '?error=nonsense');
    expect((unknown.body as any).locals.error).toBeNull();
  });

  it('passes through a known success query param', async () => {
    const res = await buildApp({ discordId: '1', accessLevel: AccessLevel.MOD }, '?success=trigger_added');
    expect((res.body as any).locals.success).toBe('trigger_added');
  });

  it('returns 500 and renders the error page when the DB query fails', async () => {
    vi.mocked(getAllSfxTriggers).mockRejectedValueOnce(new Error('DB down'));
    const res = await buildApp();
    expect(res.status).toBe(500);
    expect((res.body as any).view).toBe('error');
  });
});
