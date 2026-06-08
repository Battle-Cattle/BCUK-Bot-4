import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db', () => ({
  findUser: vi.fn(),
  getStreamerByDiscordId: vi.fn(),
  saveEventConfig: vi.fn(),
  clearStreamerToken: vi.fn(),
  updateGuildRoutingRecord: vi.fn(),
  AccessLevel: { USER: 0, MOD: 1, MANAGER: 2, ADMIN: 3 },
}));

vi.mock('../csrf', () => ({
  csrfProtection: (req: any, _res: any, next: any) => {
    req.csrfToken = () => 'test-csrf-token';
    next();
  },
}));

vi.mock('../middleware', () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../../twitch/eventsub/twitchEventSub', () => ({
  reloadEventSubSubscriptions: vi.fn(),
}));

vi.mock('../../twitch/eventsub/twitchEventSubSubscriptions', () => ({
  hasAuthFailedSubs: vi.fn().mockReturnValue(false),
}));

vi.mock('../../shared/config', () => ({
  TWITCH_CLIENT_ID: 'test-client-id',
  TWITCH_EVENTSUB_REDIRECT_URI: 'http://localhost/callback',
  EVENTSUB_TOKEN_SECRET: 'test-secret',
}));

vi.mock('../../shared/logger', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

import express from 'express';
import supertest from 'supertest';
import router from './userSettings';
import { findUser, getStreamerByDiscordId, updateGuildRoutingRecord } from '../../db';
import { AccessLevel } from '../../db/users';

type SessionUser = { discordId: string; discordName: string; discordAvatar: string | null; accessLevel: 0 | 1 | 2 | 3 };
const USER: SessionUser = { discordId: '100000000000000001', discordName: 'TestUser', discordAvatar: null, accessLevel: AccessLevel.MOD };

function buildApp(sessionUser: SessionUser = USER) {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use((req: any, res: any, next: any) => {
    req.session = { user: sessionUser };
    res.render = (view: string, locals?: any) => res.json({ view, ...locals });
    next();
  });
  app.use(router);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(findUser).mockResolvedValue(null);
  vi.mocked(getStreamerByDiscordId).mockResolvedValue(null);
});

describe('GET / — query param filtering', () => {
  it('passes a known error to the template', async () => {
    const res = await supertest(buildApp()).get('/?error=no_streamer_record');
    expect(res.status).toBe(200);
    expect(res.body.error).toBe('no_streamer_record');
  });

  it('filters an unknown error to null', async () => {
    const res = await supertest(buildApp()).get('/?error=arbitrary_injection');
    expect(res.status).toBe(200);
    expect(res.body.error).toBeNull();
  });

  it('passes a known success to the template', async () => {
    const res = await supertest(buildApp()).get('/?success=twitch_connected');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe('twitch_connected');
  });

  it('filters an unknown success to null', async () => {
    const res = await supertest(buildApp()).get('/?success=arbitrary_injection');
    expect(res.status).toBe(200);
    expect(res.body.success).toBeNull();
  });

  it('returns 500 when db throws', async () => {
    vi.mocked(findUser).mockRejectedValue(new Error('DB down'));
    const res = await supertest(buildApp()).get('/');
    expect(res.status).toBe(500);
  });
});

describe('GET / — successExpectedAccount', () => {
  it('uses the DB twitch_name value (not the query param) when they match', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue({
      id: 1,
      discord_id: USER.discordId,
      twitch_name: 'MyChannel',
      twitch_user_id: null,
      eventsub_access_token: null,
      eventsub_refresh_token: null,
      config: null,
      is_twitch_bot_enabled: false,
    } as any);

    const res = await supertest(buildApp()).get('/?error=eventsub_wrong_account&expected=mychannel');
    expect(res.status).toBe(200);
    expect(res.body.successExpectedAccount).toBe('MyChannel');
  });

  it('returns undefined when expected does not match twitch_name', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue({
      id: 1,
      twitch_name: 'MyChannel',
      eventsub_access_token: null,
      eventsub_refresh_token: null,
      config: null,
    } as any);

    const res = await supertest(buildApp()).get('/?error=eventsub_wrong_account&expected=OtherChannel');
    expect(res.status).toBe(200);
    expect(res.body.successExpectedAccount).toBeUndefined();
  });

  it('returns undefined when expected is an array', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue({
      id: 1,
      twitch_name: 'MyChannel',
      eventsub_access_token: null,
      eventsub_refresh_token: null,
      config: null,
    } as any);

    const res = await supertest(buildApp()).get('/?error=eventsub_wrong_account&expected=mychannel&expected=other');
    expect(res.status).toBe(200);
    expect(res.body.successExpectedAccount).toBeUndefined();
  });
});

describe('POST /guild-routing', () => {
  const MANAGER_USER: SessionUser = { ...USER, accessLevel: AccessLevel.MANAGER };

  function buildDbUser(overrides: Record<string, unknown> = {}) {
    return {
      discord_id: MANAGER_USER.discordId,
      discord_name: 'TestUser',
      is_twitch_bot_enabled: false,
      twitch_name: null,
      access_level: AccessLevel.MANAGER,
      discord_guild_id: null,
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.mocked(updateGuildRoutingRecord).mockResolvedValue(undefined);
  });

  it('saves a valid guild ID and redirects to success', async () => {
    vi.mocked(findUser).mockResolvedValue(buildDbUser() as any);

    const res = await supertest(buildApp(MANAGER_USER))
      .post('/guild-routing')
      .send('discord_guild_id=123456789012345678');

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/user/settings?success=guild_routing_saved');
    expect(vi.mocked(updateGuildRoutingRecord)).toHaveBeenCalledWith(MANAGER_USER.discordId, '123456789012345678');
  });

  it('clears routing when guild ID is empty and redirects to success', async () => {
    vi.mocked(findUser).mockResolvedValue(buildDbUser({ discord_guild_id: '999' }) as any);

    const res = await supertest(buildApp(MANAGER_USER))
      .post('/guild-routing')
      .send('discord_guild_id=');

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/user/settings?success=guild_routing_saved');
    expect(vi.mocked(updateGuildRoutingRecord)).toHaveBeenCalledWith(MANAGER_USER.discordId, null);
  });

  it('redirects to invalid error for a non-numeric guild ID', async () => {
    vi.mocked(findUser).mockResolvedValue(buildDbUser() as any);

    const res = await supertest(buildApp(MANAGER_USER))
      .post('/guild-routing')
      .send('discord_guild_id=not-a-snowflake');

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/user/settings?error=guild_routing_invalid');
    expect(vi.mocked(updateGuildRoutingRecord)).not.toHaveBeenCalled();
  });

  it('redirects to forbidden error when user is below Manager level', async () => {
    const modUser: SessionUser = { ...USER, accessLevel: AccessLevel.MOD };
    vi.mocked(findUser).mockResolvedValue(buildDbUser({ access_level: AccessLevel.MOD }) as any);

    const res = await supertest(buildApp(modUser))
      .post('/guild-routing')
      .send('discord_guild_id=123456789012345678');

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/user/settings?error=guild_routing_forbidden');
    expect(vi.mocked(updateGuildRoutingRecord)).not.toHaveBeenCalled();
  });

  it('redirects to failed error when DB throws', async () => {
    vi.mocked(findUser).mockResolvedValue(buildDbUser() as any);
    vi.mocked(updateGuildRoutingRecord).mockRejectedValue(new Error('DB down'));

    const res = await supertest(buildApp(MANAGER_USER))
      .post('/guild-routing')
      .send('discord_guild_id=123456789012345678');

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/user/settings?error=guild_routing_failed');
  });
});
