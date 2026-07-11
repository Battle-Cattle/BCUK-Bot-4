import { describe, it, expect, vi, beforeEach } from 'vitest';

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

vi.mock('../../shared/logger', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

import express from 'express';
import supertest from 'supertest';
import router from './streamStreamers';
import { addStreamer, removeStreamer, findUser } from '../../db';
import { restartTwitchMonitor } from '../../twitch/monitor/twitchMonitor';

const GUILD_ID = '900000000000000001';
type SessionUser = { discordId: string; discordName: string; discordAvatar: string | null; accessLevel: 0 | 1 | 2 | 3; currentGuildId: string };
const MANAGER: SessionUser = { discordId: '200000000000000001', discordName: 'ManagerUser', discordAvatar: null, accessLevel: 2, currentGuildId: GUILD_ID };

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

  it('redirects with remove_streamer_failed (not a false success) when the streamer belongs to a different guild', async () => {
    vi.mocked(removeStreamer).mockResolvedValueOnce(false);
    const res = await supertest(buildApp()).post('/streams/streamers/remove').send('streamer_id=7');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('error=remove_streamer_failed');
    expect(restartTwitchMonitor).not.toHaveBeenCalled();
  });
});
