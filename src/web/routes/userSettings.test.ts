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

vi.mock('../../twitch/eventsub/twitchEventSub', () => ({
  reloadEventSubSubscriptions: vi.fn(),
}));

vi.mock('../../twitch/eventsub/twitchEventSubSubscriptions', () => ({
  hasAuthFailedSubs: vi.fn().mockReturnValue(false),
}));

vi.mock('../../shared/config', () => ({
  TWITCH_CLIENT_ID: 'test-client-id',
  TWITCH_EVENTSUB_REDIRECT_URI: 'http://localhost/callback',
  EVENTSUB_TOKEN_SECRET: 'test-secret',
}));

vi.mock('../../shared/logger', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

import express from 'express';
import supertest from 'supertest';
import router from './userSettings';
import { findUser, getStreamerByDiscordId, saveEventConfig, clearStreamerToken } from '../../db';
import { reloadEventSubSubscriptions } from '../../twitch/eventsub/twitchEventSub';
import { AccessLevel } from '../../db/users';

type SessionUser = { discordId: string; discordName: string; discordAvatar: string | null; accessLevel: 0 | 1 | 2 | 3 };
const USER: SessionUser = { discordId: '100000000000000001', discordName: 'TestUser', discordAvatar: null, accessLevel: AccessLevel.MOD };

function buildApp(sessionUser: SessionUser = USER, routerOverride: typeof router = router) {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use((req: any, res: any, next: any) => {
    req.session = { user: sessionUser };
    res.render = (view: string, locals?: any) => res.json({ view, ...locals });
    next();
  });
  app.use(routerOverride);
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

describe('GET /twitch-connect — session state shape', () => {
  it('writes eventsubOAuthState as { value, expiresAt } with a 10-minute expiry window', async () => {
    vi.mocked(findUser).mockResolvedValue({ is_twitch_bot_enabled: true } as any);
    vi.mocked(getStreamerByDiscordId).mockResolvedValue({ id: 42, twitch_name: 'streamer' } as any);

    let capturedSession: any;
    const app = express();
    app.use((req: any, res: any, next: any) => {
      req.session = { user: USER };
      capturedSession = req.session;
      res.render = (view: string, locals?: any) => res.json({ view, ...locals });
      next();
    });
    app.use(router);

    const now = Date.now();
    const res = await supertest(app).get('/twitch-connect');

    expect(res.status).toBe(302);
    expect(capturedSession.eventsubOAuthState).toBeDefined();
    expect(typeof capturedSession.eventsubOAuthState.value).toBe('string');
    expect(capturedSession.eventsubOAuthState.value.length).toBeGreaterThan(0);
    expect(capturedSession.eventsubOAuthState.expiresAt).toBeGreaterThan(now + 9 * 60 * 1000);
    expect(capturedSession.eventsubOAuthState.expiresAt).toBeLessThan(now + 11 * 60 * 1000);
    expect(capturedSession.eventsubStreamerId).toBe(42);
  });
});

describe('getFriendlyError (passed to the template as a helper)', () => {
  it('falls back to a generic message for a key with no mapped copy', async () => {
    let captured: any;
    const app = express();
    app.use((req: any, res: any, next: any) => {
      req.session = { user: USER };
      res.render = (_view: string, locals?: any) => {
        captured = locals;
        res.json({});
      };
      next();
    });
    app.use(router);

    await supertest(app).get('/');
    expect(captured.getFriendlyError('some_unmapped_key')).toBe('An error occurred (some_unmapped_key).');
  });
});

describe('GET /twitch-connect — error redirects', () => {
  it('redirects with no_streamer_record when there is no streamer record', async () => {
    vi.mocked(findUser).mockResolvedValue({ is_twitch_bot_enabled: true } as any);
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(null);

    const res = await supertest(buildApp()).get('/twitch-connect');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/user/settings?error=no_streamer_record');
  });

  it('redirects with eventsub_not_bot_enabled when the twitch bot is disabled', async () => {
    vi.mocked(findUser).mockResolvedValue({ is_twitch_bot_enabled: false } as any);
    vi.mocked(getStreamerByDiscordId).mockResolvedValue({ id: 1, twitch_name: 'streamer' } as any);

    const res = await supertest(buildApp()).get('/twitch-connect');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/user/settings?error=eventsub_not_bot_enabled');
  });

  it('redirects with eventsub_config_failed when an unexpected error occurs', async () => {
    vi.mocked(findUser).mockRejectedValue(new Error('DB down'));
    vi.mocked(getStreamerByDiscordId).mockResolvedValue({ id: 1, twitch_name: 'streamer' } as any);

    const res = await supertest(buildApp()).get('/twitch-connect');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/user/settings?error=eventsub_config_failed');
  });

  it('redirects with eventsub_config_failed when EventSub env vars are not configured', async () => {
    vi.resetModules();
    vi.doMock('../../shared/config', () => ({
      TWITCH_CLIENT_ID: '',
      TWITCH_EVENTSUB_REDIRECT_URI: '',
      EVENTSUB_TOKEN_SECRET: '',
    }));
    const freshRouter = (await import('./userSettings.js')).default;
    const { findUser: freshFindUser, getStreamerByDiscordId: freshGetStreamer } = await import('../../db.js');
    vi.mocked(freshFindUser).mockResolvedValue({ is_twitch_bot_enabled: true } as any);
    vi.mocked(freshGetStreamer).mockResolvedValue({ id: 1, twitch_name: 'streamer' } as any);

    const res = await supertest(buildApp(USER, freshRouter as any)).get('/twitch-connect');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/user/settings?error=eventsub_config_failed');
  });
});

describe('POST /twitch-disconnect', () => {
  it('redirects with no_streamer_record when there is no streamer record', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(null);

    const res = await supertest(buildApp()).post('/twitch-disconnect');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/user/settings?error=no_streamer_record');
    expect(clearStreamerToken).not.toHaveBeenCalled();
  });

  it('clears the token, reloads EventSub subscriptions, and redirects on success', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue({ id: 7, twitch_name: 'streamer' } as any);
    vi.mocked(clearStreamerToken).mockResolvedValue(undefined);

    const res = await supertest(buildApp()).post('/twitch-disconnect');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/user/settings');
    expect(clearStreamerToken).toHaveBeenCalledWith(7);
    expect(reloadEventSubSubscriptions).toHaveBeenCalledOnce();
  });

  it('redirects with eventsub_disconnect_failed when clearing the token fails', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue({ id: 7, twitch_name: 'streamer' } as any);
    vi.mocked(clearStreamerToken).mockRejectedValue(new Error('DB down'));

    const res = await supertest(buildApp()).post('/twitch-disconnect');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/user/settings?error=eventsub_disconnect_failed');
  });
});

