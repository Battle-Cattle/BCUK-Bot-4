import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db', () => ({
  getPublicSfxTriggers: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../shared/logger', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));
vi.mock('../middleware', () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('../../db/users', () => ({
  AccessLevel: { USER: 0, MOD: 1, MANAGER: 2, ADMIN: 3 },
}));

import express from 'express';
import supertest from 'supertest';
import { getPublicSfxTriggers } from '../../db';
import { AccessLevel } from '../../db/users';

let router: any;

function buildApp(sessionUser: unknown = { discordId: '1', discordName: 'Test', accessLevel: AccessLevel.USER }) {
  const app = express();
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

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.mocked(getPublicSfxTriggers).mockResolvedValue([]);
  router = (await import('./sfxPublic.js')).default;
});

describe('GET /sfx-list', () => {
  it('returns 500 and renders error page when getPublicSfxTriggers throws', async () => {
    vi.mocked(getPublicSfxTriggers).mockRejectedValueOnce(new Error('DB down'));
    const res = await supertest(buildApp()).get('/sfx-list');
    expect(res.status).toBe(500);
    expect((res.body as any).view).toBe('error');
  });

  it('renders sfx-public with triggers', async () => {
    const triggers = [{ triggerCommand: '!bang', categoryName: null, description: null }];
    vi.mocked(getPublicSfxTriggers).mockResolvedValue(triggers);
    const res = await supertest(buildApp()).get('/sfx-list');
    expect(res.status).toBe(200);
    const body = res.body as { view: string; locals: { triggers: unknown } };
    expect(body.view).toBe('sfx-public');
    expect(body.locals.triggers).toEqual(triggers);
  });

  it('passes session user to the template', async () => {
    const user = { discordId: '42', discordName: 'Alice', accessLevel: AccessLevel.MOD };
    vi.mocked(getPublicSfxTriggers).mockResolvedValue([]);
    const res = await supertest(buildApp(user)).get('/sfx-list');
    expect(res.status).toBe(200);
    expect((res.body as any).locals.user).toEqual(user);
  });

  it('passes null user when session has no user', async () => {
    vi.mocked(getPublicSfxTriggers).mockResolvedValue([]);
    const res = await supertest(buildApp(null)).get('/sfx-list');
    expect(res.status).toBe(200);
    expect((res.body as any).view).toBe('sfx-public');
    expect((res.body as any).locals.user).toBeNull();
  });
});
