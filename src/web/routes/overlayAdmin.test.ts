import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db', () => ({
  getStreamerByDiscordId: vi.fn(),
  getVideosForStreamer: vi.fn(),
  getRewardsForStreamer: vi.fn(),
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

vi.mock('../../twitch/twitchApi', () => ({
  getCustomRewards: vi.fn(),
}));

vi.mock('../../twitch/eventsub/twitchApiEventSub', () => ({
  getValidToken: vi.fn(),
}));

vi.mock('../../shared/config', () => ({
  PUBLIC_URL: 'http://localhost:3000',
}));

vi.mock('../../shared/logger', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

vi.mock('./overlayAdminMutations', async () => {
  const { Router } = await import('express');
  return { router: Router(), MAX_UPLOAD_MB: 100 };
});

import express from 'express';
import supertest from 'supertest';
import router from './overlayAdmin';
import { getStreamerByDiscordId } from '../../db';

type SessionUser = { discordId: string; discordName: string; discordAvatar: string | null; accessLevel: 0 | 1 | 2 | 3 };
const USER: SessionUser = { discordId: '100000000000000001', discordName: 'TestUser', discordAvatar: null, accessLevel: 1 };

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
  vi.mocked(getStreamerByDiscordId).mockResolvedValue(null);
});

describe('GET /settings — query param filtering', () => {
  it('passes a known error to the template', async () => {
    const res = await supertest(buildApp()).get('/settings?error=upload_failed');
    expect(res.status).toBe(200);
    expect(res.body.error).toBe('upload_failed');
  });

  it('filters an unknown error to null', async () => {
    const res = await supertest(buildApp()).get('/settings?error=arbitrary_injection');
    expect(res.status).toBe(200);
    expect(res.body.error).toBeNull();
  });

  it('passes a known success to the template', async () => {
    const res = await supertest(buildApp()).get('/settings?success=video_uploaded');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe('video_uploaded');
  });

  it('filters an unknown success to null', async () => {
    const res = await supertest(buildApp()).get('/settings?success=arbitrary_injection');
    expect(res.status).toBe(200);
    expect(res.body.success).toBeNull();
  });

  it('returns 500 when getStreamerByDiscordId throws', async () => {
    vi.mocked(getStreamerByDiscordId).mockRejectedValue(new Error('DB down'));
    const res = await supertest(buildApp()).get('/settings');
    expect(res.status).toBe(500);
  });
});
