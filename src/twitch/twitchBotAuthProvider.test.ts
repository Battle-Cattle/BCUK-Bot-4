import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../test-utils/loggerMock';

// ─── Hoisted state (available inside vi.mock factories) ───────────────────────

const { mockAuthProvider, authProviderHandlers } = vi.hoisted(() => {
  type Handler = (...args: any[]) => any;

  const refreshHandlers: Handler[] = [];
  const refreshFailureHandlers: Handler[] = [];
  const authProvider = {
    addUser: vi.fn(),
    onRefresh: vi.fn((cb: Handler) => { refreshHandlers.push(cb); }),
    onRefreshFailure: vi.fn((cb: Handler) => { refreshFailureHandlers.push(cb); }),
  };

  return {
    mockAuthProvider: authProvider,
    authProviderHandlers: { refreshHandlers, refreshFailureHandlers },
  };
});

// ─── Module mocks (must precede imports) ─────────────────────────────────────

vi.mock('@twurple/auth', () => ({
  RefreshingAuthProvider: vi.fn(function MockRefreshingAuthProvider() { return mockAuthProvider; }),
}));

vi.mock('../shared/logger', () => ({ createLogger: mockLogger }));

vi.mock('../shared/config', () => ({
  TWITCH_CLIENT_ID: 'test-client-id',
  TWITCH_CLIENT_SECRET: 'test-client-secret',
  PUBLIC_URL: 'https://example.com',
}));

vi.mock('../discord/ownerAlerts', () => ({
  sendOwnerAlert: vi.fn(),
}));

