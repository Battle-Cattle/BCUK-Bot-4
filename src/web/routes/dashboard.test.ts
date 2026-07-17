import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../../test-utils/loggerMock';

/** Mocks the shared logger so route handlers don't write real log output during tests. */
vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));

vi.mock('../../shared/statusStore', () => ({
  getStatus: vi.fn(),
}));

vi.mock('../../db', () => ({
  getStreamerByDiscordId: vi.fn(),
  getSfxTriggerCount: vi.fn(),
  getCustomCommandCount: vi.fn(),
  getCounterCount: vi.fn(),
  getRecentStreamerEvents: vi.fn(),
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

vi.mock('./dashboardEvents', () => ({
  RECENT_EVENTS_LIMIT: 20,
}));

import supertest from 'supertest';
import router from './dashboard';
import { getStatus } from '../../shared/statusStore';
import {
  getStreamerByDiscordId, getSfxTriggerCount, getCustomCommandCount, getCounterCount, getRecentStreamerEvents,
} from '../../db';
import { hasAuthFailedSubs } from '../../twitch/eventsub/twitchEventSubSubscriptions';
import { buildTestApp } from '../../test-utils/expressTestApp';

const STATUS = { discord: { ready: true }, voice: {}, twitch: {}, tiktok: {} };

/**
 * Builds a minimal Express app with the dashboard router mounted, a stubbed session, and res.render captured as JSON.
 * @param sessionUser - The session user to attach to each request, or undefined for an anonymous session.
 * @returns The configured Express app, ready to be driven with supertest.
 */
function buildApp(sessionUser: unknown = undefined) {
  return buildTestApp({ router, sessionUser, mockRender: 'spread' });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getStatus).mockReturnValue(STATUS as any);
  vi.mocked(getSfxTriggerCount).mockResolvedValue(3);
  vi.mocked(getCustomCommandCount).mockResolvedValue(5);
  vi.mocked(getCounterCount).mockResolvedValue(2);
  vi.mocked(getRecentStreamerEvents).mockResolvedValue([]);
});

describe('GET /', () => {
  it('renders the dashboard with needsReconnect false when no session user', async () => {
    const res = await supertest(buildApp()).get('/');
    expect(res.status).toBe(200);
    expect(res.body.view).toBe('dashboard');
    expect(res.body.status).toEqual(STATUS);
    expect(res.body.needsReconnect).toBe(false);
    expect(res.body.hasStreamer).toBe(false);
    expect(res.body.recentEvents).toEqual([]);
    expect(getStreamerByDiscordId).not.toHaveBeenCalled();
    expect(getRecentStreamerEvents).not.toHaveBeenCalled();
    expect(getStatus).toHaveBeenCalledWith(null);
  });

  it('includes usage-stat counts from the db layer', async () => {
    const res = await supertest(buildApp()).get('/');
    expect(res.body.usageStats).toEqual({ sfxCount: 3, commandCount: 5, counterCount: 2 });
  });

  it('scopes status to the session\'s current guild', async () => {
    await supertest(buildApp({ discordId: '100', currentGuildId: 'guild-A' })).get('/');
    expect(getStatus).toHaveBeenCalledWith('guild-A');
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
    expect(res.body.hasStreamer).toBe(false);
    expect(res.body.recentEvents).toEqual([]);
    expect(getRecentStreamerEvents).not.toHaveBeenCalled();
  });

  it('renders a 500 error page when getStreamerByDiscordId throws', async () => {
    vi.mocked(getStreamerByDiscordId).mockRejectedValue(new Error('DB down'));
    const res = await supertest(buildApp({ discordId: '100' })).get('/');
    expect(res.status).toBe(500);
  });

  it('loads and maps recent events when a streamer exists', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue({ id: 42, eventsub_access_token: null, twitch_name: null } as any);
    const occurredAt = new Date('2026-07-17T12:00:00Z');
    vi.mocked(getRecentStreamerEvents).mockResolvedValue([
      { eventType: 'follow', displayName: 'someviewer', detail: null, occurredAt },
    ]);

    const res = await supertest(buildApp({ discordId: '100' })).get('/');

    expect(res.body.hasStreamer).toBe(true);
    expect(getRecentStreamerEvents).toHaveBeenCalledWith(42, 20);
    expect(res.body.recentEvents).toEqual([
      { eventType: 'follow', displayName: 'someviewer', detail: null, occurredAt: occurredAt.toISOString() },
    ]);
  });
});
