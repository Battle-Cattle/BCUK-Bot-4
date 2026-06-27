import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../shared/logger', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

vi.mock('../../shared/statusStore', () => ({
  getStatus: vi.fn(),
}));

vi.mock('../../db', () => ({
  getStreamerByDiscordId: vi.fn(),
}));

vi.mock('../../twitch/eventsub/twitchEventSubSubscriptions', () => ({
  hasAuthFailedSubs: vi.fn(),
}));

vi.mock('../csrf', () => ({
  csrfProtection: (req: any, _res: any, next: any) => {
    req.csrfToken = () => 'test-csrf-token';
    next();
  },
}));

import express from 'express';
import supertest from 'supertest';
import router from './dashboard';
import { getStatus } from '../../shared/statusStore';
import { getStreamerByDiscordId } from '../../db';
import { hasAuthFailedSubs } from '../../twitch/eventsub/twitchEventSubSubscriptions';

const STATUS = { discord: { ready: true }, voice: {}, twitch: {}, tiktok: {} };

/**
 * Builds a minimal Express app with the dashboard router mounted, a stubbed session, and res.render captured as JSON.
 * @param sessionUser - The session user to attach to each request, or undefined for an anonymous session.
 * @returns The configured Express app, ready to be driven with supertest.
 */
function buildApp(sessionUser: any = undefined) {
  const app = express();
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
  vi.mocked(getStatus).mockReturnValue(STATUS as any);
});

describe('GET /', () => {
  it('renders the dashboard with needsReconnect false when no session user', async () => {
    const res = await supertest(buildApp()).get('/');
    expect(res.status).toBe(200);
    expect(res.body.view).toBe('dashboard');
    expect(res.body.status).toEqual(STATUS);
    expect(res.body.needsReconnect).toBe(false);
    expect(getStreamerByDiscordId).not.toHaveBeenCalled();
  });

  it('sets needsReconnect true when the streamer has auth-failed subs', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue({
      eventsub_access_token: 'token',
      twitch_name: 'streamer',
    } as any);
    vi.mocked(hasAuthFailedSubs).mockReturnValue(true);

    const res = await supertest(buildApp({ discordId: '100' })).get('/');
    expect(res.status).toBe(200);
    expect(res.body.needsReconnect).toBe(true);
    expect(hasAuthFailedSubs).toHaveBeenCalledWith('streamer');
  });

  it('sets needsReconnect false when the streamer has no access token', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue({
      eventsub_access_token: null,
      twitch_name: 'streamer',
    } as any);
    vi.mocked(hasAuthFailedSubs).mockReturnValue(true);

    const res = await supertest(buildApp({ discordId: '100' })).get('/');
    expect(res.body.needsReconnect).toBe(false);
  });

  it('sets needsReconnect false when the streamer has no twitch_name', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue({
      eventsub_access_token: 'token',
      twitch_name: null,
    } as any);
    vi.mocked(hasAuthFailedSubs).mockReturnValue(true);

    const res = await supertest(buildApp({ discordId: '100' })).get('/');
    expect(res.body.needsReconnect).toBe(false);
  });

  it('sets needsReconnect false when there is no streamer record', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(null);

    const res = await supertest(buildApp({ discordId: '100' })).get('/');
    expect(res.body.needsReconnect).toBe(false);
  });

  it('renders a 500 error page when getStreamerByDiscordId throws', async () => {
    vi.mocked(getStreamerByDiscordId).mockRejectedValue(new Error('DB down'));
    const res = await supertest(buildApp({ discordId: '100' })).get('/');
    expect(res.status).toBe(500);
  });
});
