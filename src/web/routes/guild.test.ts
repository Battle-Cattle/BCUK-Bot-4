import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../../test-utils/loggerMock';
import { ACCESS_LEVEL_MOCK } from '../../test-utils/accessLevelMock';

vi.mock('../../db', () => ({
  getEffectiveAccessLevel: vi.fn().mockResolvedValue(0),
  getAllGuilds: vi.fn(),
  getGuildsForMember: vi.fn(),
  findUser: vi.fn(),
}));
vi.mock('../../db/users', () => ({
  AccessLevel: ACCESS_LEVEL_MOCK,
}));
vi.mock('../csrf', () => ({
  csrfProtection: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('../middleware', () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));

import express from 'express';
import supertest from 'supertest';
import router from './guild';
import { findUser, getAllGuilds, getEffectiveAccessLevel, getGuildsForMember } from '../../db';
import { AccessLevel } from '../../db/users';

const TWO_GUILDS = [
  { guildId: '100000000000000001', name: 'Alpha' },
  { guildId: '100000000000000002', name: 'Beta' },
];

const TWO_DB_GUILDS = [
  { guild_id: '100000000000000001', name: 'Alpha', voice_channel_id: null },
  { guild_id: '100000000000000002', name: 'Beta', voice_channel_id: null },
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
  vi.mocked(getEffectiveAccessLevel).mockResolvedValue(AccessLevel.USER);
  vi.mocked(getGuildsForMember).mockResolvedValue(TWO_DB_GUILDS as any);
  vi.mocked(getAllGuilds).mockResolvedValue(TWO_DB_GUILDS as any);
  vi.mocked(findUser).mockResolvedValue({ discord_id: 'u1', is_owner: false } as any);
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
    vi.mocked(getEffectiveAccessLevel).mockResolvedValue(AccessLevel.MANAGER);
    const user: any = { discordId: 'u1', currentGuildId: null, accessLevel: AccessLevel.USER, guilds: TWO_GUILDS };
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
    expect(user.accessLevel).toBe(AccessLevel.MANAGER);
    expect(vi.mocked(getEffectiveAccessLevel)).toHaveBeenCalledWith('100000000000000002', 'u1');
  });

  it('rejects a guild the user does not belong to (cross-guild IDOR guard)', async () => {
    const user: any = { discordId: 'u1', currentGuildId: null, accessLevel: AccessLevel.USER, guilds: TWO_GUILDS };
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

  it('rejects a guild present in the stale session list but no longer returned by getGuildsForMember', async () => {
    // Membership was revoked after login; the session's cached guild list is stale,
    // but the live DB lookup no longer includes it, so the guard must still reject.
    vi.mocked(getGuildsForMember).mockResolvedValue([TWO_DB_GUILDS[0]] as any);
    const user: any = { discordId: 'u1', currentGuildId: null, accessLevel: AccessLevel.USER, guilds: TWO_GUILDS };
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
    expect(res.headers.location).toBe('/guild/select');
    expect(user.currentGuildId).toBeNull();
    expect(vi.mocked(getEffectiveAccessLevel)).not.toHaveBeenCalled();
  });

  it('uses getAllGuilds (not getGuildsForMember) when the user is the bot owner', async () => {
    vi.mocked(findUser).mockResolvedValue({ discord_id: 'u1', is_owner: true } as any);
    const user: any = {
      discordId: 'u1',
      currentGuildId: null,
      accessLevel: AccessLevel.USER,
      isOwner: false,
      guilds: TWO_GUILDS,
    };
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
    expect(user.isOwner).toBe(true);
    expect(vi.mocked(getAllGuilds)).toHaveBeenCalled();
    expect(vi.mocked(getGuildsForMember)).not.toHaveBeenCalled();
  });

  it('ignores a stale session-cached isOwner flag and re-derives it from the database', async () => {
    // Session says owner, but the live DB record says otherwise (e.g. revoked) — the
    // route must trust the DB, not the cached session value.
    vi.mocked(findUser).mockResolvedValue({ discord_id: 'u1', is_owner: false } as any);
    const user: any = {
      discordId: 'u1',
      currentGuildId: null,
      accessLevel: AccessLevel.USER,
      isOwner: true,
      guilds: TWO_GUILDS,
    };
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use((req: any, _res: any, next: any) => {
      req.session = { user };
      req.csrfToken = () => 'csrf-token';
      next();
    });
    app.use('/guild', router);

    await supertest(app)
      .post('/guild/select')
      .type('form')
      .send({ guild_id: '100000000000000002' });

    expect(user.isOwner).toBe(false);
    expect(vi.mocked(getGuildsForMember)).toHaveBeenCalled();
    expect(vi.mocked(getAllGuilds)).not.toHaveBeenCalled();
  });

  it('refreshes the session guild list before rejecting a stale guild selection', async () => {
    // Membership was revoked after login; the session's cached guild list is stale.
    // Even though the request is rejected, the session must be refreshed with the
    // live guild list so the picker doesn't keep rendering stale entries.
    vi.mocked(getGuildsForMember).mockResolvedValue([TWO_DB_GUILDS[0]] as any);
    const user: any = { discordId: 'u1', currentGuildId: null, accessLevel: AccessLevel.USER, guilds: TWO_GUILDS };
    const app = buildApp(user);

    const res = await supertest(app)
      .post('/guild/select')
      .type('form')
      .send({ guild_id: '100000000000000002' });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/guild/select');
    expect(user.guilds).toEqual([{ guildId: '100000000000000001', name: 'Alpha' }]);
  });

  it('redirects to login when the live guild list is empty', async () => {
    vi.mocked(getGuildsForMember).mockResolvedValue([]);
    const user: any = { discordId: 'u1', currentGuildId: '100000000000000001', accessLevel: AccessLevel.USER, guilds: TWO_GUILDS };
    const app = buildApp(user);

    const res = await supertest(app)
      .post('/guild/select')
      .type('form')
      .send({ guild_id: '100000000000000002' });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/auth/login');
    expect(user.currentGuildId).toBeNull();
    expect(vi.mocked(getEffectiveAccessLevel)).not.toHaveBeenCalled();
  });

  it('redirects to login when the session user no longer exists in the database', async () => {
    vi.mocked(findUser).mockResolvedValue(null);
    const user: any = { discordId: 'u1', currentGuildId: null, accessLevel: AccessLevel.USER, guilds: TWO_GUILDS };
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
    expect(res.headers.location).toBe('/auth/login');
    expect(vi.mocked(getEffectiveAccessLevel)).not.toHaveBeenCalled();
  });

  it('rejects a malformed guild ID', async () => {
    const user: any = { discordId: 'u1', currentGuildId: null, accessLevel: AccessLevel.USER, guilds: TWO_GUILDS };
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

  it('redirects to the picker and does not mutate the session when an unexpected error occurs', async () => {
    vi.mocked(getEffectiveAccessLevel).mockRejectedValue(new Error('DB unavailable'));
    const user: any = { discordId: 'u1', currentGuildId: null, accessLevel: AccessLevel.USER, guilds: TWO_GUILDS };
    const app = buildApp(user);

    const res = await supertest(app)
      .post('/guild/select')
      .type('form')
      .send({ guild_id: '100000000000000002' });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/guild/select');
    expect(user.currentGuildId).toBeNull();
  });
});
