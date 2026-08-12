import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../../test-utils/loggerMock';
import { ACCESS_LEVEL_MOCK } from '../../test-utils/accessLevelMock';

vi.mock('../../db', () => ({
  getEffectiveAccessLevelForUser: vi.fn().mockResolvedValue(0),
  getAllGuilds: vi.fn(),
  getGuildsForMember: vi.fn(),
  findUser: vi.fn(),
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
import { findUser, getAllGuilds, getEffectiveAccessLevelForUser, getGuildsForMember } from '../../db';
import { AccessLevel } from '../../db';

const TWO_GUILDS = [
  { guildId: '100000000000000001', name: 'Alpha' },
  { guildId: '100000000000000002', name: 'Beta' },
];

const TWO_DB_GUILDS = [
  { guild_id: '100000000000000001', name: 'Alpha', voice_channel_id: null, access_level: AccessLevel.USER },
  { guild_id: '100000000000000002', name: 'Beta', voice_channel_id: null, access_level: AccessLevel.MANAGER },
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
  vi.mocked(getEffectiveAccessLevelForUser).mockResolvedValue(AccessLevel.USER);
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

  it.each(['invalid_guild', 'guild_not_found', 'select_failed'])(
    'passes a known ?error=%s code through to the view',
    async (error) => {
      const res = await supertest(buildApp({ discordId: 'u1', currentGuildId: null, guilds: TWO_GUILDS }))
        .get(`/guild/select?error=${error}`);
      expect(res.status).toBe(200);
      expect((res.body as any).locals.error).toBe(error);
    },
  );

  it('filters out an unrecognized ?error= code', async () => {
    const res = await supertest(buildApp({ discordId: 'u1', currentGuildId: null, guilds: TWO_GUILDS }))
      .get('/guild/select?error=not_a_real_code');
    expect(res.status).toBe(200);
    expect((res.body as any).locals.error).toBeNull();
  });
});

describe('POST /guild/select', () => {
  it('selects a guild the user belongs to, taking the access level from the already-fetched membership list', async () => {
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
    // Non-owner: the access level comes from getGuildsForMember's own access_level column,
    // not a second getEffectiveAccessLevelForUser query.
    expect(vi.mocked(getEffectiveAccessLevelForUser)).not.toHaveBeenCalled();
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
    expect(res.headers.location).toBe('/guild/select?error=guild_not_found');
    expect(user.currentGuildId).toBeNull();
    expect(vi.mocked(getEffectiveAccessLevelForUser)).not.toHaveBeenCalled();
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
    expect(res.headers.location).toBe('/guild/select?error=guild_not_found');
    expect(user.currentGuildId).toBeNull();
    expect(vi.mocked(getEffectiveAccessLevelForUser)).not.toHaveBeenCalled();
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

  it('refreshes the session guild list before rejecting a stale guild selection, and still shows the error once guilds shrinks to one', async () => {
    // Membership was revoked after login; the session's cached guild list is stale.
    // Even though the request is rejected, the session must be refreshed with the
    // live guild list so the picker doesn't keep rendering stale entries. That refresh
    // can leave the session with only one guild — GET /guild/select must still render
    // the error banner in that case instead of silently redirecting to `/`.
    vi.mocked(getGuildsForMember).mockResolvedValue([TWO_DB_GUILDS[0]] as any);
    const user: any = { discordId: 'u1', currentGuildId: null, accessLevel: AccessLevel.USER, guilds: TWO_GUILDS };
    const app = buildApp(user);

    const res = await supertest(app)
      .post('/guild/select')
      .type('form')
      .send({ guild_id: '100000000000000002' });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/guild/select?error=guild_not_found');
    expect(user.guilds).toEqual([{ guildId: '100000000000000001', name: 'Alpha' }]);

    const followUp = await supertest(app).get(res.headers.location);
    expect(followUp.status).toBe(200);
    expect((followUp.body as any).view).toBe('guildSelect');
    expect((followUp.body as any).locals.error).toBe('guild_not_found');
  });

  it('destroys the session and redirects to login when the live guild list is empty', async () => {
    vi.mocked(getGuildsForMember).mockResolvedValue([]);
    const user: any = { discordId: 'u1', currentGuildId: '100000000000000001', accessLevel: AccessLevel.USER, guilds: TWO_GUILDS };
    const destroy = vi.fn((cb: () => void) => cb());
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use((req: any, _res: any, next: any) => {
      req.session = { user, destroy };
      req.csrfToken = () => 'csrf-token';
      next();
    });
    app.use('/guild', router);

    const res = await supertest(app)
      .post('/guild/select')
      .type('form')
      .send({ guild_id: '100000000000000002' });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/auth/login?error=no_guilds');
    expect(destroy).toHaveBeenCalled();
    expect(vi.mocked(getEffectiveAccessLevelForUser)).not.toHaveBeenCalled();
  });

  it('destroys the session and redirects to login when the session user no longer exists in the database', async () => {
    vi.mocked(findUser).mockResolvedValue(null);
    const user: any = { discordId: 'u1', currentGuildId: null, accessLevel: AccessLevel.USER, guilds: TWO_GUILDS };
    const destroy = vi.fn((cb: () => void) => cb());
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use((req: any, _res: any, next: any) => {
      req.session = { user, destroy };
      req.csrfToken = () => 'csrf-token';
      next();
    });
    app.use('/guild', router);

    const res = await supertest(app)
      .post('/guild/select')
      .type('form')
      .send({ guild_id: '100000000000000002' });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/auth/login?error=user_not_found');
    expect(destroy).toHaveBeenCalled();
    expect(vi.mocked(getEffectiveAccessLevelForUser)).not.toHaveBeenCalled();
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
    expect(res.headers.location).toBe('/guild/select?error=invalid_guild');
    expect(vi.mocked(getEffectiveAccessLevelForUser)).not.toHaveBeenCalled();
  });

  it('redirects to the picker and does not mutate the session when an unexpected error occurs', async () => {
    // Non-owner: getGuildsForMember is the DB call still made on this path (access level
    // now comes from its result, not a separate getEffectiveAccessLevelForUser query).
    vi.mocked(getGuildsForMember).mockRejectedValue(new Error('DB unavailable'));
    const user: any = { discordId: 'u1', currentGuildId: null, accessLevel: AccessLevel.USER, guilds: TWO_GUILDS };
    const app = buildApp(user);

    const res = await supertest(app)
      .post('/guild/select')
      .type('form')
      .send({ guild_id: '100000000000000002' });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/guild/select?error=select_failed');
    expect(user.currentGuildId).toBeNull();
  });
});
