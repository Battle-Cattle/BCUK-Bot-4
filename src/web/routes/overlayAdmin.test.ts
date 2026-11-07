import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ACCESS_LEVEL_MOCK } from '../../test-utils/accessLevelMock';

vi.mock('../../db', () => ({
  getStreamerByDiscordId: vi.fn(),
  getVideosForStreamer: vi.fn(),
  getRewardsForStreamer: vi.fn(),
  getLibraryVideos: vi.fn(),
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

vi.mock('../../twitch/twitchRewardsApi', () => ({
  getCustomRewards: vi.fn(),
}));

vi.mock('../../twitch/twitchUserTokens', () => ({
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

vi.mock('./overlayAdminLibraryMutations', async () => {
  const { Router } = await import('express');
  return { router: Router() };
});

import supertest from 'supertest';
import router, { statusConnections } from './overlayAdmin';
import { getStreamerByDiscordId, getVideosForStreamer, getRewardsForStreamer, getLibraryVideos } from '../../db';
import { getValidToken } from '../../twitch/twitchUserTokens';
import { getCustomRewards } from '../../twitch/twitchRewardsApi';
import { AccessLevel } from '../../db';
import { buildTestApp } from '../../test-utils/expressTestApp';
import { makeSessionUser, type SessionUserFixture } from '../../test-utils/fixtures';
import { attachSseConnection } from './sseChannel';
import { connections as overlaySourceConnections } from './overlaySource';
import { claimConversionProgress, setConversionProgress, releaseConversionProgress } from './overlayConversionProgress';

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

/**
 * Opens a fake overlay browser-source SSE connection under `login` through the real
 * `attachSseConnection`, so it fires the same connection-change notifications a real one does.
 */
function openOverlayConnection(connections: Map<string, Set<any>>, login: string) {
  const closeCbs: (() => void)[] = [];
  const on = (event: string, cb: () => void) => { if (event === 'close') closeCbs.push(cb); };
  attachSseConnection({ on, destroyed: false } as any, { ...makeSseRes(), on, closed: false } as any, {
    connections, key: login, maxPerChannel: 10,
  });
  return { close: () => { for (const cb of closeCbs) cb(); } };
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

  it.each(['transcode_failed', 'transcode_busy'])('passes the MOV conversion error %s to the template', async (code) => {
    const res = await supertest(buildApp()).get(`/settings?error=${code}`);
    expect(res.status).toBe(200);
    expect(res.body.error).toBe(code);
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

  it('passes the overlay video weight limit to the template as maxVideoWeight', async () => {
    const res = await supertest(buildApp()).get('/settings');
    expect(res.body.maxVideoWeight).toBe(100);
  });
});

describe('GET /settings — public video library', () => {
  const ENTRY = {
    id: 4, name: 'Confetti', filename: 'lib.webm', contributor_streamer_id: 9,
    contributor_login: 'alice', source_video_id: 12, created_at: new Date('2026-11-01T00:00:00Z'),
  };

  beforeEach(() => {
    vi.mocked(getVideosForStreamer).mockResolvedValue([]);
    vi.mocked(getRewardsForStreamer).mockResolvedValue([]);
    vi.mocked(getLibraryVideos).mockResolvedValue([ENTRY]);
  });

  it('marks which of the streamer\'s own videos are already a library entry\'s source', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue({ id: 1, discord_id: '1', twitch_user_id: null } as any);
    vi.mocked(getVideosForStreamer).mockResolvedValue([
      { id: 12, streamer_id: 1, name: 'A', filename: 'a.webm', created_at: new Date() },
      { id: 13, streamer_id: 1, name: 'B', filename: 'b.webm', created_at: new Date() },
    ]);
    vi.mocked(getLibraryVideos).mockResolvedValue([ENTRY, { ...ENTRY, id: 5, source_video_id: null }, { ...ENTRY, id: 6, source_video_id: 77 }]);
    const res = await supertest(buildApp()).get('/settings');
    expect(res.body.publishedVideoIds).toEqual([12]);
  });

  it('passes no published videos to a non-streamer', async () => {
    const res = await supertest(buildApp()).get('/settings');
    expect(res.body.publishedVideoIds).toEqual([]);
  });

  it('passes every library entry to a streamer', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue({ id: 1, discord_id: '1', twitch_user_id: null } as any);
    const res = await supertest(buildApp()).get('/settings');
    expect(res.status).toBe(200);
    expect(res.body.libraryVideos).toEqual([{ ...ENTRY, created_at: ENTRY.created_at.toISOString() }]);
  });

  it('passes an empty library to a non-streamer without loading it', async () => {
    const res = await supertest(buildApp()).get('/settings');
    expect(res.body.libraryVideos).toEqual([]);
    expect(getLibraryVideos).not.toHaveBeenCalled();
  });
});

describe('GET /settings — library codes and Admin controls', () => {
  it.each(['not_your_video', 'already_in_library', 'publish_failed'])('passes the publish error %s to the template', async (code) => {
    expect((await supertest(buildApp()).get(`/settings?error=${code}`)).body.error).toBe(code);
  });

  it('passes the video_published success code to the template', async () => {
    expect((await supertest(buildApp()).get('/settings?success=video_published')).body.success).toBe('video_published');
  });

  it('passes the library removal success and not_found error codes to the template', async () => {
    expect((await supertest(buildApp()).get('/settings?success=library_video_removed')).body.success).toBe('library_video_removed');
    expect((await supertest(buildApp()).get('/settings?error=not_found')).body.error).toBe('not_found');
  });

  it.each([
    [AccessLevel.ADMIN, true],
    [AccessLevel.MANAGER, false],
    [AccessLevel.USER, false],
  ])('passes isAdmin for a session access level of %s as %s', async (accessLevel, expected) => {
    const res = await supertest(buildApp(makeSessionUser({ accessLevel }))).get('/settings');
    expect(res.body.isAdmin).toBe(expected);
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

    triggerClose(); // unsubscribes from overlay connection changes so it doesn't leak into other tests
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

  it('pushes an update as soon as an overlay connection opens or closes, and only on a change', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(makeStreamer() as any);
    const handler = getRouteHandler('/settings/events');
    const res = makeSseRes();
    const { req, triggerClose } = makeSseReq('discord1');

    await handler(req, res, vi.fn());
    expect(res.write).toHaveBeenCalledTimes(2); // handshake + initial disconnected state
    res.write.mockClear();

    const first = openOverlayConnection(overlaySourceConnections, 'somestreamer');
    expect(res.write).toHaveBeenCalledWith(`data: ${JSON.stringify({ connected: true })}\n\n`);
    res.write.mockClear();

    const second = openOverlayConnection(overlaySourceConnections, 'somestreamer'); // still connected — no repeat push
    openOverlayConnection(overlaySourceConnections, 'otherstreamer').close(); // another channel — ignored
    first.close();
    expect(res.write).not.toHaveBeenCalled();

    second.close();
    expect(res.write).toHaveBeenCalledWith(`data: ${JSON.stringify({ connected: false })}\n\n`);

    triggerClose();
  });

  it('stops pushing once the request closes', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(makeStreamer() as any);
    const handler = getRouteHandler('/settings/events');
    const res = makeSseRes();
    const { req, triggerClose } = makeSseReq('discord1');

    await handler(req, res, vi.fn());
    triggerClose();
    res.write.mockClear();

    openOverlayConnection(overlaySourceConnections, 'somestreamer').close();

    expect(res.write).not.toHaveBeenCalled();
  });
});

describe('GET /settings/videos/progress/:uploadId', () => {
  const UPLOAD_ID = 'c'.repeat(32);
  const STREAMER = { id: 77, twitch_name: 'streamer' };

  it('reports the requesting streamer\'s conversion progress without caching', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(STREAMER as any);
    const owner = claimConversionProgress(STREAMER.id, UPLOAD_ID)!;
    setConversionProgress(STREAMER.id, UPLOAD_ID, owner, { stage: 'converting', percent: 63 });
    try {
      const res = await supertest(buildApp()).get(`/settings/videos/progress/${UPLOAD_ID}`);
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toEqual({ stage: 'converting', percent: 63 });
    } finally {
      releaseConversionProgress(STREAMER.id, UPLOAD_ID, owner);
    }
  });

  it('reports none when the streamer has no conversion under that ID', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(STREAMER as any);
    const res = await supertest(buildApp()).get(`/settings/videos/progress/${UPLOAD_ID}`);
    expect(res.body).toEqual({ stage: 'none', percent: null });
  });

  it('never reports another streamer\'s conversion', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue({ id: 78 } as any);
    const owner = claimConversionProgress(STREAMER.id, UPLOAD_ID)!;
    setConversionProgress(STREAMER.id, UPLOAD_ID, owner, { stage: 'converting', percent: 63 });
    try {
      const res = await supertest(buildApp()).get(`/settings/videos/progress/${UPLOAD_ID}`);
      expect(res.body).toEqual({ stage: 'none', percent: null });
    } finally {
      releaseConversionProgress(STREAMER.id, UPLOAD_ID, owner);
    }
  });

  it('reports none for a non-streamer', async () => {
    const res = await supertest(buildApp()).get(`/settings/videos/progress/${UPLOAD_ID}`);
    expect(res.body).toEqual({ stage: 'none', percent: null });
  });

  it('reports none for a malformed ID without looking up the streamer', async () => {
    const res = await supertest(buildApp()).get('/settings/videos/progress/not-an-id');
    expect(res.body).toEqual({ stage: 'none', percent: null });
    expect(vi.mocked(getStreamerByDiscordId)).not.toHaveBeenCalled();
  });

  it('answers 500 with none when the streamer lookup fails', async () => {
    vi.mocked(getStreamerByDiscordId).mockRejectedValue(new Error('db down'));
    const res = await supertest(buildApp()).get(`/settings/videos/progress/${UPLOAD_ID}`);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ stage: 'none', percent: null });
  });
});
