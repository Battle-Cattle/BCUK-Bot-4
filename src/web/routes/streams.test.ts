import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db', () => ({
  getAllStreamGroups: vi.fn(),
  addStreamGroup: vi.fn(),
  updateStreamGroup: vi.fn(),
  removeStreamGroup: vi.fn(),
  getAllStreamers: vi.fn(),
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

vi.mock('../../twitchMonitor', () => ({
  restartTwitchMonitor: vi.fn(),
  getLiveStates: vi.fn().mockReturnValue([]),
}));

vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

import express from 'express';
import supertest from 'supertest';
import router from './streams';
import { getAllStreamGroups, getAllStreamers, getAllUsers } from '../../db';

type SessionUser = { discordId: string; discordName: string; discordAvatar: string | null; accessLevel: 0 | 1 | 2 | 3 };
const MANAGER: SessionUser = { discordId: '200000000000000001', discordName: 'ManagerUser', discordAvatar: null, accessLevel: 2 };

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
  vi.mocked(getAllStreamGroups).mockResolvedValue([]);
  vi.mocked(getAllStreamers).mockResolvedValue([]);
  vi.mocked(getAllUsers).mockResolvedValue([]);
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

  it('returns 500 when getAllStreamGroups throws', async () => {
    vi.mocked(getAllStreamGroups).mockRejectedValue(new Error('DB down'));
    const res = await supertest(buildApp()).get('/streams');
    expect(res.status).toBe(500);
  });
});
