import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../../test-utils/loggerMock';
import { ACCESS_LEVEL_MOCK } from '../../test-utils/accessLevelMock';

vi.mock('../../db', () => ({
  findUser: vi.fn(),
  getStreamerByDiscordId: vi.fn(),
  saveEventConfig: vi.fn(),
  clearStreamerToken: vi.fn(),
  listPasskeysForUser: vi.fn(),
  bumpSessionGeneration: vi.fn(),
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

vi.mock('../../twitch/eventsub/twitchEventSub', () => ({
  reloadEventSubSubscriptions: vi.fn(),
}));

vi.mock('../../twitch/eventsub/twitchEventSubCreate', () => ({
  hasAuthFailedSubs: vi.fn().mockReturnValue(false),
}));

// The fake status stream in the real-session test is never attached through attachSseConnection, so its cleanup chain is stubbed (as in sessionStreams.test.ts).
vi.mock('./sseChannel', () => ({ chainConnectionCleanup: () => true }));

vi.mock('../../shared/config', () => ({
  TWITCH_CLIENT_ID: 'test-client-id',
  TWITCH_EVENTSUB_REDIRECT_URI: 'http://localhost/callback',
  EVENTSUB_TOKEN_SECRET: 'test-secret',
}));

vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));

// The real sign-out is kept (as `actualSignOut`) for the real-session test; every other test stubs it.
const actualSignOut = vi.hoisted(() => ({ run: undefined as undefined | ((req: any) => Promise<void>) }));
vi.mock('../loginSession', async (importOriginal) => {
  actualSignOut.run = (await importOriginal<typeof import('../loginSession')>()).signOutOtherSessions;
  return { signOutOtherSessions: vi.fn() };
});

import express from 'express';
import session from 'express-session';
import supertest from 'supertest';
import router, { buildEventSubConfig, findBotEnabledStreamer, hasOverlongMessage } from './userSettings';
import { findUser, getStreamerByDiscordId, saveEventConfig, clearStreamerToken, listPasskeysForUser, bumpSessionGeneration } from '../../db';
import { reloadEventSubSubscriptions } from '../../twitch/eventsub/twitchEventSub';
import { signOutOtherSessions } from '../loginSession';
import { AccessLevel } from '../../db';
import { createHungDestroyStore, fakeStatusStream } from '../../test-utils/hungDestroySession';
import { registerSessionStream, CONTEXT_CHANGED_FRAME } from '../sessionStreams';
import { waitFor } from '../../test-utils/waitFor';
import { buildTestApp } from '../../test-utils/expressTestApp';
import { makeSessionUser, type SessionUserFixture } from '../../test-utils/fixtures';

type SessionUser = SessionUserFixture;
const USER: SessionUser = makeSessionUser({ accessLevel: AccessLevel.MOD });

/** Builds a supertest-ready app: the user settings router (or an override) with a stubbed session and a render mock that flattens locals into the JSON body. */
function buildApp(sessionUser: SessionUser = USER, routerOverride: typeof router = router) {
  return buildTestApp({ router: routerOverride, bodyParser: 'urlencoded', sessionUser, mockRender: 'spread' });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(findUser).mockResolvedValue(null);
  vi.mocked(getStreamerByDiscordId).mockResolvedValue(null);
  vi.mocked(listPasskeysForUser).mockResolvedValue([]);
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

describe('GET / — passkeys', () => {
  it("passes the user's passkeys to the template", async () => {
    const passkeys = [{ credentialId: 'cred1', deviceLabel: 'Phone', createdAt: new Date('2026-01-01T00:00:00Z'), lastUsedAt: null }];
    vi.mocked(listPasskeysForUser).mockResolvedValue(passkeys);
    const res = await supertest(buildApp()).get('/');
    expect(res.status).toBe(200);
    expect(listPasskeysForUser).toHaveBeenCalledWith(USER.discordId);
    expect(res.body.passkeys).toEqual([{ ...passkeys[0], createdAt: '2026-01-01T00:00:00.000Z' }]);
  });

  it('passes passkey success and error codes through to the template', async () => {
    const ok = await supertest(buildApp()).get('/?success=passkey_added');
    expect(ok.body.success).toBe('passkey_added');
    const err = await supertest(buildApp()).get('/?error=passkey_limit');
    expect(err.body.error).toBe('passkey_limit');
    for (const code of ['passkey_code_invalid', 'passkey_code_expired', 'passkey_dm_failed']) {
      const res = await supertest(buildApp()).get('/?error=' + code);
      expect(res.body.error).toBe(code);
    }
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
    vi.mocked(clearStreamerToken).mockResolvedValue(true);

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

  it('clears a saved checkbox when a connected streamer submits it unticked', async () => {
    vi.mocked(findUser).mockResolvedValue({ is_twitch_bot_enabled: true } as any);
    vi.mocked(getStreamerByDiscordId).mockResolvedValue({
      id: 9,
      twitch_name: 'streamer',
      eventsub_access_token: 'tok',
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

    // raid_enabled is omitted — the browser leaves out an unticked checkbox.
    const res = await supertest(buildApp())
      .post('/eventsub-config')
      .type('form')
      .send({
        follow_enabled: 'on',
        follow_message: 'Existing follow message',
        sub_enabled: 'on',
        sub_message: 'Existing sub message',
        resub_message: 'Existing resub message',
        giftsub_message: 'Existing giftsub message',
        raid_message: 'Existing raid message',
        raid_shoutout_enabled: 'on',
      });

    expect(res.status).toBe(302);
    expect(saveEventConfig).toHaveBeenCalledWith(9, expect.objectContaining({
      follow_enabled: true,
      sub_enabled: true,
      raid_enabled: false,
      raid_shoutout_enabled: true,
    }));
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

describe('findBotEnabledStreamer', () => {
  const STREAMER = { id: 7 } as Awaited<ReturnType<typeof getStreamerByDiscordId>>;

  it('returns no_streamer_record when the user has no streamer record', async () => {
    vi.mocked(findUser).mockResolvedValue({ is_twitch_bot_enabled: true } as any);
    expect(await findBotEnabledStreamer('1')).toEqual({ error: 'no_streamer_record' });
  });

  it('returns eventsub_not_bot_enabled when the twitch bot is disabled', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(STREAMER);
    vi.mocked(findUser).mockResolvedValue({ is_twitch_bot_enabled: false } as any);
    expect(await findBotEnabledStreamer('1')).toEqual({ error: 'eventsub_not_bot_enabled' });
  });

  it('returns the streamer when it exists and the twitch bot is enabled', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(STREAMER);
    vi.mocked(findUser).mockResolvedValue({ is_twitch_bot_enabled: true } as any);
    expect(await findBotEnabledStreamer('1')).toEqual({ streamer: STREAMER });
    expect(findUser).toHaveBeenCalledWith('1');
    expect(getStreamerByDiscordId).toHaveBeenCalledWith('1');
  });
});

describe('hasOverlongMessage', () => {
  it('is false when every message is within the limit', () => {
    expect(hasOverlongMessage({ follow_message: 'x'.repeat(500), raid_message: 'hi' })).toBe(false);
  });

  it('is true when any message exceeds the limit once trimmed', () => {
    expect(hasOverlongMessage({ raid_message: 'x'.repeat(501) })).toBe(true);
  });

  it('ignores surrounding whitespace when measuring length', () => {
    expect(hasOverlongMessage({ sub_message: `  ${'x'.repeat(500)}  ` })).toBe(false);
  });

  it('ignores non-message fields', () => {
    expect(hasOverlongMessage({ follow_enabled: 'x'.repeat(501) })).toBe(false);
  });
});

describe('buildEventSubConfig', () => {
  it('uses defaults for omitted fields when there is no saved config', () => {
    expect(buildEventSubConfig({}, null, false)).toEqual({
      follow_enabled: false,
      follow_message: 'Thanks {display_name} for the follow!',
      sub_enabled: false,
      sub_message: 'Thanks {display_name} for subscribing! ({tier_name})',
      resub_message: 'Thanks {display_name} for {months} months! ({tier_name})',
      giftsub_message: '{gifter_display} gifted {count} sub(s) to the community!',
      raid_enabled: false,
      raid_message: 'Welcome raiders from {from_display}! Thank you for the {viewers} person raid!',
      raid_shoutout_enabled: false,
    });
  });

  it('treats a present checkbox key with a value other than "on" as unchecked, ignoring the saved value', () => {
    const current = { follow_enabled: true } as any;
    expect(buildEventSubConfig({ follow_enabled: '' }, current, false).follow_enabled).toBe(false);
  });

  it('falls back to the default (not the saved value) for a present-but-blank message', () => {
    const current = { follow_message: 'Saved' } as any;
    expect(buildEventSubConfig({ follow_message: '   ' }, current, true).follow_message).toBe('Thanks {display_name} for the follow!');
  });

  it('treats an omitted checkbox as unticked when connected, clearing a saved true value', () => {
    const current = { follow_enabled: true, raid_enabled: true, raid_shoutout_enabled: true, sub_enabled: true } as any;
    const config = buildEventSubConfig({ follow_enabled: 'on' }, current, true);
    expect(config).toMatchObject({ follow_enabled: true, sub_enabled: false, raid_enabled: false, raid_shoutout_enabled: false });
  });

  it('keeps saved checkbox values for omitted (disabled) inputs when disconnected', () => {
    const current = { follow_enabled: true, raid_enabled: true } as any;
    expect(buildEventSubConfig({}, current, false)).toMatchObject({ follow_enabled: true, raid_enabled: true });
  });

  it('trims submitted messages', () => {
    expect(buildEventSubConfig({ raid_message: '  Hi raiders  ' }, null, true).raid_message).toBe('Hi raiders');
  });
});

describe('POST /sign-out-other-sessions', () => {
  it('signs out the other sessions and redirects with success (#1058)', async () => {
    vi.mocked(signOutOtherSessions).mockResolvedValue(undefined);
    const res = await supertest(buildApp()).post('/sign-out-other-sessions');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/user/settings?success=signed_out_others');
    expect(signOutOtherSessions).toHaveBeenCalledOnce();
  });

  it('redirects with sign_out_others_failed when the sign-out fails', async () => {
    vi.mocked(signOutOtherSessions).mockRejectedValue(new Error('DB down'));
    const res = await supertest(buildApp()).post('/sign-out-other-sessions');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/user/settings?error=sign_out_others_failed');
  });
});

describe('POST /sign-out-other-sessions with a real session whose store destroy never calls back (#1193)', () => {
  it('has already told the user\'s other dashboard streams to reload, and ended them, while the store is still hung; it redirects once the store answers', async () => {
    vi.mocked(signOutOtherSessions).mockImplementationOnce(actualSignOut.run!); // set by the mock factory above
    vi.mocked(bumpSessionGeneration).mockResolvedValueOnce(2);
    const { store, release } = createHungDestroyStore();
    const app = express();
    app.set('trust proxy', 1);
    // As in production: a secure, httpOnly cookie behind the proxy (the requests below send X-Forwarded-Proto: https).
    app.use(session({ secret: 'x'.repeat(32), resave: false, saveUninitialized: false, store, cookie: { secure: true, httpOnly: true, sameSite: 'lax' } }));
    app.get('/login', (req, res) => {
      (req.session as any).user = { discordId: '42' };
      res.sendStatus(204);
    });
    app.use('/', router);
    const https = { 'X-Forwarded-Proto': 'https' };
    const cookie = (await supertest(app).get('/login').set(https)).headers['set-cookie']?.[0]?.split(';')[0] ?? '';
    // Another session of the same user (a different session ID, so it is not the one signing out).
    const { req: otherReq, res: otherStream } = fakeStatusStream('other-session-id', '42');
    expect(registerSessionStream(otherReq, otherStream, 'status')).toBe(true);

    let responded = false;
    const request = supertest(app).post('/sign-out-other-sessions').set(https).set('Cookie', cookie).then((res) => { responded = true; return res; });
    await waitFor(() => expect(otherStream.end).toHaveBeenCalledTimes(1));

    // The frame and the end came before the store answered: nothing waited on it.
    expect(otherStream.write).toHaveBeenCalledWith(CONTEXT_CHANGED_FRAME);
    expect(responded).toBe(false);
    release();
    const res = await request;
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/user/settings?success=signed_out_others');
  });
});

describe('GET / — sign-out banners', () => {
  it('passes the sign-out success and error codes through to the template', async () => {
    const ok = await supertest(buildApp()).get('/?success=signed_out_others');
    expect(ok.body.success).toBe('signed_out_others');
    for (const code of ['sign_out_others_failed', 'passkey_removed_sign_out_failed']) {
      const res = await supertest(buildApp()).get(`/?error=${code}`);
      expect(res.body.error).toBe(code);
    }
  });
});
