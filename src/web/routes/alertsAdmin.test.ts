import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db', () => ({
  ALERT_EVENT_TYPES: ['follow', 'sub', 'resub', 'giftsub', 'raid'],
  getStreamerByDiscordId: vi.fn(),
  getAlertConfigsForStreamer: vi.fn(),
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
}));

const { logMock } = vi.hoisted(() => ({
  logMock: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../shared/logger', () => ({
  createLogger: () => logMock,
}));

vi.mock('./alertsAdminMutations', async () => {
  const { Router } = await import('express');
  return { router: Router(), MAX_IMAGE_MB: 10, MAX_SOUND_MB: 5 };
});

import supertest from 'supertest';
import router from './alertsAdmin';
import { getStreamerByDiscordId, getAlertConfigsForStreamer } from '../../db';
import { AccessLevel } from '../../db/users';
import { buildTestApp } from '../../test-utils/expressTestApp';
import { makeSessionUser, type SessionUserFixture } from '../../test-utils/fixtures';

type SessionUser = SessionUserFixture;
const USER: SessionUser = makeSessionUser({ accessLevel: AccessLevel.MOD });

/** Builds a supertest-ready app: the alerts admin router with a stubbed session and a render mock that flattens locals into the JSON body. */
function buildApp(sessionUser: SessionUser = USER) {
  return buildTestApp({ router, bodyParser: 'urlencoded', sessionUser, mockRender: 'spread' });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getStreamerByDiscordId).mockResolvedValue(null);
  vi.mocked(getAlertConfigsForStreamer).mockResolvedValue([]);
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
  });

  it('exposes the fixed ALERT_EVENT_TYPES list to the template', async () => {
    const res = await supertest(buildApp()).get('/settings');
    expect(res.status).toBe(200);
    expect(res.body.eventTypes).toEqual(['follow', 'sub', 'resub', 'giftsub', 'raid']);
  });
});
