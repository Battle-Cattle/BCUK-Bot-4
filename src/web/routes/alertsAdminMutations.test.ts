import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../../test-utils/loggerMock';

/** Mocks the shared logger so route handlers don't write real log output during tests. */
vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));

vi.mock('../../db', () => ({
  ALERT_EVENT_TYPES: ['follow', 'sub', 'resub', 'giftsub', 'raid'],
  getStreamerByDiscordId: vi.fn(),
  saveAlertConfig: vi.fn(),
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

vi.mock('./alertsOverlaySource', () => ({
  pushAlertEvent: vi.fn(),
}));

// Pulled in transitively via '../../db/users' (for AccessLevel below) importing '../pool',
// which reads real env vars at module load time — an empty mock keeps that side effect out.
vi.mock('../../shared/config', () => ({}));

import supertest from 'supertest';
import { router } from './alertsAdminMutations';
import { getStreamerByDiscordId, saveAlertConfig } from '../../db';
import { AccessLevel } from '../../db/users';
import { pushAlertEvent } from './alertsOverlaySource';
import { buildTestApp } from '../../test-utils/expressTestApp';

type SessionUser = { discordId: string; discordName: string; discordAvatar: string | null; accessLevel: 0 | 1 | 2 | 3 };
const USER: SessionUser = { discordId: '100000000000000001', discordName: 'TestUser', discordAvatar: null, accessLevel: AccessLevel.USER };

const MOCK_STREAMER = {
  id: 123,
  twitch_user_id: 'twitch123',
  twitch_name: 'teststreamer',
  discord_id: USER.discordId,
};

/** Builds a supertest-ready app: the alerts admin mutations router with a stubbed session (no render stub — these routes redirect). */
function buildApp(sessionUser: SessionUser = USER) {
  return buildTestApp({ router, bodyParser: 'urlencoded', sessionUser });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getStreamerByDiscordId).mockResolvedValue(null);
  vi.mocked(saveAlertConfig).mockResolvedValue(undefined);
});

// --- POST /settings/:eventType (save non-file fields) ---

describe('POST /settings/:eventType', () => {
  it('redirects with error when user is not a streamer', async () => {
    const res = await supertest(buildApp()).post('/settings/follow').send('message_template=hi');
    expect(res.headers.location).toBe('/alerts/settings?error=not_a_streamer');
  });

  it('redirects with error for an invalid event type', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    const res = await supertest(buildApp()).post('/settings/bogus').send('message_template=hi');
    expect(res.headers.location).toBe('/alerts/settings?error=invalid_event_type');
  });

  it('redirects with error when message_template is blank', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    const res = await supertest(buildApp()).post('/settings/follow').send('message_template=   ');
    expect(res.headers.location).toBe('/alerts/settings?error=invalid_message');
  });

  it('saves enabled=true, the trimmed message, and a clamped duration', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    const res = await supertest(buildApp())
      .post('/settings/follow')
      .send('enabled=on&message_template=  Welcome {display_name}!  &duration_ms=4500');
    expect(res.headers.location).toBe('/alerts/settings?success=config_saved');
    expect(vi.mocked(saveAlertConfig)).toHaveBeenCalledWith(MOCK_STREAMER.id, 'follow', {
      enabled: true,
      message_template: 'Welcome {display_name}!',
      duration_ms: 4500,
    });
  });

  it('saves enabled=false when the checkbox is absent', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    await supertest(buildApp()).post('/settings/follow').send('message_template=hi&duration_ms=5000');
    expect(vi.mocked(saveAlertConfig)).toHaveBeenCalledWith(MOCK_STREAMER.id, 'follow', expect.objectContaining({ enabled: false }));
  });

  it('clamps duration_ms to the 1000-60000 range', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    await supertest(buildApp()).post('/settings/follow').send('message_template=hi&duration_ms=999999');
    expect(vi.mocked(saveAlertConfig)).toHaveBeenCalledWith(MOCK_STREAMER.id, 'follow', expect.objectContaining({ duration_ms: 60000 }));

    await supertest(buildApp()).post('/settings/follow').send('message_template=hi&duration_ms=1');
    expect(vi.mocked(saveAlertConfig)).toHaveBeenCalledWith(MOCK_STREAMER.id, 'follow', expect.objectContaining({ duration_ms: 1000 }));
  });

  it('defaults duration_ms to 6000 when missing or non-numeric', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    await supertest(buildApp()).post('/settings/follow').send('message_template=hi');
    expect(vi.mocked(saveAlertConfig)).toHaveBeenCalledWith(MOCK_STREAMER.id, 'follow', expect.objectContaining({ duration_ms: 6000 }));
  });
});

// --- POST /settings/:eventType/test ---

describe('POST /settings/:eventType/test', () => {
  it('redirects with error when user is not a streamer', async () => {
    const res = await supertest(buildApp()).post('/settings/follow/test');
    expect(res.headers.location).toBe('/alerts/settings?error=not_a_streamer');
  });

  it('redirects with error for an invalid event type', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    const res = await supertest(buildApp()).post('/settings/bogus/test');
    expect(res.headers.location).toBe('/alerts/settings?error=invalid_event_type');
  });

  it('redirects with not_a_streamer error when the streamer has no Twitch name connected', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue({ ...MOCK_STREAMER, twitch_name: null } as any);
    const res = await supertest(buildApp()).post('/settings/follow/test');
    expect(res.headers.location).toBe('/alerts/settings?error=not_a_streamer');
    expect(vi.mocked(pushAlertEvent)).not.toHaveBeenCalled();
  });

  it('pushes a synthetic test alert to the streamer\'s lowercased login', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    const res = await supertest(buildApp()).post('/settings/follow/test');
    expect(res.headers.location).toBe('/alerts/settings?success=test_sent');
    expect(vi.mocked(pushAlertEvent)).toHaveBeenCalledWith('teststreamer', expect.objectContaining({ type: 'follow' }));
  });
});