vi.mock('../db', () => ({
  saveBotChatTokenIfOwnedBy: vi.fn(),
  clearBotChatTokenIfOwnedBy: vi.fn(),
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { RefreshingAuthProvider } from '@twurple/auth';
import { buildBotAuthProvider, BOT_AUTH_CONNECT_URL } from './twitchBotAuthProvider';
import { saveBotChatTokenIfOwnedBy, clearBotChatTokenIfOwnedBy } from '../db';
import { sendOwnerAlert } from '../discord/ownerAlerts';

const STORED_BOT_TOKEN = {
  twitchUserId: 'bot-uid',
  accessToken: 'stored-access-token',
  refreshToken: 'stored-refresh-token',
  tokenExpiry: null,
  connectionId: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  authProviderHandlers.refreshHandlers.length = 0;
  authProviderHandlers.refreshFailureHandlers.length = 0;
  vi.mocked(saveBotChatTokenIfOwnedBy).mockResolvedValue(true);
  vi.mocked(clearBotChatTokenIfOwnedBy).mockResolvedValue(true);
});

describe('buildBotAuthProvider', () => {
  it('constructs a RefreshingAuthProvider with the configured client credentials', () => {
    buildBotAuthProvider(STORED_BOT_TOKEN as any, vi.fn());
    expect(vi.mocked(RefreshingAuthProvider)).toHaveBeenCalledWith({ clientId: 'test-client-id', clientSecret: 'test-client-secret' });
  });

  it('adds the stored token under the chat intent', () => {
    buildBotAuthProvider(STORED_BOT_TOKEN as any, vi.fn());
    expect(mockAuthProvider.addUser).toHaveBeenCalledWith(
      'bot-uid',
      expect.objectContaining({ accessToken: 'stored-access-token', refreshToken: 'stored-refresh-token' }),
      ['chat'],
    );
  });

  describe('onRefresh', () => {
    it('persists a refreshed token, scoped to the connection it was built for', async () => {
      buildBotAuthProvider(STORED_BOT_TOKEN as any, vi.fn());

      await authProviderHandlers.refreshHandlers[0]('bot-uid', {
        accessToken: 'new-access', refreshToken: 'new-refresh', expiresIn: 3600, obtainmentTimestamp: Date.now(),
      });

      expect(vi.mocked(saveBotChatTokenIfOwnedBy)).toHaveBeenCalledWith(1, 'new-access', 'new-refresh', expect.any(Number));
    });

    it('does not throw when the write is dropped at the DB level (superseded by a reconnect)', async () => {
      vi.mocked(saveBotChatTokenIfOwnedBy).mockResolvedValue(false);
      buildBotAuthProvider(STORED_BOT_TOKEN as any, vi.fn());

      await expect(authProviderHandlers.refreshHandlers[0]('bot-uid', {
        accessToken: 'new-access', refreshToken: 'new-refresh', expiresIn: 3600, obtainmentTimestamp: Date.now(),
      })).resolves.toBeUndefined();
    });
  });

  describe('onRefreshFailure — confirmed invalid/revoked refresh token', () => {
    const invalidTokenError = Object.assign(new Error('Encountered HTTP status code 401'), {
      statusCode: 401,
      body: JSON.stringify({ status: 401, message: 'Invalid refresh token' }),
    });

    it('clears the stored token, restarts, and alerts the owner', async () => {
      const restart = vi.fn().mockResolvedValue(undefined);
      buildBotAuthProvider(STORED_BOT_TOKEN as any, restart);

      await authProviderHandlers.refreshFailureHandlers[0]('bot-uid', invalidTokenError);

      expect(vi.mocked(clearBotChatTokenIfOwnedBy)).toHaveBeenCalledWith(1);
      expect(restart).toHaveBeenCalled();
      expect(vi.mocked(sendOwnerAlert)).toHaveBeenCalledWith(expect.stringContaining(BOT_AUTH_CONNECT_URL));
    });

    it('does not restart or alert when the clear is declined (a reconnect replaced this connection first)', async () => {
      vi.mocked(clearBotChatTokenIfOwnedBy).mockResolvedValue(false);
      const restart = vi.fn();
      buildBotAuthProvider(STORED_BOT_TOKEN as any, restart);

      await authProviderHandlers.refreshFailureHandlers[0]('bot-uid', invalidTokenError);

      expect(restart).not.toHaveBeenCalled();
      expect(vi.mocked(sendOwnerAlert)).not.toHaveBeenCalled();
    });

    it('still alerts the owner even if the restart itself fails', async () => {
      const restart = vi.fn().mockRejectedValue(new Error('reconnect failed'));
      buildBotAuthProvider(STORED_BOT_TOKEN as any, restart);

      await expect(authProviderHandlers.refreshFailureHandlers[0]('bot-uid', invalidTokenError)).resolves.toBeUndefined();

      expect(vi.mocked(sendOwnerAlert)).toHaveBeenCalledWith(expect.stringContaining(BOT_AUTH_CONNECT_URL));
    });
  });

  describe('onRefreshFailure — transient failure', () => {
    const transientError = Object.assign(new Error('Encountered HTTP status code 503'), {
      statusCode: 503,
      body: JSON.stringify({ status: 503, message: 'Internal server error' }),
    });

    it('rebuilds the connection without touching the stored token', async () => {
      const restart = vi.fn().mockResolvedValue(undefined);
      buildBotAuthProvider(STORED_BOT_TOKEN as any, restart);

      await authProviderHandlers.refreshFailureHandlers[0]('bot-uid', transientError);

      expect(vi.mocked(clearBotChatTokenIfOwnedBy)).not.toHaveBeenCalled();
      expect(restart).toHaveBeenCalled();
    });

    it('does not alert the owner when the rebuild succeeds', async () => {
      const restart = vi.fn().mockResolvedValue(undefined);
      buildBotAuthProvider(STORED_BOT_TOKEN as any, restart);

      await authProviderHandlers.refreshFailureHandlers[0]('bot-uid', transientError);

      expect(vi.mocked(sendOwnerAlert)).not.toHaveBeenCalled();
    });

    it('alerts the owner when the rebuild itself fails to reconnect', async () => {
      const restart = vi.fn().mockRejectedValue(new Error('reconnect failed'));
      buildBotAuthProvider(STORED_BOT_TOKEN as any, restart);

      await expect(authProviderHandlers.refreshFailureHandlers[0]('bot-uid', transientError)).resolves.toBeUndefined();

      expect(vi.mocked(sendOwnerAlert)).toHaveBeenCalledWith(expect.stringContaining(BOT_AUTH_CONNECT_URL));
    });
  });
});
