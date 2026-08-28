import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ACCESS_LEVEL_MOCK } from '../../test-utils/accessLevelMock';

vi.mock('../../db', () => ({
  getStreamerByDiscordId: vi.fn(),
  getVideosForStreamer: vi.fn(),
  getRewardsForStreamer: vi.fn(),
  AccessLevel: ACCESS_LEVEL_MOCK,
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
  OVERLAY_STATUS_MAX_SSE_PER_STREAMER: 3,
  OVERLAY_MAX_SSE_PER_CHANNEL: 10,
  OVERLAY_FOLDER: './overlay-videos',
  SSE_MAX_TOTAL_CONNECTIONS: 1000,
}));

const { logMock } = vi.hoisted(() => ({
  logMock: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../shared/logger', () => ({
  createLogger: () => logMock,
}));

vi.mock('./overlayAdminMutations', async () => {
  const { Router } = await import('express');
  return { router: Router(), MAX_UPLOAD_MB: 100 };
});

import supertest from 'supertest';
import router, { statusConnections } from './overlayAdmin';
import { getStreamerByDiscordId, getVideosForStreamer, getRewardsForStreamer } from '../../db';
import { getValidToken } from '../../twitch/eventsub/twitchApiEventSub';
import { getCustomRewards } from '../../twitch/twitchApi';
import { AccessLevel } from '../../db';
import { buildTestApp } from '../../test-utils/expressTestApp';
import { makeSessionUser, type SessionUserFixture } from '../../test-utils/fixtures';
import { connections as overlaySourceConnections } from './overlaySource';

type SessionUser = SessionUserFixture;
const USER: SessionUser = makeSessionUser({ accessLevel: AccessLevel.MOD });

/** Finds a route's handler function directly from the router's internal stack, bypassing HTTP entirely — needed to control the request's 'close' event deterministically and to await the async handler before assertions. */
function getRouteHandler(routePath: string): (req: any, res: any, next: any) => Promise<void> | void {
  const layer = (router as any).stack.find((l: any) => l.route?.path === routePath);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

/** Builds a fake Express `res` covering the SSE-specific methods used by the events route handler. */
function makeSseRes() {
  return {
    setHeader: vi.fn(),
    flushHeaders: vi.fn(),
    write: vi.fn(),
    status: vi.fn().mockReturnThis(),
    end: vi.fn(),
    on: vi.fn(),
  };
}

/** Builds a fake Express `req` with a session for `discordId`, and a `close`-event hook. */
function makeSseReq(discordId: string) {
  let closeCb: (() => void) | undefined;
  return {
    req: {
      session: { user: { discordId } },
      on: (event: string, cb: () => void) => {
        if (event === 'close') closeCb = cb;
      },
    },
    triggerClose: () => closeCb?.(),
  };
}

/** Builds a supertest-ready app: the overlay admin router with a stubbed session and a render mock that flattens locals into the JSON body. */
function buildApp(sessionUser: SessionUser = USER) {
  return buildTestApp({ router, bodyParser: 'urlencoded', sessionUser, mockRender: 'spread' });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getStreamerByDiscordId).mockResolvedValue(null);
  statusConnections.clear();
  overlaySourceConnections.clear();
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

  it('passes MAX_UPLOAD_MB to the template as maxFileMb', async () => {
    const res = await supertest(buildApp()).get('/settings');
    expect(res.status).toBe(200);
    expect(res.body.maxFileMb).toBe(100);
  });
});

describe('GET /controller/settings', () => {
  it('renders the controller admin view with the base URL', async () => {
    const res = await supertest(buildApp()).get('/controller/settings');
    expect(res.status).toBe(200);
    expect(res.body.baseUrl).toBe('http://localhost:3000');
  });
});

