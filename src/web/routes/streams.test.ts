import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db', () => ({
  getStreamGroupsForGuild: vi.fn(),
  getStreamersForGuild: vi.fn(),
  getAllEventSubStreamers: vi.fn(),
  getAllUsers: vi.fn(),
  addStreamGroup: vi.fn(),
  updateStreamGroup: vi.fn(),
  removeStreamGroupAndStreamers: vi.fn(),
  addStreamer: vi.fn(),
  removeStreamer: vi.fn(),
  findUser: vi.fn(),
  AccessLevel: { USER: 0, MOD: 1, MANAGER: 2, ADMIN: 3 },
}));

vi.mock('../csrf', () => ({
  csrfProtection: (req: any, _res: any, next: any) => {
    req.csrfToken = () => 'test-csrf-token';
    next();
  },
}));

vi.mock('../middleware', () => ({
  requireManager: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../../twitch/monitor/twitchMonitor', () => ({
  restartTwitchMonitor: vi.fn(),
  getLiveStates: vi.fn().mockReturnValue([]),
}));

vi.mock('../../shared/logger', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

vi.mock('../../db/users', () => ({ AccessLevel: { USER: 0, MOD: 1, MANAGER: 2, ADMIN: 3 } }));

import express from 'express';
import supertest from 'supertest';
import router from './streams';
import {
  getStreamGroupsForGuild, getStreamersForGuild, getAllUsers, getAllEventSubStreamers,
  addStreamGroup, addStreamer, findUser,
} from '../../db';
import { getLiveStates } from '../../twitch/monitor/twitchMonitor';
import { AccessLevel } from '../../db/users';

const GUILD_ID = '900000000000000001';
type SessionUser = { discordId: string; discordName: string; discordAvatar: string | null; accessLevel: 0 | 1 | 2 | 3; currentGuildId: string };
const MANAGER: SessionUser = { discordId: '200000000000000001', discordName: 'ManagerUser', discordAvatar: null, accessLevel: AccessLevel.MANAGER, currentGuildId: GUILD_ID };

function buildApp(sessionUser: SessionUser = MANAGER) {
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
  vi.mocked(getStreamGroupsForGuild).mockResolvedValue([]);
  vi.mocked(getStreamersForGuild).mockResolvedValue([]);
  vi.mocked(getAllUsers).mockResolvedValue([]);
  vi.mocked(getAllEventSubStreamers).mockResolvedValue([]);
  vi.mocked(getLiveStates).mockReturnValue([]);
  vi.mocked(addStreamGroup).mockResolvedValue(undefined);
  vi.mocked(addStreamer).mockResolvedValue(undefined);
  vi.mocked(findUser).mockResolvedValue(null);
});

describe('GET /streams — query param filtering', () => {
  it('passes a known error to the template', async () => {
    const res = await supertest(buildApp()).get('/streams?error=missing_fields');
    expect(res.status).toBe(200);
    expect(res.body.error).toBe('missing_fields');
  });

  it('filters an unknown error to null', async () => {
    const res = await supertest(buildApp()).get('/streams?error=arbitrary_injection');
    expect(res.status).toBe(200);
    expect(res.body.error).toBeNull();
  });

  it('filters any success param to null (no known success codes defined)', async () => {
    const res = await supertest(buildApp()).get('/streams?success=arbitrary_injection');
    expect(res.status).toBe(200);
    expect(res.body.success).toBeNull();
  });

  it('returns 500 when getStreamGroupsForGuild throws', async () => {
    vi.mocked(getStreamGroupsForGuild).mockRejectedValue(new Error('DB down'));
    const res = await supertest(buildApp()).get('/streams');
    expect(res.status).toBe(500);
  });
});

describe('GET /streams/live', () => {
  it('returns the current live states as JSON', async () => {
    vi.mocked(getLiveStates).mockReturnValue([{ login: 'streamera' } as any]);
    const res = await supertest(buildApp()).get('/streams/live');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ streams: [{ login: 'streamera' }] });
    expect(getLiveStates).toHaveBeenCalledWith(GUILD_ID);
  });
});

describe('GET /streams — eligible users and admin EventSub status', () => {
  it('includes users with a Twitch name who are not already streamers, excluding the rest', async () => {
    vi.mocked(getStreamersForGuild).mockResolvedValue([{ discord_id: '1', twitch_name: 'existing' }] as any);
    vi.mocked(getAllUsers).mockResolvedValue([
      { discord_id: '1', twitch_name: 'existing' }, // already a streamer
      { discord_id: '2', twitch_name: 'eligible' }, // eligible
      { discord_id: '3', twitch_name: null }, // no Twitch name
    ] as any);

    const res = await supertest(buildApp()).get('/streams');

    expect(res.status).toBe(200);
    expect(res.body.eligibleUsers).toEqual([{ discord_id: '2', twitch_name: 'eligible' }]);
  });

  it('builds eventSubById keyed by streamer row id for admin users, and skips the lookup for non-admins', async () => {
    vi.mocked(getAllEventSubStreamers).mockResolvedValue([{ id: 42, twitch_name: 'admineligible' }] as any);
    const admin: SessionUser = { discordId: '300000000000000001', discordName: 'AdminUser', discordAvatar: null, accessLevel: AccessLevel.ADMIN, currentGuildId: GUILD_ID };

    const res = await supertest(buildApp(admin)).get('/streams');

    expect(res.status).toBe(200);
    expect(getAllEventSubStreamers).toHaveBeenCalled();
    expect(res.body.eventSubById).toEqual({ 42: { id: 42, twitch_name: 'admineligible' } });
  });

  it('does not query EventSub streamers for a non-admin manager', async () => {
    const res = await supertest(buildApp()).get('/streams');

    expect(res.status).toBe(200);
    expect(getAllEventSubStreamers).not.toHaveBeenCalled();
    expect(res.body.eventSubById).toEqual({});
  });
});

describe('getFriendlyError — unknown error code fallback', () => {
  it('falls back to a generic message including the error code for unrecognised keys', async () => {
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use((req: any, res: any, next: any) => {
      req.session = { user: MANAGER };
      res.render = (view: string, locals: any) => res.json({ view, friendlyError: locals.getFriendlyError('totally_made_up') });
      next();
    });
    app.use(router);

    const res = await supertest(app).get('/streams');

    expect(res.status).toBe(200);
    expect(res.body.friendlyError).toBe('An error occurred (totally_made_up).');
  });
});

describe('streams router composition', () => {
  it('mounts the groups sub-router', async () => {
    const res = await supertest(buildApp())
      .post('/streams/groups/add')
      .send('name=n&discord_channel=chan&live_message=live&new_game_message=game');
    expect(res.status).toBe(302);
    expect(addStreamGroup).toHaveBeenCalled();
  });

  it('mounts the streamers sub-router', async () => {
    vi.mocked(findUser).mockResolvedValue({ twitch_name: 'streamer', discord_id: '100000000000000001' } as any);
    const res = await supertest(buildApp())
      .post('/streams/streamers/add')
      .send('discord_id=100000000000000001&group_id=1');
    expect(res.status).toBe(302);
    expect(addStreamer).toHaveBeenCalled();
  });
});
