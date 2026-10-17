import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ACCESS_LEVEL_MOCK } from '../../test-utils/accessLevelMock';

vi.mock('../../db', () => ({
  ALERT_EVENT_TYPES: ['follow', 'sub', 'resub', 'giftsub', 'raid'],
  ALERT_TEXT_ANIMATIONS: ['none', 'wave', 'pulse', 'glitch', 'shake', 'rainbow', 'flicker', 'tilt', 'bounce-in', 'typewriter'],
  getStreamerByDiscordId: vi.fn(),
  getAlertConfigsForStreamer: vi.fn(),
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

vi.mock('../../shared/config', () => ({
  PUBLIC_URL: 'http://localhost:3000',
  ALERT_STATUS_MAX_SSE_PER_STREAMER: 3,
  ALERT_MAX_SSE_PER_CHANNEL: 10,
  ALERT_ASSETS_FOLDER: './alert-assets',
  SSE_MAX_TOTAL_CONNECTIONS: 1000,
}));

const { logMock } = vi.hoisted(() => ({
  logMock: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../shared/logger', () => ({
  createLogger: () => logMock,
}));

vi.mock('./alertsAdminMutations', async () => {
  const { Router } = await import('express');
  return { router: Router() };
});

vi.mock('./alertsAssetMutations', async () => {
  const { Router } = await import('express');
  return { router: Router(), MAX_IMAGE_MB: 10, MAX_SOUND_MB: 5 };
});

import supertest from 'supertest';
import router, { statusConnections } from './alertsAdmin';
import { getStreamerByDiscordId, getAlertConfigsForStreamer } from '../../db';
import { AccessLevel } from '../../db';
import { buildTestApp } from '../../test-utils/expressTestApp';
import { makeSessionUser, type SessionUserFixture } from '../../test-utils/fixtures';
import { attachSseConnection } from './sseChannel';
import { connections as alertsSourceConnections } from './alertsOverlaySource';

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

/** Builds a supertest-ready app: the alerts admin router with a stubbed session and a render mock that flattens locals into the JSON body. */
function buildApp(sessionUser: SessionUser = USER) {
  return buildTestApp({ router, bodyParser: 'urlencoded', sessionUser, mockRender: 'spread' });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getStreamerByDiscordId).mockResolvedValue(null);
  vi.mocked(getAlertConfigsForStreamer).mockResolvedValue([]);
  statusConnections.clear();
  alertsSourceConnections.clear();
});

describe('GET /settings — query param filtering', () => {
  it('passes a known error to the template', async () => {
    const res = await supertest(buildApp()).get('/settings?error=invalid_message');
    expect(res.status).toBe(200);
    expect(res.body.error).toBe('invalid_message');
  });

  it('filters an unknown error to null', async () => {
    const res = await supertest(buildApp()).get('/settings?error=arbitrary_injection');
    expect(res.status).toBe(200);
    expect(res.body.error).toBeNull();
  });

  it('passes a known success to the template', async () => {
    const res = await supertest(buildApp()).get('/settings?success=config_saved');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe('config_saved');
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

  it('passes MAX_IMAGE_MB/MAX_SOUND_MB to the template', async () => {
    const res = await supertest(buildApp()).get('/settings');
    expect(res.status).toBe(200);
    expect(res.body.maxImageMb).toBe(10);
    expect(res.body.maxSoundMb).toBe(5);
  });
});

describe('GET /settings — streamer and alert config loading', () => {
  it('renders with an empty configByType and null streamer when the user is not a streamer', async () => {
    const res = await supertest(buildApp()).get('/settings');
    expect(res.status).toBe(200);
    expect(res.body.streamer).toBeNull();
    expect(getAlertConfigsForStreamer).not.toHaveBeenCalled();
  });

  it('loads alert configs for the streamer, keyed by event type', async () => {
    const streamer = { id: 42, twitch_name: 'somestreamer' };
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(streamer as any);
    vi.mocked(getAlertConfigsForStreamer).mockResolvedValue([
      { event_type: 'follow', enabled: true, message_template: 'hi', image_filename: null, sound_filename: null, duration_ms: 6000 },
    ] as any);

    const res = await supertest(buildApp()).get('/settings');

    expect(res.status).toBe(200);
    expect(getAlertConfigsForStreamer).toHaveBeenCalledWith(42);
    expect(res.body.streamer).toMatchObject({ id: 42 });
    expect(res.body.configByType.follow).toMatchObject({ event_type: 'follow', message_template: 'hi' });
  });

  it('exposes the fixed ALERT_EVENT_TYPES list to the template', async () => {
    const res = await supertest(buildApp()).get('/settings');
    expect(res.status).toBe(200);
    expect(res.body.eventTypes).toEqual(['follow', 'sub', 'resub', 'giftsub', 'raid']);
  });

  it('exposes the fixed ALERT_TEXT_ANIMATIONS list to the template', async () => {
    const res = await supertest(buildApp()).get('/settings');
    expect(res.status).toBe(200);
    expect(res.body.textAnimations).toEqual(['none', 'wave', 'pulse', 'glitch', 'shake', 'rainbow', 'flicker', 'tilt', 'bounce-in', 'typewriter']);
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
    alertsSourceConnections.set('somestreamer', new Set([{} as any]));
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

    const first = openOverlayConnection(alertsSourceConnections, 'somestreamer');
    expect(res.write).toHaveBeenCalledWith(`data: ${JSON.stringify({ connected: true })}\n\n`);
    res.write.mockClear();

    const second = openOverlayConnection(alertsSourceConnections, 'somestreamer'); // still connected — no repeat push
    openOverlayConnection(alertsSourceConnections, 'otherstreamer').close(); // another channel — ignored
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

    openOverlayConnection(alertsSourceConnections, 'somestreamer').close();

    expect(res.write).not.toHaveBeenCalled();
  });
});
