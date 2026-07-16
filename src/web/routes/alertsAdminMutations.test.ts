import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../../test-utils/loggerMock';

/** Mocks the shared logger so route handlers don't write real log output during tests. */
vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));

vi.mock('../../db', () => ({
  ALERT_EVENT_TYPES: ['follow', 'sub', 'resub', 'giftsub', 'raid'],
  ALERT_TEXT_ANIMATIONS: ['none', 'wave', 'pulse', 'glitch', 'shake', 'rainbow', 'flicker', 'tilt', 'bounce-in', 'typewriter'],
  getStreamerByDiscordId: vi.fn(),
  saveAlertConfig: vi.fn(),
  getAlertConfig: vi.fn(),
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

vi.mock('../../twitch/eventsub/twitchEventSub', () => ({
  reloadEventSubSubscriptions: vi.fn(),
}));

// Pulled in transitively via '../../db/users' (for AccessLevel below) importing '../pool',
// which reads real env vars at module load time — an empty mock keeps that side effect out.
vi.mock('../../shared/config', () => ({}));

import supertest from 'supertest';
import { router } from './alertsAdminMutations';
import { getStreamerByDiscordId, saveAlertConfig, getAlertConfig } from '../../db';
import { AccessLevel } from '../../db/users';
import { pushAlertEvent } from './alertsOverlaySource';
import { reloadEventSubSubscriptions } from '../../twitch/eventsub/twitchEventSub';
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
  vi.mocked(getAlertConfig).mockResolvedValue(null);
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
      .send('enabled=on&message_template=  Welcome {display_name}!  &duration_ms=4500&text_animation=pulse');
    expect(res.headers.location).toBe('/alerts/settings?success=config_saved');
    expect(vi.mocked(saveAlertConfig)).toHaveBeenCalledWith(MOCK_STREAMER.id, 'follow', {
      enabled: true,
      message_template: 'Welcome {display_name}!',
      duration_ms: 4500,
      text_animation: 'pulse',
    });
  });

  it('defaults text_animation to "none" when missing or unrecognised', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    await supertest(buildApp()).post('/settings/follow').send('message_template=hi');
    expect(vi.mocked(saveAlertConfig)).toHaveBeenCalledWith(MOCK_STREAMER.id, 'follow', expect.objectContaining({ text_animation: 'none' }));

    await supertest(buildApp()).post('/settings/follow').send('message_template=hi&text_animation=bogus');
    expect(vi.mocked(saveAlertConfig)).toHaveBeenCalledWith(MOCK_STREAMER.id, 'follow', expect.objectContaining({ text_animation: 'none' }));
  });

  it('accepts each of the newer text animation styles', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    for (const anim of ['shake', 'rainbow', 'flicker', 'tilt', 'bounce-in', 'typewriter']) {
      await supertest(buildApp()).post('/settings/follow').send(`message_template=hi&text_animation=${anim}`);
      expect(vi.mocked(saveAlertConfig)).toHaveBeenCalledWith(MOCK_STREAMER.id, 'follow', expect.objectContaining({ text_animation: anim }));
    }
  });

  it('reloads EventSub subscriptions after a successful save, so an alert-only enable takes effect', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    await supertest(buildApp()).post('/settings/follow').send('enabled=on&message_template=hi');
    expect(vi.mocked(reloadEventSubSubscriptions)).toHaveBeenCalledTimes(1);
  });

  it('does not reload EventSub subscriptions when the save is rejected (invalid message)', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    await supertest(buildApp()).post('/settings/follow').send('message_template=   ');
    expect(vi.mocked(reloadEventSubSubscriptions)).not.toHaveBeenCalled();
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

  it('pushes a fallback test alert to the streamer\'s lowercased login when no config row exists', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue({ ...MOCK_STREAMER, twitch_name: 'TestStreamer' } as any);
    const res = await supertest(buildApp()).post('/settings/follow/test');
    expect(res.headers.location).toBe('/alerts/settings?success=test_sent');
    expect(vi.mocked(pushAlertEvent)).toHaveBeenCalledWith('teststreamer', {
      type: 'follow',
      message: 'Test alert — follow',
      imageUrl: null,
      soundUrl: null,
      durationMs: 6000,
      textAnimation: 'none',
    });
  });

  it('pushes the streamer\'s actual saved config (message/image/sound/duration/animation) when one exists, with placeholders filled by sample values', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    vi.mocked(getAlertConfig).mockResolvedValue({
      id: 1,
      streamer_id: MOCK_STREAMER.id,
      event_type: 'follow',
      enabled: true,
      message_template: 'Welcome {display_name}!',
      image_filename: 'follow.png',
      sound_filename: 'follow.mp3',
      duration_ms: 4000,
      text_animation: 'wave',
    } as any);

    const res = await supertest(buildApp()).post('/settings/follow/test');

    expect(res.headers.location).toBe('/alerts/settings?success=test_sent');
    expect(vi.mocked(getAlertConfig)).toHaveBeenCalledWith(MOCK_STREAMER.id, 'follow');
    expect(vi.mocked(pushAlertEvent)).toHaveBeenCalledWith('teststreamer', {
      type: 'follow',
      message: '[Test] Welcome TestUser!',
      imageUrl: `/alerts/assets/${MOCK_STREAMER.id}/follow.png`,
      soundUrl: `/alerts/assets/${MOCK_STREAMER.id}/follow.mp3`,
      durationMs: 4000,
      textAnimation: 'wave',
    });
  });

  it('leaves an unrecognised placeholder in place as a typo hint instead of blanking it', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    vi.mocked(getAlertConfig).mockResolvedValue({
      id: 1,
      streamer_id: MOCK_STREAMER.id,
      event_type: 'follow',
      enabled: true,
      message_template: 'Hi {display_nam}!',
      image_filename: null,
      sound_filename: null,
      duration_ms: 4000,
      text_animation: 'none',
    } as any);

    await supertest(buildApp()).post('/settings/follow/test');

    expect(vi.mocked(pushAlertEvent)).toHaveBeenCalledWith('teststreamer', expect.objectContaining({
      message: '[Test] Hi {display_nam}!',
    }));
  });
});