describe('POST /eventsub-config', () => {
  const STREAMER = { id: 9, twitch_name: 'streamer', config: null };

  it('redirects with no_streamer_record when there is no streamer record', async () => {
    vi.mocked(findUser).mockResolvedValue({ is_twitch_bot_enabled: true } as any);
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(null);

    const res = await supertest(buildApp()).post('/eventsub-config').type('form').send({});
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/user/settings?error=no_streamer_record');
  });

  it('redirects with eventsub_not_bot_enabled when the twitch bot is disabled', async () => {
    vi.mocked(findUser).mockResolvedValue({ is_twitch_bot_enabled: false } as any);
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(STREAMER as any);

    const res = await supertest(buildApp()).post('/eventsub-config').type('form').send({});
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/user/settings?error=eventsub_not_bot_enabled');
  });

  it('redirects with eventsub_config_failed when a message field exceeds 500 characters', async () => {
    vi.mocked(findUser).mockResolvedValue({ is_twitch_bot_enabled: true } as any);
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(STREAMER as any);

    const res = await supertest(buildApp())
      .post('/eventsub-config')
      .type('form')
      .send({ follow_message: 'x'.repeat(501) });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/user/settings?error=eventsub_config_failed');
    expect(saveEventConfig).not.toHaveBeenCalled();
  });

  it('saves the submitted config, reloads EventSub subscriptions, and redirects on success', async () => {
    vi.mocked(findUser).mockResolvedValue({ is_twitch_bot_enabled: true } as any);
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(STREAMER as any);
    vi.mocked(saveEventConfig).mockResolvedValue(undefined);

    const res = await supertest(buildApp())
      .post('/eventsub-config')
      .type('form')
      .send({
        follow_enabled: 'on',
        follow_message: 'Thanks {display_name}!',
        sub_enabled: 'on',
        sub_message: 'Sub message',
        resub_message: 'Resub message',
        giftsub_message: 'Gift message',
        raid_enabled: 'on',
        raid_message: 'Raid message',
        raid_shoutout_enabled: 'on',
      });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/user/settings');
    expect(saveEventConfig).toHaveBeenCalledWith(9, {
      follow_enabled: true,
      follow_message: 'Thanks {display_name}!',
      sub_enabled: true,
      sub_message: 'Sub message',
      resub_message: 'Resub message',
      giftsub_message: 'Gift message',
      raid_enabled: true,
      raid_message: 'Raid message',
      raid_shoutout_enabled: true,
    });
    expect(reloadEventSubSubscriptions).toHaveBeenCalledOnce();
  });

  it('persists raid_shoutout_enabled independently of raid_enabled (shoutout on, welcome message off)', async () => {
    vi.mocked(findUser).mockResolvedValue({ is_twitch_bot_enabled: true } as any);
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(STREAMER as any);
    vi.mocked(saveEventConfig).mockResolvedValue(undefined);

    const res = await supertest(buildApp())
      .post('/eventsub-config')
      .type('form')
      .send({
        follow_message: 'Thanks {display_name}!',
        sub_message: 'Sub message',
        resub_message: 'Resub message',
        giftsub_message: 'Gift message',
        raid_message: 'Raid message',
        raid_shoutout_enabled: 'on',
        // raid_enabled intentionally omitted — checkbox unchecked
      });

    expect(res.status).toBe(302);
    expect(saveEventConfig).toHaveBeenCalledWith(9, expect.objectContaining({
      raid_enabled: false,
      raid_shoutout_enabled: true,
    }));
  });

  it('falls back to existing config values for fields omitted from the body', async () => {
    vi.mocked(findUser).mockResolvedValue({ is_twitch_bot_enabled: true } as any);
    vi.mocked(getStreamerByDiscordId).mockResolvedValue({
      id: 9,
      twitch_name: 'streamer',
      config: {
        follow_enabled: true,
        follow_message: 'Existing follow message',
        sub_enabled: true,
        sub_message: 'Existing sub message',
        resub_message: 'Existing resub message',
        giftsub_message: 'Existing giftsub message',
        raid_enabled: true,
        raid_message: 'Existing raid message',
        raid_shoutout_enabled: true,
      },
    } as any);
    vi.mocked(saveEventConfig).mockResolvedValue(undefined);

    // Only follow_enabled/follow_message are present, as if the UI disabled the rest.
    const res = await supertest(buildApp())
      .post('/eventsub-config')
      .type('form')
      .send({ follow_enabled: 'on', follow_message: 'New follow message' });

    expect(res.status).toBe(302);
    expect(saveEventConfig).toHaveBeenCalledWith(9, {
      follow_enabled: true,
      follow_message: 'New follow message',
      sub_enabled: true,
      sub_message: 'Existing sub message',
      resub_message: 'Existing resub message',
      giftsub_message: 'Existing giftsub message',
      raid_enabled: true,
      raid_message: 'Existing raid message',
      raid_shoutout_enabled: true,
    });
  });

  it('redirects with eventsub_config_failed when saving fails', async () => {
    vi.mocked(findUser).mockResolvedValue({ is_twitch_bot_enabled: true } as any);
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(STREAMER as any);
    vi.mocked(saveEventConfig).mockRejectedValue(new Error('DB down'));

    const res = await supertest(buildApp()).post('/eventsub-config').type('form').send({});
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/user/settings?error=eventsub_config_failed');
  });
});
