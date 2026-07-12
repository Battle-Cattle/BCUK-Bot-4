import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../../test-utils/loggerMock';
import { ACCESS_LEVEL_MOCK } from '../../test-utils/accessLevelMock';

vi.mock('../../db', () => ({
  addStreamer: vi.fn(),
  removeStreamer: vi.fn(),
  findUser: vi.fn(),
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

vi.mock('../../db/users', () => ({ AccessLevel: ACCESS_LEVEL_MOCK }));

import supertest from 'supertest';
import router from './streamStreamers';
import { addStreamer, removeStreamer, findUser } from '../../db';
import { restartTwitchMonitor } from '../../twitch/monitor/twitchMonitor';
import { AccessLevel, AccessLevelValue } from '../../db/users';
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
  });
});
