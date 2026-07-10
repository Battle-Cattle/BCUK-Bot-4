import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db', () => ({
  getStreamGroupsForGuild: vi.fn(),
  addStreamGroup: vi.fn(),
  updateStreamGroup: vi.fn(),
  removeStreamGroup: vi.fn(),
  getStreamersForGuild: vi.fn(),
  addStreamer: vi.fn(),
  removeStreamer: vi.fn(),
  removeStreamersByGroup: vi.fn(),
  getAllEventSubStreamers: vi.fn(),
  getAllUsers: vi.fn(),
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

const { logMock } = vi.hoisted(() => ({
  logMock: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
vi.mock('../../shared/logger', () => ({
  createLogger: () => logMock,
}));

vi.mock('../../db/users', () => ({ AccessLevel: { USER: 0, MOD: 1, MANAGER: 2, ADMIN: 3 } }));

import express from 'express';
import supertest from 'supertest';
import router from './streams';
import {
  getStreamGroupsForGuild, getStreamersForGuild, getAllUsers, findUser, addStreamer, addStreamGroup, updateStreamGroup,
  removeStreamGroup, removeStreamer, removeStreamersByGroup, getAllEventSubStreamers,
} from '../../db';
import { restartTwitchMonitor, getLiveStates } from '../../twitch/monitor/twitchMonitor';
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
  vi.mocked(findUser).mockResolvedValue(null);
  vi.mocked(addStreamer).mockResolvedValue(undefined);
  vi.mocked(addStreamGroup).mockResolvedValue(undefined);
  vi.mocked(updateStreamGroup).mockResolvedValue(undefined);
  vi.mocked(removeStreamGroup).mockResolvedValue(undefined);
  vi.mocked(removeStreamer).mockResolvedValue(undefined);
  vi.mocked(removeStreamersByGroup).mockResolvedValue(undefined);
  vi.mocked(getAllEventSubStreamers).mockResolvedValue([]);
  vi.mocked(getLiveStates).mockReturnValue([]);
  vi.mocked(restartTwitchMonitor).mockResolvedValue(undefined);
});

/** Waits for the fire-and-forget `triggerRestart()` promise chain to settle. */
async function flushRestartChain() {
  await new Promise((resolve) => setImmediate(resolve));
}

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

describe('POST /streams/streamers/add — array and missing input handling', () => {
  it('redirects with missing_fields when discord_id is an array', async () => {
    const res = await supertest(buildApp())
      .post('/streams/streamers/add')
      .send('discord_id=100000000000000001&discord_id=200000000000000002&group_id=1');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('error=missing_fields');
  });

  it('uses the first element when group_id is an array', async () => {
    vi.mocked(findUser).mockResolvedValue({ twitch_name: 'streamer', discord_id: '100000000000000001' } as any);
    const res = await supertest(buildApp())
      .post('/streams/streamers/add')
      .send('discord_id=100000000000000001&group_id=1&group_id=2');
    expect(res.status).toBe(302);
    expect(res.headers.location).not.toContain('error');
    expect(vi.mocked(addStreamer)).toHaveBeenCalledWith('100000000000000001', 1, GUILD_ID);
  });

  it('redirects with missing_fields when discord_id is absent', async () => {
    const res = await supertest(buildApp())
      .post('/streams/streamers/add')
      .send('group_id=1');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('error=missing_fields');
  });

  it('redirects with missing_fields when group_id is absent', async () => {
    const res = await supertest(buildApp())
      .post('/streams/streamers/add')
      .send('discord_id=100000000000000001');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('error=missing_fields');
  });

  it('redirects with missing_fields when discord_id is not a valid snowflake', async () => {
    const res = await supertest(buildApp())
      .post('/streams/streamers/add')
      .send('discord_id=not-a-snowflake&group_id=1');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('error=missing_fields');
  });

  it('redirects with missing_fields when discord_id is too short', async () => {
    const res = await supertest(buildApp())
      .post('/streams/streamers/add')
      .send('discord_id=1234&group_id=1');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('error=missing_fields');
  });
});

describe('POST /streams/groups/add — field length capping', () => {
  const longStr = (n: number) => 'x'.repeat(n);

  it('truncates name to 100 chars, discordChannel to 20, messages to 2000', async () => {
    const res = await supertest(buildApp())
      .post('/streams/groups/add')
      .send(
        `name=${longStr(200)}&discord_channel=${longStr(30)}&live_message=${longStr(3000)}&new_game_message=${longStr(3000)}`,
      );
    expect(res.status).toBe(302);
    expect(vi.mocked(addStreamGroup)).toHaveBeenCalledWith(
      expect.objectContaining({
        name: longStr(100),
        discordChannel: longStr(20),
        liveMessage: longStr(2000),
        newGameMessage: longStr(2000),
      }),
    );
  });

  it('preserves fields exactly at the limits without over-truncation', async () => {
    const res = await supertest(buildApp())
      .post('/streams/groups/add')
      .send(
        `name=${longStr(100)}&discord_channel=${longStr(20)}&live_message=${longStr(2000)}&new_game_message=${longStr(2000)}`,
      );
    expect(res.status).toBe(302);
    expect(vi.mocked(addStreamGroup)).toHaveBeenCalledWith(
      expect.objectContaining({
        name: longStr(100),
        discordChannel: longStr(20),
        liveMessage: longStr(2000),
        newGameMessage: longStr(2000),
      }),
    );
  });

  it('preserves fields under the limits unchanged', async () => {
    const res = await supertest(buildApp())
      .post('/streams/groups/add')
      .send(
        `name=${longStr(50)}&discord_channel=${longStr(10)}&live_message=${longStr(1000)}&new_game_message=${longStr(1000)}`,
      );
    expect(res.status).toBe(302);
    expect(vi.mocked(addStreamGroup)).toHaveBeenCalledWith(
      expect.objectContaining({
        name: longStr(50),
        discordChannel: longStr(10),
        liveMessage: longStr(1000),
        newGameMessage: longStr(1000),
      }),
    );
  });

  it('trims leading/trailing whitespace before applying the length cap', async () => {
    // Wrap each value in two spaces (%20 encoding); values are over-limit after trimming
    const padded = (n: number) => `%20%20${longStr(n)}%20%20`;
    const res = await supertest(buildApp())
      .post('/streams/groups/add')
      .send(
        `name=${padded(105)}&discord_channel=${padded(25)}&live_message=${padded(2005)}&new_game_message=${padded(2005)}`,
      );
    expect(res.status).toBe(302);
    expect(vi.mocked(addStreamGroup)).toHaveBeenCalledWith(
      expect.objectContaining({
        name: longStr(100),
        discordChannel: longStr(20),
        liveMessage: longStr(2000),
        newGameMessage: longStr(2000),
      }),
    );
  });
});

describe('POST /streams/groups/update — field length capping', () => {
  const longStr = (n: number) => 'x'.repeat(n);

  it('truncates name to 100 chars, discordChannel to 20, messages to 2000', async () => {
    const res = await supertest(buildApp())
      .post('/streams/groups/update')
      .send(
        `group_id=1&name=${longStr(200)}&discord_channel=${longStr(30)}&live_message=${longStr(3000)}&new_game_message=${longStr(3000)}`,
      );
    expect(res.status).toBe(302);
    expect(vi.mocked(updateStreamGroup)).toHaveBeenCalledWith(
      expect.objectContaining({
        name: longStr(100),
        discordChannel: longStr(20),
        liveMessage: longStr(2000),
        newGameMessage: longStr(2000),
      }),
    );
  });

  it('preserves fields exactly at the limits without over-truncation', async () => {
    const res = await supertest(buildApp())
      .post('/streams/groups/update')
      .send(
        `group_id=1&name=${longStr(100)}&discord_channel=${longStr(20)}&live_message=${longStr(2000)}&new_game_message=${longStr(2000)}`,
      );
    expect(res.status).toBe(302);
    expect(vi.mocked(updateStreamGroup)).toHaveBeenCalledWith(
      expect.objectContaining({
        name: longStr(100),
        discordChannel: longStr(20),
        liveMessage: longStr(2000),
        newGameMessage: longStr(2000),
      }),
    );
  });

  it('preserves fields under the limits unchanged', async () => {
    const res = await supertest(buildApp())
      .post('/streams/groups/update')
      .send(
        `group_id=1&name=${longStr(50)}&discord_channel=${longStr(10)}&live_message=${longStr(1000)}&new_game_message=${longStr(1000)}`,
      );
    expect(res.status).toBe(302);
    expect(vi.mocked(updateStreamGroup)).toHaveBeenCalledWith(
      expect.objectContaining({
        name: longStr(50),
        discordChannel: longStr(10),
        liveMessage: longStr(1000),
        newGameMessage: longStr(1000),
      }),
    );
  });

  it('trims leading/trailing whitespace before applying the length cap', async () => {
    const padded = (n: number) => `%20%20${longStr(n)}%20%20`;
    const res = await supertest(buildApp())
      .post('/streams/groups/update')
      .send(
        `group_id=1&name=${padded(105)}&discord_channel=${padded(25)}&live_message=${padded(2005)}&new_game_message=${padded(2005)}`,
      );
    expect(res.status).toBe(302);
    expect(vi.mocked(updateStreamGroup)).toHaveBeenCalledWith(
      expect.objectContaining({
        name: longStr(100),
        discordChannel: longStr(20),
        liveMessage: longStr(2000),
        newGameMessage: longStr(2000),
      }),
    );
  });

  it('redirects with missing_fields when a required field is blank', async () => {
    const res = await supertest(buildApp())
      .post('/streams/groups/update')
      .send('group_id=1&name=&discord_channel=chan&live_message=live&new_game_message=game');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('error=missing_fields');
    expect(updateStreamGroup).not.toHaveBeenCalled();
  });

  it('redirects with invalid_id when group_id is not a valid positive integer', async () => {
    const res = await supertest(buildApp())
      .post('/streams/groups/update')
      .send('group_id=abc&name=n&discord_channel=chan&live_message=live&new_game_message=game');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('error=invalid_id');
    expect(updateStreamGroup).not.toHaveBeenCalled();
  });

  it('redirects with update_group_failed when the DB update rejects', async () => {
    vi.mocked(updateStreamGroup).mockRejectedValueOnce(new Error('DB down'));
    const res = await supertest(buildApp())
      .post('/streams/groups/update')
      .send('group_id=1&name=n&discord_channel=chan&live_message=live&new_game_message=game');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('error=update_group_failed');
  });
});

describe('POST /streams/groups/add — failure paths', () => {
  it('redirects with missing_fields when a required field is blank', async () => {
    const res = await supertest(buildApp())
      .post('/streams/groups/add')
      .send('name=&discord_channel=chan&live_message=live&new_game_message=game');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('error=missing_fields');
    expect(addStreamGroup).not.toHaveBeenCalled();
  });

  it('redirects with add_group_failed when the DB insert rejects', async () => {
    vi.mocked(addStreamGroup).mockRejectedValueOnce(new Error('DB down'));
    const res = await supertest(buildApp())
      .post('/streams/groups/add')
      .send('name=n&discord_channel=chan&live_message=live&new_game_message=game');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('error=add_group_failed');
  });
});

describe('POST /streams/groups/remove', () => {
  it('redirects without an error when group_id is absent', async () => {
    const res = await supertest(buildApp()).post('/streams/groups/remove').send('');
    expect(res.status).toBe(302);
    expect(res.headers.location).not.toContain('error');
    expect(removeStreamGroup).not.toHaveBeenCalled();
  });

  it('redirects with invalid_id when group_id is not a valid positive integer', async () => {
    const res = await supertest(buildApp()).post('/streams/groups/remove').send('group_id=abc');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('error=invalid_id');
    expect(removeStreamGroup).not.toHaveBeenCalled();
  });

  it('removes the group\'s streamers before the group itself, then restarts the monitor', async () => {
    const res = await supertest(buildApp()).post('/streams/groups/remove').send('group_id=5');
    expect(res.status).toBe(302);
    expect(res.headers.location).not.toContain('error');
    expect(removeStreamersByGroup).toHaveBeenCalledWith(5, GUILD_ID);
    expect(removeStreamGroup).toHaveBeenCalledWith(5, GUILD_ID);
    expect(vi.mocked(removeStreamersByGroup).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(removeStreamGroup).mock.invocationCallOrder[0]);
    await flushRestartChain();
    expect(restartTwitchMonitor).toHaveBeenCalled();
  });

  it('redirects with remove_group_failed when the DB delete rejects', async () => {
    vi.mocked(removeStreamGroup).mockRejectedValueOnce(new Error('DB down'));
    const res = await supertest(buildApp()).post('/streams/groups/remove').send('group_id=5');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('error=remove_group_failed');
  });
});

describe('POST /streams/streamers/add — failure path', () => {
  it('redirects with add_streamer_failed when the DB insert rejects', async () => {
    vi.mocked(findUser).mockResolvedValue({ twitch_name: 'streamer', discord_id: '100000000000000001' } as any);
    vi.mocked(addStreamer).mockRejectedValueOnce(new Error('DB down'));
    const res = await supertest(buildApp())
      .post('/streams/streamers/add')
      .send('discord_id=100000000000000001&group_id=1');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('error=add_streamer_failed');
  });
});

describe('POST /streams/streamers/remove', () => {
  it('redirects without an error when streamer_id is absent', async () => {
    const res = await supertest(buildApp()).post('/streams/streamers/remove').send('');
    expect(res.status).toBe(302);
    expect(res.headers.location).not.toContain('error');
    expect(removeStreamer).not.toHaveBeenCalled();
  });

  it('redirects with invalid_id when streamer_id is not a valid positive integer', async () => {
    const res = await supertest(buildApp()).post('/streams/streamers/remove').send('streamer_id=abc');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('error=invalid_id');
    expect(removeStreamer).not.toHaveBeenCalled();
  });

  it('removes the streamer and restarts the monitor', async () => {
    const res = await supertest(buildApp()).post('/streams/streamers/remove').send('streamer_id=7');
    expect(res.status).toBe(302);
    expect(res.headers.location).not.toContain('error');
    expect(removeStreamer).toHaveBeenCalledWith(7, GUILD_ID);
    await flushRestartChain();
    expect(restartTwitchMonitor).toHaveBeenCalled();
  });

  it('redirects with remove_streamer_failed when the DB delete rejects', async () => {
    vi.mocked(removeStreamer).mockRejectedValueOnce(new Error('DB down'));
    const res = await supertest(buildApp()).post('/streams/streamers/remove').send('streamer_id=7');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('error=remove_streamer_failed');
  });
});

describe('triggerRestart', () => {
  it('logs an error when the monitor restart itself rejects, without affecting the response', async () => {
    vi.mocked(restartTwitchMonitor).mockRejectedValueOnce(new Error('monitor boom'));
    const res = await supertest(buildApp()).post('/streams/streamers/remove').send('streamer_id=8');
    expect(res.status).toBe(302);

    await flushRestartChain();

    expect(logMock.error).toHaveBeenCalledWith('TwitchMonitor restart error:', expect.any(Error));
  });
});

describe('GET /streams/live', () => {
  it('returns the current live states as JSON', async () => {
    vi.mocked(getLiveStates).mockReturnValue([{ login: 'streamera' } as any]);
    const res = await supertest(buildApp()).get('/streams/live');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ streams: [{ login: 'streamera' }] });
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
