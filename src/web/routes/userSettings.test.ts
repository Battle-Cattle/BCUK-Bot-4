import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db', () => ({
  findUser: vi.fn(),
  getStreamerByDiscordId: vi.fn(),
  saveEventConfig: vi.fn(),
  clearStreamerToken: vi.fn(),
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

vi.mock('../../twitchEventSub', () => ({
  reloadEventSubSubscriptions: vi.fn(),
}));

vi.mock('../../twitchEventSubSubscriptions', () => ({
  hasAuthFailedSubs: vi.fn().mockReturnValue(false),
}));

vi.mock('../../config', () => ({
  TWITCH_CLIENT_ID: 'test-client-id',
  TWITCH_EVENTSUB_REDIRECT_URI: 'http://localhost/callback',
  EVENTSUB_TOKEN_SECRET: 'test-secret',
}));

vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

import express from 'express';
import supertest from 'supertest';
import router from './userSettings';
import { findUser, getStreamerByDiscordId } from '../../db';

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
