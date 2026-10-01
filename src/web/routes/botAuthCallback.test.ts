import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../../test-utils/loggerMock';

vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));

vi.mock('../../db', () => ({
  getBotChatToken: vi.fn(),
  saveBotChatTokenIfLatestAttempt: vi.fn(),
  restoreBotChatTokenIfOwnedByConnection: vi.fn(),
}));

vi.mock('../../twitch/eventsub/twitchApiEventSub', () => ({
  exchangeCode: vi.fn(),
  getUserFromToken: vi.fn(),
}));

vi.mock('../../twitch/twitchBot', () => ({
  restartTwitchBot: vi.fn(),
}));

// Mutable so a test can simulate a missing redirect URI.
let mockRedirectUri: string | undefined = 'https://example.com/auth/twitch/bot/callback';
vi.mock('../../shared/config', () => ({
  get TWITCH_BOT_OAUTH_REDIRECT_URI() { return mockRedirectUri; },
}));

import express from 'express';
import supertest from 'supertest';
import router from './botAuthCallback';
import { getBotChatToken, saveBotChatTokenIfLatestAttempt, restoreBotChatTokenIfOwnedByConnection } from '../../db';
import { exchangeCode, getUserFromToken } from '../../twitch/eventsub/twitchApiEventSub';
import { restartTwitchBot } from '../../twitch/twitchBot';
import { buildTestApp } from '../../test-utils/expressTestApp';

/** The `attemptStartedAt` used by the default session's `botOAuthState` in {@link buildApp}. */
const ATTEMPT_STARTED_AT = 1_000;
/** The `connection_id` {@link saveBotChatTokenIfLatestAttempt} resolves to by default (a win). */
const NEW_CONNECTION_ID = 2;

