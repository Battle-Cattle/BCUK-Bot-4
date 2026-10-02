import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
  getBotChatToken: vi.fn(),
  DEFAULT_REFRESH_FAILURE_BACKOFF_MS: 5_000,
  DEFAULT_REFRESH_FAILURE_MAX_BACKOFF_MS: 60_000,
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { RefreshingAuthProvider } from '@twurple/auth';
import { buildBotAuthProvider, BOT_AUTH_CONNECT_URL, __resetTransientRebuildStateForTests } from './twitchBotAuthProvider';
import { saveBotChatTokenIfOwnedBy, clearBotChatTokenIfOwnedBy, getBotChatToken } from '../db';
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
  vi.useFakeTimers();
  authProviderHandlers.refreshHandlers.length = 0;
  authProviderHandlers.refreshFailureHandlers.length = 0;
  vi.mocked(saveBotChatTokenIfOwnedBy).mockResolvedValue(true);
  vi.mocked(clearBotChatTokenIfOwnedBy).mockResolvedValue(true);
  vi.mocked(getBotChatToken).mockResolvedValue(STORED_BOT_TOKEN as any);
  __resetTransientRebuildStateForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Awaits a refresh-failure handler while also flushing any pending backoff timers it started. */
async function runRefreshFailureHandler(...args: Parameters<Handler>): Promise<void> {
  const result = authProviderHandlers.refreshFailureHandlers[0]!(...args);
  await vi.runAllTimersAsync();
  await result;
}

