import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../../test-utils/loggerMock';

vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));

vi.mock('../../db', () => ({
  getStreamerByDiscordId: vi.fn(),
  getTimerCommandsForStreamer: vi.fn(),
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

// This module composes timersMutations's router too; stub it out so this file only
// exercises the GET route defined directly in timers.ts.
vi.mock('./timersMutations', async () => {
  const { Router } = await import('express');
  return { default: Router() };
});

import supertest from 'supertest';
import router from './timers';
import { getStreamerByDiscordId, getTimerCommandsForStreamer } from '../../db';
import { buildTestApp } from '../../test-utils/expressTestApp';

type SessionUser = { discordId: string; discordName: string; discordAvatar: string | null; accessLevel: 0 | 1 | 2 | 3; isOwner: boolean };
const USER: SessionUser = { discordId: '100000000000000001', discordName: 'TestUser', discordAvatar: null, accessLevel: 0, isOwner: false };

const MOCK_STREAMER = { id: 123, discord_id: USER.discordId };

function buildApp() {
  return buildTestApp({ router, bodyParser: 'urlencoded', sessionUser: USER, mockRender: 'spread' });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getStreamerByDiscordId).mockResolvedValue(null);
  vi.mocked(getTimerCommandsForStreamer).mockResolvedValue([]);
});

describe('GET /', () => {
  it('renders with isStreamer false and no timers when the session user has no streamer record', async () => {
    const res = await supertest(buildApp()).get('/');
    expect(res.status).toBe(200);
    expect(res.body.view).toBe('timers');
    expect(res.body.isStreamer).toBe(false);
    expect(res.body.timers).toEqual([]);
    expect(getTimerCommandsForStreamer).not.toHaveBeenCalled();
  });

  it("renders the requesting streamer's own timers", async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    const timers = [{ id: 1, streamer_id: 123, name: 'Plug', message: 'hi', interval_seconds: 600, min_messages: 0, require_live: true, enabled: true }];
    vi.mocked(getTimerCommandsForStreamer).mockResolvedValue(timers as any);

    const res = await supertest(buildApp()).get('/');

    expect(res.body.isStreamer).toBe(true);
    expect(res.body.timers).toEqual(timers);
    expect(getTimerCommandsForStreamer).toHaveBeenCalledWith(123);
  });

  it('returns a 500 error page when loading timers fails', async () => {
    vi.mocked(getStreamerByDiscordId).mockRejectedValue(new Error('db down'));
    const res = await supertest(buildApp()).get('/');
    expect(res.status).toBe(500);
  });
});