/** Builds a supertest-ready app: the bot-auth-callback router with a valid OAuth-state session, customizable via `sessionOverrides`. */
function buildApp(sessionOverrides: Record<string, any> = {}) {
  return buildTestApp({
    router,
    session: {
      botOAuthState: { value: 'valid-state-abc', expiresAt: Date.now() + 60_000, attemptStartedAt: ATTEMPT_STARTED_AT },
      ...sessionOverrides,
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRedirectUri = 'https://example.com/auth/twitch/bot/callback';
  vi.mocked(exchangeCode).mockResolvedValue({
    access_token: 'access',
    refresh_token: 'refresh',
    expires_in: 3600,
  } as any);
  vi.mocked(getUserFromToken).mockResolvedValue({ login: 'thebot', id: 'bot-uid' } as any);
  // No previous connection by default — tests exercising the rollback path override this.
  vi.mocked(getBotChatToken).mockResolvedValue(null);
  vi.mocked(saveBotChatTokenIfLatestAttempt).mockResolvedValue(NEW_CONNECTION_ID);
  vi.mocked(restoreBotChatTokenIfOwnedByConnection).mockResolvedValue(true);
  vi.mocked(restartTwitchBot).mockResolvedValue(undefined);
});

describe('GET /twitch/bot/callback — state validation', () => {
  it('rejects with state_mismatch when state param does not match session', async () => {
    const res = await supertest(buildApp())
      .get('/twitch/bot/callback?code=abc&state=wrong-state');
    expect(res.headers.location).toContain('error=bot_oauth_state_mismatch');
  });

  it('rejects with state_mismatch when session has no state', async () => {
    const res = await supertest(buildApp({ botOAuthState: undefined }))
      .get('/twitch/bot/callback?code=abc&state=valid-state-abc');
    expect(res.headers.location).toContain('error=bot_oauth_state_mismatch');
  });

  it('redirects with denied error when OAuth returns error param and clears session state', async () => {
    let capturedSession: any;
    const app = express();
    app.use((req: any, _res: any, next: any) => {
      req.session = { botOAuthState: { value: 'valid-state-abc', expiresAt: Date.now() + 60_000 } };
      capturedSession = req.session;
      next();
    });
    app.use(router);
    const res = await supertest(app).get('/twitch/bot/callback?error=access_denied');
    expect(res.headers.location).toContain('error=bot_oauth_denied');
    expect(capturedSession.botOAuthState).toBeUndefined();
  });

  it('rejects with state_mismatch when OAuth state has expired', async () => {
    const res = await supertest(buildApp({ botOAuthState: { value: 'valid-state-abc', expiresAt: Date.now() - 1 } }))
      .get('/twitch/bot/callback?code=abc&state=valid-state-abc');
    expect(res.headers.location).toContain('error=bot_oauth_state_mismatch');
  });

  it('redirects with config_failed when TWITCH_BOT_OAUTH_REDIRECT_URI is not configured', async () => {
    mockRedirectUri = '';
    const res = await supertest(buildApp())
      .get('/twitch/bot/callback?code=abc&state=valid-state-abc');
    expect(res.headers.location).toBe('/admin/bot-auth?error=bot_oauth_config_failed');
    expect(vi.mocked(exchangeCode)).not.toHaveBeenCalled();
  });
});

describe('GET /twitch/bot/callback — token exchange', () => {
  it('succeeds, saves the token, and restarts the chat client', async () => {
    const res = await supertest(buildApp())
      .get('/twitch/bot/callback?code=abc&state=valid-state-abc');
    expect(res.headers.location).toContain('success=bot_connected');
    expect(vi.mocked(saveBotChatTokenIfLatestAttempt)).toHaveBeenCalledWith(ATTEMPT_STARTED_AT, 'bot-uid', 'access', 'refresh', expect.any(Number));
    expect(vi.mocked(restartTwitchBot)).toHaveBeenCalled();
  });

  it('saves the new token before restarting the chat client (so a save failure never takes down a working bot)', async () => {
    const callOrder: string[] = [];
    vi.mocked(saveBotChatTokenIfLatestAttempt).mockImplementation(async () => { callOrder.push('save'); return NEW_CONNECTION_ID; });
    vi.mocked(restartTwitchBot).mockImplementation(async () => { callOrder.push('restart'); });

    await supertest(buildApp()).get('/twitch/bot/callback?code=abc&state=valid-state-abc');

    expect(callOrder).toEqual(['save', 'restart']);
  });

  it('does not restart the chat client when saving the token fails', async () => {
    vi.mocked(saveBotChatTokenIfLatestAttempt).mockRejectedValue(new Error('db boom'));
    const res = await supertest(buildApp())
      .get('/twitch/bot/callback?code=abc&state=valid-state-abc');
    expect(res.headers.location).toContain('error=bot_oauth_config_failed');
    expect(vi.mocked(restartTwitchBot)).not.toHaveBeenCalled();
  });

  it('redirects with superseded (not a plain error) when a more recently started attempt already won the row', async () => {
    vi.mocked(saveBotChatTokenIfLatestAttempt).mockResolvedValue(null);
    const res = await supertest(buildApp())
      .get('/twitch/bot/callback?code=abc&state=valid-state-abc');
    expect(res.headers.location).toBe('/admin/bot-auth?error=bot_oauth_superseded');
    expect(vi.mocked(restartTwitchBot)).not.toHaveBeenCalled();
  });

  it('redirects with a chat_start_failed warning if restarting fails and there is no previous connection to restore', async () => {
    vi.mocked(getBotChatToken).mockResolvedValue(null);
    vi.mocked(restartTwitchBot).mockRejectedValue(new Error('connect failed'));
    const res = await supertest(buildApp())
      .get('/twitch/bot/callback?code=abc&state=valid-state-abc');
    expect(res.headers.location).toBe('/admin/bot-auth?success=bot_connected&warning=chat_start_failed');
    // The token is still saved even though chat failed to start.
    expect(vi.mocked(saveBotChatTokenIfLatestAttempt)).toHaveBeenCalled();
    expect(vi.mocked(restoreBotChatTokenIfOwnedByConnection)).not.toHaveBeenCalled();
  });

  it('restores the previous connection and redirects with connect_failed when restarting the new account fails', async () => {
    const previous = {
      twitchUserId: 'old-uid', accessToken: 'old-access', refreshToken: 'old-refresh', tokenExpiry: null, connectionId: 1,
    };
    vi.mocked(getBotChatToken).mockResolvedValue(previous as any);
    vi.mocked(restartTwitchBot).mockRejectedValueOnce(new Error('connect failed')).mockResolvedValueOnce(undefined);
    vi.mocked(restoreBotChatTokenIfOwnedByConnection).mockResolvedValue(true);

    const res = await supertest(buildApp())
      .get('/twitch/bot/callback?code=abc&state=valid-state-abc');

    expect(res.headers.location).toBe('/admin/bot-auth?error=bot_oauth_connect_failed');
    // Restored via connection_id ownership (not attempt ordering), so a legitimately newer
    // still-in-flight connect attempt can never be clobbered by this rollback.
    expect(vi.mocked(restoreBotChatTokenIfOwnedByConnection)).toHaveBeenCalledWith(
      NEW_CONNECTION_ID, 'old-uid', 'old-access', 'old-refresh', null,
    );
    expect(vi.mocked(restartTwitchBot)).toHaveBeenCalledTimes(2);
  });

  it('falls back to the chat_start_failed warning when restoring the previous connection also fails', async () => {
    const previous = {
      twitchUserId: 'old-uid', accessToken: 'old-access', refreshToken: 'old-refresh', tokenExpiry: null, connectionId: 1,
    };
    vi.mocked(getBotChatToken).mockResolvedValue(previous as any);
    vi.mocked(restartTwitchBot).mockRejectedValue(new Error('connect failed'));
    vi.mocked(restoreBotChatTokenIfOwnedByConnection).mockResolvedValue(true);

    const res = await supertest(buildApp())
      .get('/twitch/bot/callback?code=abc&state=valid-state-abc');

    expect(res.headers.location).toBe('/admin/bot-auth?success=bot_connected&warning=chat_start_failed');
  });

  it('does not attempt a second restart when the rollback save itself is declined (a newer connect attempt already took over)', async () => {
    const previous = {
      twitchUserId: 'old-uid', accessToken: 'old-access', refreshToken: 'old-refresh', tokenExpiry: null, connectionId: 1,
    };
    vi.mocked(getBotChatToken).mockResolvedValue(previous as any);
    vi.mocked(restartTwitchBot).mockRejectedValue(new Error('connect failed'));
    vi.mocked(restoreBotChatTokenIfOwnedByConnection).mockResolvedValue(false);

    const res = await supertest(buildApp())
      .get('/twitch/bot/callback?code=abc&state=valid-state-abc');

    expect(res.headers.location).toBe('/admin/bot-auth?success=bot_connected&warning=chat_start_failed');
    expect(vi.mocked(restartTwitchBot)).toHaveBeenCalledTimes(1);
  });

  it('redirects with token_invalid when the exchanged token does not validate', async () => {
    vi.mocked(getUserFromToken).mockResolvedValue(null);
    const res = await supertest(buildApp())
      .get('/twitch/bot/callback?code=abc&state=valid-state-abc');
    expect(res.headers.location).toContain('error=bot_oauth_token_invalid');
    expect(vi.mocked(saveBotChatTokenIfLatestAttempt)).not.toHaveBeenCalled();
  });

  it('redirects with config_failed when exchangeCode throws', async () => {
    vi.mocked(exchangeCode).mockRejectedValue(new Error('boom'));
    const res = await supertest(buildApp())
      .get('/twitch/bot/callback?code=abc&state=valid-state-abc');
    expect(res.headers.location).toContain('error=bot_oauth_config_failed');
  });
});
