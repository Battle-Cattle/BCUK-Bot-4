import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../../test-utils/loggerMock';
import { ACCESS_LEVEL_MOCK } from '../../test-utils/accessLevelMock';

vi.mock('../../db', () => ({
  addStreamGroup: vi.fn(),
  updateStreamGroup: vi.fn(),
  removeStreamGroupAndStreamers: vi.fn(),
  AccessLevel: ACCESS_LEVEL_MOCK,
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
}));

vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));

import supertest from 'supertest';
import router from './streamGroups';
import { addStreamGroup, updateStreamGroup, removeStreamGroupAndStreamers } from '../../db';
import { restartTwitchMonitor } from '../../twitch/monitor/twitchMonitor';
import { AccessLevel } from '../../db';
import { buildTestApp } from '../../test-utils/expressTestApp';
import { makeSessionUser, type SessionUserFixture } from '../../test-utils/fixtures';

const GUILD_ID = '900000000000000001';
type SessionUser = SessionUserFixture;
const MANAGER: SessionUser = makeSessionUser({ accessLevel: AccessLevel.MANAGER, currentGuildId: GUILD_ID });

/** Builds a supertest-ready app: the stream groups router with a stubbed session and a render mock that flattens locals into the JSON body. */
function buildApp(sessionUser: SessionUser = MANAGER) {
  return buildTestApp({ router, bodyParser: 'urlencoded', sessionUser, mockRender: 'spread' });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(addStreamGroup).mockResolvedValue(undefined);
  vi.mocked(updateStreamGroup).mockResolvedValue(true);
  vi.mocked(removeStreamGroupAndStreamers).mockResolvedValue(true);
  vi.mocked(restartTwitchMonitor).mockResolvedValue(undefined);
});

/** Waits for the fire-and-forget `triggerRestart()` promise chain to settle. */
async function flushRestartChain() {
  await new Promise((resolve) => setImmediate(resolve));
}

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

  it('redirects with update_group_failed (not a false success) when the group belongs to a different guild', async () => {
    vi.mocked(updateStreamGroup).mockResolvedValueOnce(false);
    const res = await supertest(buildApp())
      .post('/streams/groups/update')
      .send('group_id=1&name=n&discord_channel=chan&live_message=live&new_game_message=game');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('error=update_group_failed');
    expect(restartTwitchMonitor).not.toHaveBeenCalled();
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
  it('redirects with missing_fields when group_id is absent', async () => {
    const res = await supertest(buildApp()).post('/streams/groups/remove').send('');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('error=missing_fields');
    expect(removeStreamGroupAndStreamers).not.toHaveBeenCalled();
  });

  it('redirects with invalid_id when group_id is not a valid positive integer', async () => {
    const res = await supertest(buildApp()).post('/streams/groups/remove').send('group_id=abc');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('error=invalid_id');
    expect(removeStreamGroupAndStreamers).not.toHaveBeenCalled();
  });

  it('removes the group and its streamers atomically, then restarts the monitor', async () => {
    const res = await supertest(buildApp()).post('/streams/groups/remove').send('group_id=5');
    expect(res.status).toBe(302);
    expect(res.headers.location).not.toContain('error');
    expect(removeStreamGroupAndStreamers).toHaveBeenCalledWith(5, GUILD_ID);
    await flushRestartChain();
    expect(restartTwitchMonitor).toHaveBeenCalled();
  });

  it('redirects with remove_group_failed when the DB delete rejects', async () => {
    vi.mocked(removeStreamGroupAndStreamers).mockRejectedValueOnce(new Error('DB down'));
    const res = await supertest(buildApp()).post('/streams/groups/remove').send('group_id=5');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('error=remove_group_failed');
  });

  it('redirects with remove_group_failed (not a false success) when the group belongs to a different guild', async () => {
    vi.mocked(removeStreamGroupAndStreamers).mockResolvedValueOnce(false);
    const res = await supertest(buildApp()).post('/streams/groups/remove').send('group_id=5');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('error=remove_group_failed');
    expect(restartTwitchMonitor).not.toHaveBeenCalled();
  });
});
