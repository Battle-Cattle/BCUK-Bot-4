import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db', () => ({
  getEffectiveAccessLevel: vi.fn().mockResolvedValue(0),
}));
vi.mock('../csrf', () => ({
  csrfProtection: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('../middleware', () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('../../shared/logger', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

import express from 'express';
import supertest from 'supertest';
import router from './guild';
import { getEffectiveAccessLevel } from '../../db';

const TWO_GUILDS = [
  { guildId: '100000000000000001', name: 'Alpha' },
  { guildId: '100000000000000002', name: 'Beta' },
];

function buildApp(sessionUser: unknown) {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use((req: any, _res: any, next: any) => {
    req.session = { user: sessionUser };
    req.csrfToken = () => 'csrf-token';
    next();
  });
  app.use((req: any, res: any, next: any) => {
    res.render = (view: string, locals: unknown) => res.status(200).json({ view, locals });
    next();
  });
  app.use('/guild', router);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getEffectiveAccessLevel).mockResolvedValue(0);
});

describe('GET /guild/select', () => {
  it('renders the picker when the user has multiple guilds', async () => {
    const res = await supertest(buildApp({ discordId: 'u1', currentGuildId: null, guilds: TWO_GUILDS }))
      .get('/guild/select');
    expect(res.status).toBe(200);
    expect((res.body as any).view).toBe('guildSelect');
    expect((res.body as any).locals.guilds).toHaveLength(2);
  });

  it('redirects to / when the user has a single guild', async () => {
    const res = await supertest(buildApp({ discordId: 'u1', currentGuildId: '100000000000000001', guilds: [TWO_GUILDS[0]] }))
      .get('/guild/select');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');
  });
});

describe('POST /guild/select', () => {
  it('selects a guild the user belongs to and recomputes the access level', async () => {
    vi.mocked(getEffectiveAccessLevel).mockResolvedValue(2);
    const user: any = { discordId: 'u1', currentGuildId: null, accessLevel: 0, guilds: TWO_GUILDS };
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use((req: any, _res: any, next: any) => {
      req.session = { user };
      req.csrfToken = () => 'csrf-token';
      next();
    });
    app.use('/guild', router);

    const res = await supertest(app)
      .post('/guild/select')
      .type('form')
      .send({ guild_id: '100000000000000002' });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');
    expect(user.currentGuildId).toBe('100000000000000002');
    expect(user.accessLevel).toBe(2);
    expect(vi.mocked(getEffectiveAccessLevel)).toHaveBeenCalledWith('100000000000000002', 'u1');
  });

  it('rejects a guild the user does not belong to (cross-guild IDOR guard)', async () => {
    const user: any = { discordId: 'u1', currentGuildId: null, accessLevel: 0, guilds: TWO_GUILDS };
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use((req: any, _res: any, next: any) => {
      req.session = { user };
      req.csrfToken = () => 'csrf-token';
      next();
    });
    app.use('/guild', router);

    const res = await supertest(app)
      .post('/guild/select')
      .type('form')
      .send({ guild_id: '999000999000999000' });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/guild/select');
    expect(user.currentGuildId).toBeNull();
    expect(vi.mocked(getEffectiveAccessLevel)).not.toHaveBeenCalled();
  });

  it('rejects a malformed guild ID', async () => {
    const user: any = { discordId: 'u1', currentGuildId: null, accessLevel: 0, guilds: TWO_GUILDS };
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use((req: any, _res: any, next: any) => {
      req.session = { user };
      req.csrfToken = () => 'csrf-token';
      next();
    });
    app.use('/guild', router);

    const res = await supertest(app)
      .post('/guild/select')
      .type('form')
      .send({ guild_id: 'not-a-snowflake' });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/guild/select');
    expect(vi.mocked(getEffectiveAccessLevel)).not.toHaveBeenCalled();
  });
});
