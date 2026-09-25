import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../../test-utils/loggerMock';
import { ACCESS_LEVEL_MOCK } from '../../test-utils/accessLevelMock';

/** Mocks the shared logger so route handlers don't write real log output during tests. */
vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));

vi.mock('../../db', () => ({
  getStreamerById: vi.fn(),
  saveStreamerToken: vi.fn(),
  initEventConfig: vi.fn(),
  initAlertConfigs: vi.fn(),
  AccessLevel: ACCESS_LEVEL_MOCK,
}));

vi.mock('../../twitch/eventsub/twitchApiEventSub', () => ({
  exchangeCode: vi.fn(),
  getUserFromToken: vi.fn(),
}));

const REDIRECT_URI = 'https://example.com/auth/twitch/eventsub/callback';
// A getter keeps the redirect URI adjustable per test (e.g. unset to cover the misconfiguration path).
const mockConfig = vi.hoisted(() => ({ redirectUri: undefined as string | undefined }));
vi.mock('../../shared/config', () => ({
  get TWITCH_EVENTSUB_REDIRECT_URI() { return mockConfig.redirectUri; },
}));

vi.mock('../../twitch/eventsub/twitchEventSub', () => ({
  reloadEventSubSubscriptions: vi.fn(),
}));

vi.mock('../../twitch/eventsub/twitchEventSubSubscriptions', () => ({
  clearAuthFailedSubs: vi.fn(),
}));

import express from 'express';
import supertest from 'supertest';
import router, { isExpectedTwitchAccount, validateOAuthCallback } from './eventsubCallback';
import { getStreamerById, saveStreamerToken, initEventConfig, initAlertConfigs } from '../../db';
import { exchangeCode, getUserFromToken } from '../../twitch/eventsub/twitchApiEventSub';
import { AccessLevel } from '../../db';
import { buildTestApp } from '../../test-utils/expressTestApp';
import { makeSessionUser, type SessionUserFixture } from '../../test-utils/fixtures';

type SessionUser = SessionUserFixture;

const MOCK_STREAMER = {
  id: 1,
  discord_id: '100000000000000001',
  twitch_name: 'teststreamer',
  twitch_user_id: 'twitch123',
};

const SESSION_USER: SessionUser = makeSessionUser({ discordId: MOCK_STREAMER.discord_id, accessLevel: AccessLevel.MOD });