type Handler = (...args: any[]) => any;

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

      await authProviderHandlers.refreshHandlers[0]!('bot-uid', {
        accessToken: 'new-access', refreshToken: 'new-refresh', expiresIn: 3600, obtainmentTimestamp: Date.now(),
      });

      expect(vi.mocked(saveBotChatTokenIfOwnedBy)).toHaveBeenCalledWith(1, 'new-access', 'new-refresh', expect.any(Number));
    });

    it('does not throw when the write is dropped at the DB level (superseded by a reconnect)', async () => {
      vi.mocked(saveBotChatTokenIfOwnedBy).mockResolvedValue(false);
      buildBotAuthProvider(STORED_BOT_TOKEN as any, vi.fn());

      await expect(authProviderHandlers.refreshHandlers[0]!('bot-uid', {
        accessToken: 'new-access', refreshToken: 'new-refresh', expiresIn: 3600, obtainmentTimestamp: Date.now(),
      })).resolves.toBeUndefined();
    });
  });

  describe('listener error containment (Twurple drops the listener promise, so a rejection would be unhandled)', () => {
    const invalidTokenError = Object.assign(new Error('Encountered HTTP status code 401'), {
      statusCode: 401,
      body: JSON.stringify({ status: 401, message: 'Invalid refresh token' }),
    });

    it('onRefresh resolves (does not reject) when saving the refreshed token fails', async () => {
      vi.mocked(saveBotChatTokenIfOwnedBy).mockRejectedValue(new Error('db down'));
      buildBotAuthProvider(STORED_BOT_TOKEN as any, vi.fn());

      await expect(authProviderHandlers.refreshHandlers[0]!('bot-uid', {
        accessToken: 'new-access', refreshToken: 'new-refresh', expiresIn: 3600, obtainmentTimestamp: Date.now(),
      })).resolves.toBeUndefined();
    });

    it('onRefreshFailure resolves (does not reject) when clearing a revoked token fails', async () => {
      vi.mocked(clearBotChatTokenIfOwnedBy).mockRejectedValue(new Error('db down'));
      const restart = vi.fn();
      buildBotAuthProvider(STORED_BOT_TOKEN as any, restart);

      await expect(authProviderHandlers.refreshFailureHandlers[0]!('bot-uid', invalidTokenError)).resolves.toBeUndefined();
      expect(restart).not.toHaveBeenCalled();
      // The owner is still told to reconnect even though the DB couldn't be cleared.
      expect(vi.mocked(sendOwnerAlert)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(sendOwnerAlert)).toHaveBeenCalledWith(expect.stringContaining(BOT_AUTH_CONNECT_URL));
    });

    it('onRefreshFailure resolves (does not reject) even if raising the owner alert itself throws', async () => {
      vi.mocked(clearBotChatTokenIfOwnedBy).mockRejectedValue(new Error('db down'));
      vi.mocked(sendOwnerAlert).mockImplementationOnce(() => { throw new Error('alert failed'); });
      const restart = vi.fn();
      buildBotAuthProvider(STORED_BOT_TOKEN as any, restart);

      await expect(authProviderHandlers.refreshFailureHandlers[0]!('bot-uid', invalidTokenError)).resolves.toBeUndefined();
      expect(restart).not.toHaveBeenCalled();
    });

    it('onRefreshFailure resolves (does not reject) when the transient rebuild loop hits a DB error', async () => {
      vi.mocked(getBotChatToken).mockRejectedValue(new Error('db down'));
      const restart = vi.fn();
      buildBotAuthProvider(STORED_BOT_TOKEN as any, restart);

      await expect(runRefreshFailureHandler('bot-uid', new Error('network blip'))).resolves.toBeUndefined();
      expect(restart).not.toHaveBeenCalled();
      // Every attempt's lookup failed, so the owner is told recovery stopped.
      expect(vi.mocked(sendOwnerAlert)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(sendOwnerAlert)).toHaveBeenCalledWith(expect.stringContaining(BOT_AUTH_CONNECT_URL));
    });

    it('keeps retrying after a failed token lookup and rebuilds once the DB recovers', async () => {
      vi.mocked(getBotChatToken)
        .mockRejectedValueOnce(new Error('db down'))
        .mockResolvedValue(STORED_BOT_TOKEN as any);
      const restart = vi.fn().mockResolvedValue(undefined);
      buildBotAuthProvider(STORED_BOT_TOKEN as any, restart);

      await runRefreshFailureHandler('bot-uid', new Error('network blip'));
      expect(getBotChatToken).toHaveBeenCalledTimes(2);
      expect(restart).toHaveBeenCalledTimes(1);
      expect(vi.mocked(sendOwnerAlert)).not.toHaveBeenCalled();
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

      await authProviderHandlers.refreshFailureHandlers[0]!('bot-uid', invalidTokenError);

      expect(vi.mocked(clearBotChatTokenIfOwnedBy)).toHaveBeenCalledWith(1);
      expect(restart).toHaveBeenCalled();
      expect(vi.mocked(sendOwnerAlert)).toHaveBeenCalledWith(expect.stringContaining(BOT_AUTH_CONNECT_URL));
    });

    it('does not restart or alert when the clear is declined (a reconnect replaced this connection first)', async () => {
      vi.mocked(clearBotChatTokenIfOwnedBy).mockResolvedValue(false);
      const restart = vi.fn();
      buildBotAuthProvider(STORED_BOT_TOKEN as any, restart);

      await authProviderHandlers.refreshFailureHandlers[0]!('bot-uid', invalidTokenError);

      expect(restart).not.toHaveBeenCalled();
      expect(vi.mocked(sendOwnerAlert)).not.toHaveBeenCalled();
    });

    it('still alerts the owner even if the restart itself fails', async () => {
      const restart = vi.fn().mockRejectedValue(new Error('reconnect failed'));
      buildBotAuthProvider(STORED_BOT_TOKEN as any, restart);

      await expect(authProviderHandlers.refreshFailureHandlers[0]!('bot-uid', invalidTokenError)).resolves.toBeUndefined();

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

      await runRefreshFailureHandler('bot-uid', transientError);

      expect(vi.mocked(clearBotChatTokenIfOwnedBy)).not.toHaveBeenCalled();
      expect(restart).toHaveBeenCalled();
    });

    it('does not alert the owner when the rebuild succeeds on the first attempt', async () => {
      const restart = vi.fn().mockResolvedValue(undefined);
      buildBotAuthProvider(STORED_BOT_TOKEN as any, restart);

      await runRefreshFailureHandler('bot-uid', transientError);

      expect(vi.mocked(sendOwnerAlert)).not.toHaveBeenCalled();
    });

    it('retries with backoff and does not alert if a later attempt succeeds — this is the single call that owns the whole bounded loop, not one attempt per onRefreshFailure invocation (see the doc on rebuildAfterTransientRefreshFailure for why it cannot rely on being re-invoked)', async () => {
      const restart = vi.fn()
        .mockRejectedValueOnce(new Error('reconnect failed'))
        .mockRejectedValueOnce(new Error('reconnect failed'))
        .mockResolvedValueOnce(undefined);
      buildBotAuthProvider(STORED_BOT_TOKEN as any, restart);

      await runRefreshFailureHandler('bot-uid', transientError);

      expect(restart).toHaveBeenCalledTimes(3);
      expect(vi.mocked(sendOwnerAlert)).not.toHaveBeenCalled();
    });

    it('gives up and alerts the owner exactly once after exhausting the retry budget within a single call', async () => {
      const restart = vi.fn().mockRejectedValue(new Error('reconnect failed'));
      buildBotAuthProvider(STORED_BOT_TOKEN as any, restart);

      await runRefreshFailureHandler('bot-uid', transientError);

      expect(restart).toHaveBeenCalledTimes(5);
      expect(vi.mocked(sendOwnerAlert)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(sendOwnerAlert)).toHaveBeenCalledWith(expect.stringContaining(BOT_AUTH_CONNECT_URL));
    });

    it('abandons the rebuild without restarting if a newer connection has since been saved', async () => {
      const restart = vi.fn().mockResolvedValue(undefined);
      buildBotAuthProvider(STORED_BOT_TOKEN as any, restart);
      vi.mocked(getBotChatToken).mockResolvedValue({ ...STORED_BOT_TOKEN, connectionId: 2 } as any);

      await runRefreshFailureHandler('bot-uid', transientError);

      expect(restart).not.toHaveBeenCalled();
      expect(vi.mocked(sendOwnerAlert)).not.toHaveBeenCalled();
    });

    it('does not start a second competing retry loop if onRefreshFailure fires again for the same connection while one is already in flight', async () => {
      // Simulates the real recursive trigger this guards against: restart() builds a new provider
      // from the same still-bad stored token, and that provider's own first token fetch can
      // re-emit onRefreshFailure for the same connectionId before the original loop has finished.
      let resolveRestart!: () => void;
      const restart = vi.fn(() => new Promise<void>((resolve) => { resolveRestart = resolve; }));
      buildBotAuthProvider(STORED_BOT_TOKEN as any, restart);

      const first = authProviderHandlers.refreshFailureHandlers[0]!('bot-uid', transientError);
      const second = authProviderHandlers.refreshFailureHandlers[0]!('bot-uid', transientError);
      // Flush the microtasks between `first`'s synchronous in-flight guard check and its `await
      // restart()` call (it awaits `getBotChatToken()` first), so `restart` has actually been
      // invoked — and `resolveRestart` assigned — before we resolve it.
      for (let i = 0; i < 10; i++) await Promise.resolve();
      resolveRestart();
      await vi.runAllTimersAsync();
      await Promise.all([first, second]);

      expect(restart).toHaveBeenCalledTimes(1);
    });
  });
});
