import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../../test-utils/loggerMock';

vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));

vi.mock('../../db', () => ({
  saveBotChatToken: vi.fn(),
}));

vi.mock('../../twitch/eventsub/twitchApiEventSub', () => ({
  exchangeCode: vi.fn(),
  getUserFromToken: vi.fn(),
}));

vi.mock('../../shared/config', () => ({
  TWITCH_BOT_OAUTH_REDIRECT_URI: 'https://example.com/auth/twitch/bot/callback',
}));

import express from 'express';
import supertest from 'supertest';
import router from './botAuthCallback';
import { saveBotChatToken } from '../../db';
import { exchangeCode, getUserFromToken } from '../../twitch/eventsub/twitchApiEventSub';
import { buildTestApp } from '../../test-utils/expressTestApp';

/** Builds a supertest-ready app: the bot-auth-callback router with a valid OAuth-state session, customizable via `sessionOverrides`. */
function buildApp(sessionOverrides: Record<string, any> = {}) {
  return buildTestApp({
    router,
    session: {
      botOAuthState: { value: 'valid-state-abc', expiresAt: Date.now() + 60_000 },
      ...sessionOverrides,
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(exchangeCode).mockResolvedValue({
    access_token: 'access',
    refresh_token: 'refresh',
    expires_in: 3600,
  } as any);
  vi.mocked(getUserFromToken).mockResolvedValue({ login: 'thebot', id: 'bot-uid' } as any);
  vi.mocked(saveBotChatToken).mockResolvedValue(undefined);
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
});

describe('GET /twitch/bot/callback — token exchange', () => {
  it('succeeds and saves the token', async () => {
    const res = await supertest(buildApp())
      .get('/twitch/bot/callback?code=abc&state=valid-state-abc');
    expect(res.headers.location).toContain('success=bot_connected');
    expect(vi.mocked(saveBotChatToken)).toHaveBeenCalledWith('bot-uid', 'access', 'refresh', expect.any(Number));
  });

  it('redirects with token_invalid when the exchanged token does not validate', async () => {
    vi.mocked(getUserFromToken).mockResolvedValue(null);
    const res = await supertest(buildApp())
      .get('/twitch/bot/callback?code=abc&state=valid-state-abc');
    expect(res.headers.location).toContain('error=bot_oauth_token_invalid');
    expect(vi.mocked(saveBotChatToken)).not.toHaveBeenCalled();
  });

  it('redirects with config_failed when exchangeCode throws', async () => {
    vi.mocked(exchangeCode).mockRejectedValue(new Error('boom'));
    const res = await supertest(buildApp())
      .get('/twitch/bot/callback?code=abc&state=valid-state-abc');
    expect(res.headers.location).toContain('error=bot_oauth_config_failed');
  });
});