/** Builds a supertest-ready app: the EventSub-callback router with a valid OAuth-state session for `MOCK_STREAMER`, customizable via `sessionOverrides`. */
function buildApp(sessionOverrides: Record<string, any> = {}) {
  return buildTestApp({
    router,
    session: {
      eventsubOAuthState: { value: 'valid-state-abc', expiresAt: Date.now() + 60_000 },
      eventsubStreamerId: MOCK_STREAMER.id,
      user: SESSION_USER,
      ...sessionOverrides,
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockConfig.redirectUri = REDIRECT_URI;
  vi.mocked(getStreamerById).mockResolvedValue(MOCK_STREAMER as any);
  vi.mocked(exchangeCode).mockResolvedValue({
    access_token: 'access',
    refresh_token: 'refresh',
    expires_in: 3600,
  } as any);
  vi.mocked(getUserFromToken).mockResolvedValue({ login: 'teststreamer', id: 'twitch123' } as any);
  vi.mocked(saveStreamerToken).mockResolvedValue(undefined);
  vi.mocked(initEventConfig).mockResolvedValue(undefined);
  vi.mocked(initAlertConfigs).mockResolvedValue(undefined);
});

describe('GET /twitch/eventsub/callback — state validation', () => {
  it('rejects with state_mismatch when state param does not match session', async () => {
    const res = await supertest(buildApp())
      .get('/twitch/eventsub/callback?code=abc&state=wrong-state');
    expect(res.headers.location).toContain('error=eventsub_oauth_state_mismatch');
  });

  it('rejects with state_mismatch when session has no state', async () => {
    const res = await supertest(buildApp({ eventsubOAuthState: undefined }))
      .get('/twitch/eventsub/callback?code=abc&state=valid-state-abc');
    expect(res.headers.location).toContain('error=eventsub_oauth_state_mismatch');
  });

  it('redirects with denied error when OAuth returns error param and clears session state', async () => {
    let capturedSession: any;
    const app = express();
    app.use((req: any, _res: any, next: any) => {
      req.session = {
        eventsubOAuthState: { value: 'valid-state-abc', expiresAt: Date.now() + 60_000 },
        eventsubStreamerId: MOCK_STREAMER.id,
        user: SESSION_USER,
      };
      capturedSession = req.session;
      next();
    });
    app.use(router);
    const res = await supertest(app).get('/twitch/eventsub/callback?error=access_denied');
    expect(res.headers.location).toContain('error=eventsub_oauth_denied');
    expect(capturedSession.eventsubOAuthState).toBeUndefined();
    expect(capturedSession.eventsubStreamerId).toBeUndefined();
  });

  it('rejects with state_mismatch when OAuth state has expired', async () => {
    const res = await supertest(buildApp({ eventsubOAuthState: { value: 'valid-state-abc', expiresAt: Date.now() - 1 } }))
      .get('/twitch/eventsub/callback?code=abc&state=valid-state-abc');
    expect(res.headers.location).toContain('error=eventsub_oauth_state_mismatch');
  });

  it('redirects with config_failed and never exchanges the code when the redirect URI is not configured', async () => {
    mockConfig.redirectUri = undefined;
    const res = await supertest(buildApp())
      .get('/twitch/eventsub/callback?code=abc&state=valid-state-abc');
    expect(res.headers.location).toBe('/user/settings?error=eventsub_config_failed');
    expect(exchangeCode).not.toHaveBeenCalled();
  });
});

describe('GET /twitch/eventsub/callback — user binding', () => {
  it('rejects when authenticated user does not own the streamer record', async () => {
    const differentUser: SessionUser = { ...SESSION_USER, discordId: '999999999999999999' };
    const res = await supertest(buildApp({ user: differentUser }))
      .get('/twitch/eventsub/callback?code=abc&state=valid-state-abc');
    expect(res.headers.location).toContain('error=eventsub_oauth_state_mismatch');
    expect(vi.mocked(saveStreamerToken)).not.toHaveBeenCalled();
    expect(vi.mocked(exchangeCode)).not.toHaveBeenCalled();
    expect(vi.mocked(getUserFromToken)).not.toHaveBeenCalled();
  });

  it('succeeds when authenticated user owns the streamer record', async () => {
    const res = await supertest(buildApp())
      .get('/twitch/eventsub/callback?code=abc&state=valid-state-abc');
    expect(res.headers.location).toContain('success=twitch_connected');
    expect(vi.mocked(saveStreamerToken)).toHaveBeenCalled();
    expect(vi.mocked(initEventConfig)).toHaveBeenCalledWith(MOCK_STREAMER.id);
    expect(vi.mocked(initAlertConfigs)).toHaveBeenCalledWith(MOCK_STREAMER.id);
  });

  it('succeeds when there is no authenticated user in session (unauthenticated callback)', async () => {
    const res = await supertest(buildApp({ user: undefined }))
      .get('/twitch/eventsub/callback?code=abc&state=valid-state-abc');
    expect(res.headers.location).toContain('success=twitch_connected');
    expect(vi.mocked(saveStreamerToken)).toHaveBeenCalled();
  });
});

describe('isExpectedTwitchAccount', () => {
  it('matches case-insensitively', () => {
    expect(isExpectedTwitchAccount('StreamerA', 'streamera')).toBe(true);
  });

  it('rejects a different login', () => {
    expect(isExpectedTwitchAccount('streamera', 'someoneelse')).toBe(false);
  });

  it('rejects when the streamer has no Twitch name', () => {
    expect(isExpectedTwitchAccount(null, 'streamera')).toBe(false);
    expect(isExpectedTwitchAccount('', 'streamera')).toBe(false);
  });
});

describe('validateOAuthCallback', () => {
  const stored = { value: 'valid-state-abc', expiresAt: Date.now() + 60_000 };
  const valid = { code: 'abc', state: 'valid-state-abc' };

  it('returns the code, streamer id and redirect URI when every check passes', () => {
    expect(validateOAuthCallback(valid, stored, 1)).toEqual({ ok: true, code: 'abc', streamerId: 1, redirectUri: REDIRECT_URI });
  });

  it('returns eventsub_oauth_denied when Twitch reports an error, even with otherwise valid values', () => {
    expect(validateOAuthCallback({ ...valid, error: 'access_denied' }, stored, 1))
      .toEqual({ ok: false, errorCode: 'eventsub_oauth_denied' });
  });

  it.each([
    ['code', { state: 'valid-state-abc' }, stored, 1],
    ['state', { code: 'abc' }, stored, 1],
    ['stored OAuth state', valid, undefined, 1],
    ['streamer id', valid, stored, undefined],
  ] as const)('returns eventsub_oauth_state_mismatch when the %s is missing', (_label, query, storedOAuth, streamerId) => {
    expect(validateOAuthCallback(query, storedOAuth, streamerId))
      .toEqual({ ok: false, errorCode: 'eventsub_oauth_state_mismatch' });
  });

  it('returns eventsub_oauth_state_mismatch when the state does not match', () => {
    expect(validateOAuthCallback({ ...valid, state: 'wrong-state' }, stored, 1))
      .toEqual({ ok: false, errorCode: 'eventsub_oauth_state_mismatch' });
  });

  it('returns eventsub_oauth_state_mismatch when the stored state has expired', () => {
    expect(validateOAuthCallback(valid, { ...stored, expiresAt: Date.now() - 1 }, 1))
      .toEqual({ ok: false, errorCode: 'eventsub_oauth_state_mismatch' });
  });

  it('returns eventsub_config_failed when TWITCH_EVENTSUB_REDIRECT_URI is not configured', () => {
    mockConfig.redirectUri = undefined;
    expect(validateOAuthCallback(valid, stored, 1)).toEqual({ ok: false, errorCode: 'eventsub_config_failed' });
  });
});
