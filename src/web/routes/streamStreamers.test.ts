import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../../test-utils/loggerMock';
import { ACCESS_LEVEL_MOCK } from '../../test-utils/accessLevelMock';

vi.mock('../../db', () => ({
  addStreamer: vi.fn(),
  removeStreamer: vi.fn(),
  moveStreamerToGroup: vi.fn(),
  findUser: vi.fn(),
  getMemberAccessLevel: vi.fn(),
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
vi.mock('../../twitch/eventsub/twitchEventSub', () => ({ reloadEventSubSubscriptions: vi.fn() }));

vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));

import supertest from 'supertest';
import router from './streamStreamers';
import { addStreamer, removeStreamer, moveStreamerToGroup, findUser, getMemberAccessLevel } from '../../db';
import { reloadEventSubSubscriptions } from '../../twitch/eventsub/twitchEventSub';
import { restartTwitchMonitor } from '../../twitch/monitor/twitchMonitor';
import { AccessLevel, AccessLevelValue } from '../../db';
import { buildTestApp } from '../../test-utils/expressTestApp';

const GUILD_ID = '900000000000000001';
type SessionUser = { discordId: string; discordName: string; discordAvatar: string | null; accessLevel: AccessLevelValue; currentGuildId: string };
const MANAGER: SessionUser = { discordId: '200000000000000001', discordName: 'ManagerUser', discordAvatar: null, accessLevel: AccessLevel.MANAGER, currentGuildId: GUILD_ID };

/** Builds a supertest-ready app: the stream streamers router with a stubbed session and a render mock that flattens locals into the JSON body. */
function buildApp(sessionUser: SessionUser = MANAGER) {
  return buildTestApp({ router, bodyParser: 'urlencoded', sessionUser, mockRender: 'spread' });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(findUser).mockResolvedValue(null);
  vi.mocked(getMemberAccessLevel).mockResolvedValue(AccessLevel.USER);
  vi.mocked(addStreamer).mockResolvedValue(undefined);
  vi.mocked(removeStreamer).mockResolvedValue(true);
  vi.mocked(restartTwitchMonitor).mockResolvedValue(undefined);
});