// fetchTwitchRewards isn't exported, so it's exercised indirectly through GET /settings —
// twitchRewards in the rendered locals is its return value.
describe('GET /settings — fetchTwitchRewards', () => {
  function makeStreamer(overrides: Record<string, unknown> = {}) {
    return { id: 1, discord_id: '100000000000000001', twitch_user_id: 'tuid-1', ...overrides };
  }

  beforeEach(() => {
    vi.mocked(getVideosForStreamer).mockResolvedValue([]);
    vi.mocked(getRewardsForStreamer).mockResolvedValue([]);
  });

  it('returns no rewards and skips token lookup when the streamer has no twitch_user_id', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(makeStreamer({ twitch_user_id: null }) as any);

    const res = await supertest(buildApp()).get('/settings');

    expect(res.status).toBe(200);
    expect(res.body.twitchRewards).toEqual([]);
    expect(getValidToken).not.toHaveBeenCalled();
    expect(getCustomRewards).not.toHaveBeenCalled();
  });

  it('returns no rewards when getValidToken has no valid token', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(makeStreamer() as any);
    vi.mocked(getValidToken).mockResolvedValue(null);

    const res = await supertest(buildApp()).get('/settings');

    expect(res.status).toBe(200);
    expect(res.body.twitchRewards).toEqual([]);
    expect(getCustomRewards).not.toHaveBeenCalled();
  });

  it('returns the streamer\'s Twitch custom rewards when a valid token is available', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(makeStreamer() as any);
    vi.mocked(getValidToken).mockResolvedValue('valid-token');
    vi.mocked(getCustomRewards).mockResolvedValue([{ id: 'reward-1', title: 'Reward One' }] as any);

    const res = await supertest(buildApp()).get('/settings');

    expect(res.status).toBe(200);
    expect(getCustomRewards).toHaveBeenCalledWith('tuid-1', 'valid-token');
    expect(res.body.twitchRewards).toEqual([{ id: 'reward-1', title: 'Reward One' }]);
  });

  it('logs a warning and returns no rewards when getCustomRewards throws', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(makeStreamer() as any);
    vi.mocked(getValidToken).mockResolvedValue('valid-token');
    vi.mocked(getCustomRewards).mockRejectedValue(new Error('Twitch API down'));

    const res = await supertest(buildApp()).get('/settings');

    expect(res.status).toBe(200);
    expect(res.body.twitchRewards).toEqual([]);
    expect(logMock.warn).toHaveBeenCalledWith('Failed to fetch Twitch custom rewards:', expect.any(Error));
  });
});

describe('GET /settings/events', () => {
  function makeStreamer(overrides: Record<string, unknown> = {}) {
    return { id: 7, discord_id: 'discord1', twitch_name: 'somestreamer', ...overrides };
  }

  it('returns 403 when the user is not a monitored streamer', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(null);
    const res = await supertest(buildApp()).get('/settings/events');
    expect(res.status).toBe(403);
  });

  it('returns 403 when the streamer has no linked Twitch channel', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(makeStreamer({ twitch_name: null }) as any);
    const res = await supertest(buildApp()).get('/settings/events');
    expect(res.status).toBe(403);
  });

  it('returns 500 when the streamer lookup throws', async () => {
    vi.mocked(getStreamerByDiscordId).mockRejectedValue(new Error('DB down'));
    const res = await supertest(buildApp()).get('/settings/events');
    expect(res.status).toBe(500);
  });

  it('attaches the connection and reports disconnected when the overlay has no open connections', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(makeStreamer() as any);
    const handler = getRouteHandler('/settings/events');
    const res = makeSseRes();
    const { req, triggerClose } = makeSseReq('discord1');

    await handler(req, res, vi.fn());

    expect(statusConnections.get(7)?.has(res as any)).toBe(true);
    expect(res.write).toHaveBeenCalledWith(`data: ${JSON.stringify({ connected: false })}\n\n`);

    triggerClose(); // clears the status-poll interval so it doesn't leak into other tests
  });

  it('reports connected when the overlay already has an open connection', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(makeStreamer() as any);
    overlaySourceConnections.set('somestreamer', new Set([{} as any]));
    const handler = getRouteHandler('/settings/events');
    const res = makeSseRes();
    const { req, triggerClose } = makeSseReq('discord1');

    await handler(req, res, vi.fn());

    expect(res.write).toHaveBeenCalledWith(`data: ${JSON.stringify({ connected: true })}\n\n`);

    triggerClose();
  });

  it('pushes an update only when the overlay connection state actually changes on a poll tick', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(getStreamerByDiscordId).mockResolvedValue(makeStreamer() as any);
      const handler = getRouteHandler('/settings/events');
      const res = makeSseRes();
      const { req, triggerClose } = makeSseReq('discord1');

      await handler(req, res, vi.fn());
      expect(res.write).toHaveBeenCalledTimes(2); // handshake + initial disconnected state
      res.write.mockClear();

      vi.advanceTimersByTime(3000); // no change yet — still disconnected
      expect(res.write).not.toHaveBeenCalled();

      overlaySourceConnections.set('somestreamer', new Set([{} as any]));
      vi.advanceTimersByTime(3000);
      expect(res.write).toHaveBeenCalledWith(`data: ${JSON.stringify({ connected: true })}\n\n`);
      res.write.mockClear();

      vi.advanceTimersByTime(3000); // still connected — no repeat push
      expect(res.write).not.toHaveBeenCalled();

      triggerClose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops polling once the request closes', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(getStreamerByDiscordId).mockResolvedValue(makeStreamer() as any);
      const handler = getRouteHandler('/settings/events');
      const res = makeSseRes();
      const { req, triggerClose } = makeSseReq('discord1');

      await handler(req, res, vi.fn());
      triggerClose();
      res.write.mockClear();

      overlaySourceConnections.set('somestreamer', new Set([{} as any]));
      vi.advanceTimersByTime(10_000);

      expect(res.write).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