/** Waits for the fire-and-forget `triggerRestart()` promise chain to settle. */
async function flushRestartChain() {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('POST /streams/streamers/add — array and missing input handling', () => {
  it('redirects with missing_fields when discord_id is an array', async () => {
    const res = await supertest(buildApp())
      .post('/streams/streamers/add')
      .send('discord_id=100000000000000001&discord_id=200000000000000002&group_id=1');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('error=missing_fields');
  });

  it('redirects with invalid_id and does not add when group_id is repeated', async () => {
    vi.mocked(findUser).mockResolvedValue({ twitch_name: 'streamer', discord_id: '100000000000000001' } as any);
    const res = await supertest(buildApp())
      .post('/streams/streamers/add')
      .send('discord_id=100000000000000001&group_id=1&group_id=2');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('error=invalid_id');
    expect(addStreamer).not.toHaveBeenCalled();
  });

  it('redirects with invalid_id when group_id is not a positive integer', async () => {
    const res = await supertest(buildApp())
      .post('/streams/streamers/add')
      .send('discord_id=100000000000000001&group_id=abc');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('error=invalid_id');
    expect(findUser).not.toHaveBeenCalled();
  });

  it('redirects with missing_fields and does not add when the user has no Twitch name', async () => {
    vi.mocked(findUser).mockResolvedValue({ twitch_name: null, discord_id: '100000000000000001' } as any);
    const res = await supertest(buildApp())
      .post('/streams/streamers/add')
      .send('discord_id=100000000000000001&group_id=1');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('error=missing_fields');
    expect(getMemberAccessLevel).not.toHaveBeenCalled();
    expect(addStreamer).not.toHaveBeenCalled();
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

describe('POST /streams/streamers/add — guild membership', () => {
  it('redirects with streamer_not_member and does not add when the user is not a member of the current guild', async () => {
    vi.mocked(findUser).mockResolvedValue({ twitch_name: 'streamer', discord_id: '100000000000000001' } as any);
    vi.mocked(getMemberAccessLevel).mockResolvedValueOnce(null);
    const res = await supertest(buildApp())
      .post('/streams/streamers/add')
      .send('discord_id=100000000000000001&group_id=1');
    expect(res.headers.location).toContain('error=streamer_not_member');
    expect(getMemberAccessLevel).toHaveBeenCalledWith(GUILD_ID, '100000000000000001');
    expect(addStreamer).not.toHaveBeenCalled();
    await flushRestartChain();
    expect(restartTwitchMonitor).not.toHaveBeenCalled();
  });

  it('adds the streamer when the user is a member of the current guild', async () => {
    vi.mocked(findUser).mockResolvedValue({ twitch_name: 'streamer', discord_id: '100000000000000001' } as any);
    const res = await supertest(buildApp())
      .post('/streams/streamers/add')
      .send('discord_id=100000000000000001&group_id=1');
    expect(res.headers.location).toBe('/admin/streams');
    expect(addStreamer).toHaveBeenCalledWith('100000000000000001', 1, GUILD_ID);
  });
});

describe('POST /streams/streamers/remove', () => {
  it('redirects with missing_fields when streamer_id is absent', async () => {
    const res = await supertest(buildApp()).post('/streams/streamers/remove').send('');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('error=missing_fields');
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
    // The removed streamer's EventSub connection is stopped too (#1008).
    expect(reloadEventSubSubscriptions).toHaveBeenCalledOnce();
  });

  it('redirects with remove_streamer_failed when the DB delete rejects', async () => {
    vi.mocked(removeStreamer).mockRejectedValueOnce(new Error('DB down'));
    const res = await supertest(buildApp()).post('/streams/streamers/remove').send('streamer_id=7');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('error=remove_streamer_failed');
  });

  it('redirects with remove_streamer_failed (not a false success) when the streamer belongs to a different guild', async () => {
    vi.mocked(removeStreamer).mockResolvedValueOnce(false);
    const res = await supertest(buildApp()).post('/streams/streamers/remove').send('streamer_id=7');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('error=remove_streamer_failed');
    expect(restartTwitchMonitor).not.toHaveBeenCalled();
    expect(reloadEventSubSubscriptions).not.toHaveBeenCalled();
  });
});

describe('POST /streams/streamers/move (#1008)', () => {
  beforeEach(() => {
    vi.mocked(moveStreamerToGroup).mockResolvedValue(true);
  });

  it('moves the streamer to the group within the current guild and restarts the monitor, without an EventSub reload', async () => {
    const res = await supertest(buildApp()).post('/streams/streamers/move').send('streamer_id=7&group_id=3');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/admin/streams');
    expect(moveStreamerToGroup).toHaveBeenCalledWith(7, 3, GUILD_ID);
    expect(removeStreamer).not.toHaveBeenCalled();
    await flushRestartChain();
    expect(restartTwitchMonitor).toHaveBeenCalled();
    expect(reloadEventSubSubscriptions).not.toHaveBeenCalled();
  });

  it.each([
    ['streamer_id=7', 'missing_fields'],
    ['group_id=3', 'missing_fields'],
    ['streamer_id=abc&group_id=3', 'invalid_id'],
    ['streamer_id=7&group_id=-1', 'invalid_id'],
  ])('redirects with an error and moves nothing for %s', async (body, error) => {
    const res = await supertest(buildApp()).post('/streams/streamers/move').send(body);
    expect(res.headers.location).toContain(`error=${error}`);
    expect(moveStreamerToGroup).not.toHaveBeenCalled();
  });

  it('redirects with move_streamer_failed when the streamer or the group is outside this guild', async () => {
    vi.mocked(moveStreamerToGroup).mockResolvedValueOnce(false);
    const res = await supertest(buildApp()).post('/streams/streamers/move').send('streamer_id=7&group_id=3');
    expect(res.headers.location).toContain('error=move_streamer_failed');
    expect(restartTwitchMonitor).not.toHaveBeenCalled();
  });

  it('redirects with move_streamer_failed when the DB update rejects', async () => {
    vi.mocked(moveStreamerToGroup).mockRejectedValueOnce(new Error('DB down'));
    const res = await supertest(buildApp()).post('/streams/streamers/move').send('streamer_id=7&group_id=3');
    expect(res.headers.location).toContain('error=move_streamer_failed');
  });
});
