import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockLogger } from '../test-utils/loggerMock';

// ─── Hoisted state (available inside vi.mock factories) ───────────────────────

const { mockClient, handlers, mockAuthProvider, authProviderHandlers } = vi.hoisted(() => {
  type Handler = (...args: any[]) => any;

  /** Builds a mock Twurple `onX`-style event binder that records handlers into `list`, mirroring the real `client.onX(handler) => Listener` shape (including `.unbind()`). */
  function makeBinder(list: Handler[]) {
    return vi.fn((handler: Handler) => {
      list.push(handler);
      return { unbind: () => { const i = list.indexOf(handler); if (i !== -1) list.splice(i, 1); } };
    });
  }

  const messageHandlers: Handler[] = [];
  const authSuccessHandlers: Handler[] = [];
  const disconnectHandlers: Handler[] = [];
  const authenticationFailureHandlers: Handler[] = [];
  const tokenFetchFailureHandlers: Handler[] = [];
  const userStateHandlers: Handler[] = [];

  const client = {
    onMessage: makeBinder(messageHandlers),
    onAuthenticationSuccess: makeBinder(authSuccessHandlers),
    onDisconnect: makeBinder(disconnectHandlers),
    onAuthenticationFailure: makeBinder(authenticationFailureHandlers),
    onTokenFetchFailure: makeBinder(tokenFetchFailureHandlers),
    connect: vi.fn(),
    quit: vi.fn(),
    join: vi.fn(),
    part: vi.fn(),
    currentChannels: [] as string[],
    irc: {
      onTypedMessage: vi.fn((_type: unknown, handler: Handler) => {
        userStateHandlers.push(handler);
        return 'mock-handler-id';
      }),
      removeMessageListener: vi.fn((_handlerId: string) => {
        userStateHandlers.length = 0;
      }),
      say: vi.fn(),
    },
  };

  // Mock RefreshingAuthProvider (replaces StaticAuthProvider — see #550): records its
  // onRefresh/onRefreshFailure callbacks so tests can fire them directly, like the client's
  // own event handlers above.
  const refreshHandlers: Handler[] = [];
  const refreshFailureHandlers: Handler[] = [];
  const authProvider = {
    addUser: vi.fn(),
    onRefresh: vi.fn((cb: Handler) => { refreshHandlers.push(cb); }),
    onRefreshFailure: vi.fn((cb: Handler) => { refreshFailureHandlers.push(cb); }),
  };

  return {
    mockClient: client,
    handlers: {
      messageHandlers,
      authSuccessHandlers,
      disconnectHandlers,
      authenticationFailureHandlers,
      tokenFetchFailureHandlers,
      userStateHandlers,
    },
    mockAuthProvider: authProvider,
    authProviderHandlers: { refreshHandlers, refreshFailureHandlers },
  };
});

// ─── Module mocks (must precede imports) ─────────────────────────────────────

// Must use a regular function (not an arrow) so `new ChatClient()` works.
vi.mock('@twurple/chat', () => ({
  ChatClient: vi.fn(function MockChatClient() { return mockClient; }),
  UserState: class MockUserState {},
}));

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

// Uses the real createManagedLookupCache (not a fake) so tests below can
// exercise its actual TTL / stale-while-revalidate behaviour.
vi.mock('../db', async () => {
  const { createManagedLookupCache, DEFAULT_REFRESH_FAILURE_BACKOFF_MS, DEFAULT_REFRESH_FAILURE_MAX_BACKOFF_MS } =
    await vi.importActual<typeof import('../db/lookupCache')>('../db/lookupCache');
  return {
    getTwitchEnabledChannels: vi.fn(),
    getAllTwitchLinkedUsers: vi.fn(),
    findUserByTwitchName: vi.fn(),
    getBotChatToken: vi.fn(),
    saveBotChatTokenIfOwnedBy: vi.fn(),
    clearBotChatTokenIfOwnedBy: vi.fn(),
    createManagedLookupCache,
    DEFAULT_REFRESH_FAILURE_BACKOFF_MS,
    DEFAULT_REFRESH_FAILURE_MAX_BACKOFF_MS,
  };
});

vi.mock('./twitchGuildResolutionRuntime', () => ({
  resolveGuildIdForDiscordId: vi.fn(),
}));

vi.mock('./twitchApi', () => ({
  getUsers: vi.fn(),
}));

vi.mock('../shared/statusStore', () => ({
  setTwitchChannel: vi.fn(),
}));

vi.mock('../shared/healthStore', () => ({
  recordTwitchChatConnected: vi.fn(),
}));

vi.mock('../commands/commandRouter', () => ({
  handleCommand: vi.fn(),
}));

vi.mock('../commands/customCommandHandler', () => ({
  executeCustomCommandForTwitch: vi.fn(),
}));

vi.mock('../commands/counterHandler', () => ({
  executeCounterCommandForTwitch: vi.fn(),
}));

vi.mock('../commands/multiCommandHandler', () => ({
  executeMultiCommandForTwitch: vi.fn(),
}));

vi.mock('../commands/shoutoutHandler', () => ({
  executeShoutoutForTwitch: vi.fn(),
}));

vi.mock('../commands/countdownHandler', () => ({
  executeCountdownForTwitch: vi.fn(),
}));

vi.mock('../commands/followageHandler', () => ({
  executeFollowageForTwitch: vi.fn(),
}));

vi.mock('./twitchChatActivity', () => ({
  recordChatMessage: vi.fn(),
  forgetChannelChatActivity: vi.fn(),
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import {
  startTwitchBot,
  stopTwitchBot,
  restartTwitchBot,
  sayInChannel,
  __resetTwitchChannelDiscordIdCacheForTests,
  CONNECT_TIMEOUT_MS,
  DISCONNECT_TIMEOUT_MS,
} from './twitchBot';
import { __resetTwitchPrivilegedChannelsForTests } from './twitchChannelPrivilege';
import { __resetTwitchSendQueueForTests } from './twitchSendQueue';
import {
  joinTwitchChannel,
  getActiveChannels,
  getActiveChannelUserIds,
  __setConfirmedJoinedChannelsForTests,
} from './twitchChannelMembership';
import * as twitchChannelMembership from './twitchChannelMembership';
import { getTwitchEnabledChannels, getAllTwitchLinkedUsers, findUserByTwitchName, getBotChatToken, saveBotChatTokenIfOwnedBy, clearBotChatTokenIfOwnedBy } from '../db';
import { __resetTransientRebuildStateForTests } from './twitchBotAuthProvider';
import { sendOwnerAlert } from '../discord/ownerAlerts';
import { resolveGuildIdForDiscordId } from './twitchGuildResolutionRuntime';
import { getUsers } from './twitchApi';
import { setTwitchChannel } from '../shared/statusStore';
import { recordTwitchChatConnected } from '../shared/healthStore';
import { executeCustomCommandForTwitch } from '../commands/customCommandHandler';
import { executeCounterCommandForTwitch } from '../commands/counterHandler';
import { executeMultiCommandForTwitch } from '../commands/multiCommandHandler';
import { executeShoutoutForTwitch } from '../commands/shoutoutHandler';
import { handleCommand } from '../commands/commandRouter';
import { executeCountdownForTwitch } from '../commands/countdownHandler';
import { executeFollowageForTwitch } from '../commands/followageHandler';
import { recordChatMessage } from './twitchChatActivity';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resetMockClient(): void {
  // Re-apply default implementations after vi.clearAllMocks() wipes call history
  // but preserves implementations — some tests override join/part/etc., so we
  // explicitly restore defaults here each time.
  mockClient.connect.mockImplementation(() => {
    queueMicrotask(() => fireAuthSuccess());
  });
  mockClient.quit.mockImplementation(() => {
    queueMicrotask(() => fireDisconnect(true));
  });
  mockClient.join.mockResolvedValue(undefined);
  mockClient.part.mockImplementation(() => undefined);
  mockClient.irc.say.mockImplementation(() => undefined);
  mockClient.currentChannels = [];
}

/**
 * Clears every registered event handler. Only safe to call before a client is (re-)started in
 * the current test — calling it after `startTwitchBot()` would also drop the real, persistent
 * `handleTwitchMessage`/`onConnected`/`onDisconnected`/`onOwnUserState` listeners it registered.
 */
function clearHandlerArrays(): void {
  handlers.messageHandlers.length = 0;
  handlers.authSuccessHandlers.length = 0;
  handlers.disconnectHandlers.length = 0;
  handlers.authenticationFailureHandlers.length = 0;
  handlers.tokenFetchFailureHandlers.length = 0;
  handlers.userStateHandlers.length = 0;
}

/** Fires every currently-registered `onAuthenticationSuccess` handler, simulating a successful chat login. */
function fireAuthSuccess(): void {
  handlers.authSuccessHandlers.slice().forEach((h) => h());
}

/** Fires every currently-registered `onDisconnect` handler, simulating the chat server disconnecting. */
function fireDisconnect(manually = false, reason?: Error): void {
  handlers.disconnectHandlers.slice().forEach((h) => h(manually, reason));
}

/** Start the bot with an empty channel list and let the mocked `connect()` simulate a successful connection. */
async function connectBot(): Promise<void> {
  vi.mocked(getTwitchEnabledChannels).mockResolvedValue([]);
  vi.mocked(getUsers).mockResolvedValue([]);
  await startTwitchBot();
}

/** Builds a minimal fake Twurple `ChatMessage` with the given userInfo/shared-chat overrides. */
function makeChatMessage(overrides: {
  isMod?: boolean;
  isVip?: boolean;
  isBroadcaster?: boolean;
  displayName?: string;
  userId?: string;
  channelId?: string | null;
  sourceChannelId?: string | null;
} = {}): any {
  return {
    userInfo: {
      isMod: overrides.isMod ?? false,
      isVip: overrides.isVip ?? false,
      isBroadcaster: overrides.isBroadcaster ?? false,
      displayName: overrides.displayName,
      userId: overrides.userId ?? 'user-id',
    },
    channelId: overrides.channelId ?? null,
    sourceChannelId: overrides.sourceChannelId ?? null,
  };
}

/**
 * Dispatches a chat message to every registered `onMessage` handler, as Twurple would — including
 * stripping any leading `#` from `channel` first, since Twurple's `ChatClient` emits `onMessage`
 * with `toUserName(channel)` (the plain login, no `#`), unlike the raw `#channel` form `USERSTATE`
 * carries (see {@link fireUserState}).
 */
function sendMessage(
  channel: string,
  user: string,
  message: string,
  msgOverrides: Parameters<typeof makeChatMessage>[0] = {},
): void {
  const normalizedChannel = channel.replace(/^#/, '');
  handlers.messageHandlers.slice().forEach((h) => h(normalizedChannel, user, message, makeChatMessage(msgOverrides)));
}

/**
 * Dispatches a raw `USERSTATE` message to every registered handler, as the underlying ircv3 client
 * would after the bot joins `channel` or sends a message there.
 * @param channel - Channel the USERSTATE was received for (as `#channel`).
 * @param rawBadges - Raw IRC `badges` tag value (e.g. `"moderator/1"`), or omitted for no badges.
 */
function fireUserState(channel: string, rawBadges?: string): void {
  const msg = { channel, tags: new Map(rawBadges ? [['badges', rawBadges]] : []) };
  handlers.userStateHandlers.slice().forEach((h) => h(msg));
}

/** A valid stored bot chat token — the default `getBotChatToken` resolves to, so existing tests keep exercising a bot that actually connects (see `startTwitchBot` describe block below for the "no token" cases). */
const STORED_BOT_TOKEN = {
  twitchUserId: 'bot-uid',
  accessToken: 'stored-access-token',
  refreshToken: 'stored-refresh-token',
  tokenExpiry: null,
  connectionId: 1,
};

// ─── Lifecycle ────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  resetMockClient();
  clearHandlerArrays();
  authProviderHandlers.refreshHandlers.length = 0;
  authProviderHandlers.refreshFailureHandlers.length = 0;
  twitchChannelMembership.setChatClient(null);
  twitchChannelMembership.setConnected(false);
  vi.useFakeTimers();
  __resetTwitchSendQueueForTests();
  __resetTwitchPrivilegedChannelsForTests();
  vi.mocked(getBotChatToken).mockResolvedValue(STORED_BOT_TOKEN as any);
  vi.mocked(saveBotChatTokenIfOwnedBy).mockResolvedValue(true);
  vi.mocked(clearBotChatTokenIfOwnedBy).mockResolvedValue(true);
  __resetTransientRebuildStateForTests();
});

afterEach(async () => {
  await stopTwitchBot();
  vi.useRealTimers();
});

// ─── handleTwitchMessage ─────────────────────────────────────────────────────

describe('handleTwitchMessage', () => {
  beforeEach(async () => {
    await connectBot();
    vi.mocked(getUsers).mockResolvedValue([]);
    await joinTwitchChannel('streamer');
    // Reset call history so only message-dispatch calls are visible to assertions. Note:
    // resetMockClient() only restores default mock implementations, it doesn't touch the
    // handler arrays — handleTwitchMessage/onConnected/onDisconnected stay registered from
    // the startTwitchBot() call in connectBot() above.
    vi.clearAllMocks();
    resetMockClient();
    vi.mocked(getAllTwitchLinkedUsers).mockResolvedValue([{ twitchName: 'streamer', discordId: 'streamer-discord-id' }]);
    vi.mocked(findUserByTwitchName).mockResolvedValue(null);
    vi.mocked(resolveGuildIdForDiscordId).mockReturnValue('guild-A');
    __resetTwitchChannelDiscordIdCacheForTests();
  });

  it('ignores messages for an invalid channel name', () => {
    sendMessage('!!bad', 'alice', 'hello');
    expect(executeCustomCommandForTwitch).not.toHaveBeenCalled();
    expect(recordChatMessage).not.toHaveBeenCalled();
  });

  it('ignores messages for channels not in activeChannels', () => {
    sendMessage('#otherchan', 'alice', 'hello');
    expect(executeCustomCommandForTwitch).not.toHaveBeenCalled();
    expect(recordChatMessage).not.toHaveBeenCalled();
  });

  it('ignores shared-chat messages that originated in a different channel', () => {
    sendMessage('#streamer', 'alice', 'hello', { channelId: '111', sourceChannelId: '999' });
    expect(executeCustomCommandForTwitch).not.toHaveBeenCalled();
    expect(recordChatMessage).not.toHaveBeenCalled();
  });

  it('processes messages when sourceChannelId matches channelId', () => {
    vi.mocked(executeCustomCommandForTwitch).mockResolvedValue(undefined);
    sendMessage('#streamer', 'alice', 'hello', { channelId: '111', sourceChannelId: '111' });
    expect(executeCustomCommandForTwitch).toHaveBeenCalledWith('streamer', 'hello', 'alice', 'hello');
    expect(recordChatMessage).toHaveBeenCalledWith('streamer');
  });

  it('records chat activity for a normal message', () => {
    sendMessage('#streamer', 'alice', 'hello');
    expect(recordChatMessage).toHaveBeenCalledWith('streamer');
  });

  it('dispatches all seven executors for a normal message', async () => {
    vi.mocked(executeCustomCommandForTwitch).mockResolvedValue(undefined);
    vi.mocked(executeCounterCommandForTwitch).mockResolvedValue(undefined);
    vi.mocked(executeMultiCommandForTwitch).mockResolvedValue(undefined);
    vi.mocked(executeShoutoutForTwitch).mockResolvedValue(undefined);
    vi.mocked(handleCommand).mockResolvedValue(undefined);
    vi.mocked(executeCountdownForTwitch).mockResolvedValue(undefined);
    vi.mocked(executeFollowageForTwitch).mockResolvedValue(undefined);

    sendMessage('#streamer', 'alice', '!cmd', { displayName: 'Alice', userId: 'alice-id', channelId: 'streamer-id' });

    expect(executeCustomCommandForTwitch).toHaveBeenCalledWith('streamer', '!cmd', 'Alice', '!cmd');
    expect(executeMultiCommandForTwitch).toHaveBeenCalledWith('streamer', '!cmd', 'Alice', '!cmd');
    expect(executeShoutoutForTwitch).toHaveBeenCalledWith('streamer', '!cmd', 'Alice', false, '!cmd');
    // Guild resolution (Twitch-channel → discord_id → active voice guild) runs asynchronously
    // before handleCommand and executeCounterCommandForTwitch are invoked.
    await vi.waitFor(() => expect(handleCommand).toHaveBeenCalledOnce());
    expect(handleCommand).toHaveBeenCalledWith('!cmd', 'twitch', 'guild-A', '!cmd');
    await vi.waitFor(() => expect(executeCounterCommandForTwitch).toHaveBeenCalledOnce());
    expect(executeCounterCommandForTwitch).toHaveBeenCalledWith('streamer', '!cmd', 'Alice', 'guild-A', '!cmd');
    expect(executeCountdownForTwitch).toHaveBeenCalledWith('streamer', '!cmd', '!cmd');
    expect(executeFollowageForTwitch).toHaveBeenCalledWith('streamer', '!cmd', 'streamer-id', { id: 'alice-id', name: 'Alice' }, '!cmd');
  });

  it('resolves the target guild via the linked streamer\'s active voice presence', async () => {
    vi.mocked(handleCommand).mockResolvedValue(undefined);

    sendMessage('#streamer', 'alice', '!cmd');

    await vi.waitFor(() => expect(handleCommand).toHaveBeenCalledOnce());
    expect(getAllTwitchLinkedUsers).toHaveBeenCalled();
    expect(resolveGuildIdForDiscordId).toHaveBeenCalledWith('streamer-discord-id');
  });

  it('passes a null guildId to handleCommand when the channel has no linked Discord user', async () => {
    vi.mocked(getAllTwitchLinkedUsers).mockResolvedValue([]);
    vi.mocked(findUserByTwitchName).mockResolvedValue(null);
    vi.mocked(handleCommand).mockResolvedValue(undefined);

    sendMessage('#streamer', 'alice', '!cmd');

    await vi.waitFor(() => expect(handleCommand).toHaveBeenCalledOnce());
    expect(handleCommand).toHaveBeenCalledWith('!cmd', 'twitch', null, '!cmd');
    expect(resolveGuildIdForDiscordId).not.toHaveBeenCalled();
  });

  it('falls back to a live lookup when a channel is missing from the bulk cache, so a just-linked streamer works on the very next message', async () => {
    // Simulate a channel that was linked after the bulk cache's last load —
    // it's absent from the cached map even though the cache itself is fresh.
    vi.mocked(getAllTwitchLinkedUsers).mockResolvedValue([]);
    vi.mocked(findUserByTwitchName).mockResolvedValue({ discord_id: 'freshly-linked-discord-id' } as any);
    vi.mocked(handleCommand).mockResolvedValue(undefined);

    sendMessage('#streamer', 'alice', '!cmd');

    await vi.waitFor(() => expect(handleCommand).toHaveBeenCalledOnce());
    expect(findUserByTwitchName).toHaveBeenCalledWith('streamer');
    expect(resolveGuildIdForDiscordId).toHaveBeenCalledWith('freshly-linked-discord-id');
  });

  it('does not fall back to a live lookup when the channel is already present in the bulk cache', async () => {
    vi.mocked(handleCommand).mockResolvedValue(undefined);

    sendMessage('#streamer', 'alice', '!cmd');

    await vi.waitFor(() => expect(handleCommand).toHaveBeenCalledOnce());
    expect(findUserByTwitchName).not.toHaveBeenCalled();
  });

  it('re-resolves the linked discord_id after the cache TTL expires, picking up a relink', async () => {
    vi.mocked(handleCommand).mockResolvedValue(undefined);

    sendMessage('#streamer', 'alice', '!cmd');
    await vi.waitFor(() => expect(handleCommand).toHaveBeenCalledTimes(1));
    expect(getAllTwitchLinkedUsers).toHaveBeenCalledOnce();

    vi.mocked(getAllTwitchLinkedUsers).mockResolvedValue([{ twitchName: 'streamer', discordId: 'new-streamer-discord-id' }]);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);

    // The cache is now stale — this lookup kicks a background refresh but
    // (per the shared lookupCache's stale-while-revalidate strategy) still
    // serves the last-good mapping for this call.
    sendMessage('#streamer', 'alice', '!again');
    await vi.waitFor(() => expect(handleCommand).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(getAllTwitchLinkedUsers).toHaveBeenCalledTimes(2));

    // A subsequent lookup picks up the refreshed mapping.
    sendMessage('#streamer', 'alice', '!third');
    await vi.waitFor(() => expect(handleCommand).toHaveBeenCalledTimes(3));
    expect(resolveGuildIdForDiscordId).toHaveBeenLastCalledWith('new-streamer-discord-id');
  });

  it('passes the normalized channel and message to executors', () => {
    vi.mocked(executeCustomCommandForTwitch).mockResolvedValue(undefined);
    sendMessage('#STREAMER', 'alice', '!clap', { displayName: 'Alice' });
    expect(executeCustomCommandForTwitch).toHaveBeenCalledWith('streamer', '!clap', 'Alice', '!clap');
  });

  it('falls back to the login username when userInfo.displayName is absent', () => {
    vi.mocked(executeCustomCommandForTwitch).mockResolvedValue(undefined);
    sendMessage('#streamer', 'alice', '!hi');
    expect(executeCustomCommandForTwitch).toHaveBeenCalledWith('streamer', '!hi', 'alice', '!hi');
  });

  it('detects isMod=true from userInfo.isMod', () => {
    vi.mocked(executeShoutoutForTwitch).mockResolvedValue(undefined);
    sendMessage('#streamer', 'alice', '!so alice', { isMod: true });
    expect(executeShoutoutForTwitch).toHaveBeenCalledWith('streamer', '!so alice', 'alice', true, '!so');
  });

  it('detects isMod=true from userInfo.isBroadcaster', () => {
    vi.mocked(executeShoutoutForTwitch).mockResolvedValue(undefined);
    sendMessage('#streamer', 'alice', '!so alice', { isBroadcaster: true });
    expect(executeShoutoutForTwitch).toHaveBeenCalledWith('streamer', '!so alice', 'alice', true, '!so');
  });

  it('passes isMod=false when neither isMod nor isBroadcaster is set', () => {
    vi.mocked(executeShoutoutForTwitch).mockResolvedValue(undefined);
    sendMessage('#streamer', 'alice', '!so alice');
    expect(executeShoutoutForTwitch).toHaveBeenCalledWith('streamer', '!so alice', 'alice', false, '!so');
  });
});

// ─── sayInChannel ────────────────────────────────────────────────────────────

describe('sayInChannel', () => {
  it('throws for an invalid channel name', async () => {
    await connectBot();
    await expect(sayInChannel('!!bad', 'hi')).rejects.toThrow('Invalid channel name');
  });

  it('throws when not connected', async () => {
    // No startTwitchBot call — client is null.
    await expect(sayInChannel('streamer', 'hi')).rejects.toThrow('not connected');
  });

  it('delegates to the raw IRC client with the normalized, #-prefixed channel', async () => {
    await connectBot();
    await sayInChannel('#STREAMER', 'hello!');
    expect(mockClient.irc.say).toHaveBeenCalledWith('#streamer', 'hello!');
  });

  it('splits a message longer than the Twitch length limit on spaces', async () => {
    await connectBot();
    const longMessage = `${'a'.repeat(490)} ${'b'.repeat(20)}`;
    const sent = sayInChannel('#streamer', longMessage);
    // Each chunk is its own throttled send, so the second chunk waits behind the non-privileged
    // per-channel floor (NON_PRIVILEGED_CHANNEL_FLOOR_MS) before going out.
    await vi.runAllTimersAsync();
    await sent;
    expect(mockClient.irc.say).toHaveBeenCalledTimes(2);
    expect(mockClient.irc.say).toHaveBeenNthCalledWith(1, '#streamer', 'a'.repeat(490));
    expect(mockClient.irc.say).toHaveBeenNthCalledWith(2, '#streamer', 'b'.repeat(20));
  });

  it('splits a single token longer than the length limit, with no space to break on', async () => {
    await connectBot();
    const sent = sayInChannel('#streamer', 'a'.repeat(600));
    await vi.runAllTimersAsync();
    await sent;
    const chunks = mockClient.irc.say.mock.calls.map((call) => call[1] as string);
    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((chunk) => { expect(chunk.length).toBeLessThanOrEqual(500); });
    expect(chunks.join('')).toBe('a'.repeat(600));
  });

  it('keeps an exact-500-character final remainder as one message, even though it contains a space', async () => {
    await connectBot();
    const message = `${'a'.repeat(500)} ${'b'.repeat(250)} ${'c'.repeat(249)}`;
    const sent = sayInChannel('#streamer', message);
    await vi.runAllTimersAsync();
    await sent;
    const chunks = mockClient.irc.say.mock.calls.map((call) => call[1] as string);
    expect(chunks).toEqual(['a'.repeat(500), `${'b'.repeat(250)} ${'c'.repeat(249)}`]);
  });

  it('applies the non-privileged per-channel floor between chunks of the same split message', async () => {
    await connectBot();
    const longMessage = `${'a'.repeat(490)} ${'b'.repeat(20)}`;
    const sent = sayInChannel('#streamer', longMessage);

    // The first chunk goes out immediately; the second must wait the full floor.
    await vi.advanceTimersByTimeAsync(0);
    expect(mockClient.irc.say).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(mockClient.irc.say).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await sent;
    expect(mockClient.irc.say).toHaveBeenCalledTimes(2);
  });

  // Twitch's rate-limit window and per-channel floor are exercised exhaustively in
  // twitchSendQueue.test.ts — these just confirm sayInChannel wires channel + the live
  // privilege check (populated from raw USERSTATE messages, see onOwnUserState) into it,
  // and that it bypasses ChatClient#say() (see sendRawChatMessage) so no second, fixed
  // per-channel floor from Twurple's own rate limiter can undermine the privileged exemption.

  it('treats the channel as non-privileged when no USERSTATE has been seen for it yet', async () => {
    await connectBot();
    await sayInChannel('#streamer', 'first');
    const second = sayInChannel('#streamer', 'second');

    await vi.advanceTimersByTimeAsync(999);
    expect(mockClient.irc.say).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await second;
    expect(mockClient.irc.say).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['moderator', 'moderator/1'],
    ['vip', 'vip/1'],
    ['broadcaster', 'broadcaster/1'],
  ])('exempts a channel from the per-channel floor once a USERSTATE shows %s status', async (_label, rawBadges) => {
    await connectBot();
    // The privilege map is keyed by the normalized channel name — this must match that shape,
    // or a lookup-key regression would pass here despite never matching in production.
    fireUserState('#streamer', rawBadges);
    await sayInChannel('#streamer', 'first');
    await sayInChannel('#streamer', 'second');
    expect(mockClient.irc.say).toHaveBeenCalledTimes(2);
  });

  it('does not treat a channel as privileged from another channel\'s USERSTATE', async () => {
    await connectBot();
    fireUserState('#otherchannel', 'moderator/1');
    await sayInChannel('#streamer', 'first');
    const second = sayInChannel('#streamer', 'second');

    await vi.advanceTimersByTimeAsync(999);
    expect(mockClient.irc.say).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await second;
    expect(mockClient.irc.say).toHaveBeenCalledTimes(2);
  });
});

// ─── startTwitchBot / initializeActiveChannels ────────────────────────────────

describe('startTwitchBot', () => {
  it('populates activeChannels from the DB on startup', async () => {
    vi.mocked(getTwitchEnabledChannels).mockResolvedValue(['streamer', 'other1234']);
    vi.mocked(getUsers).mockResolvedValue([]);
    await startTwitchBot();

    expect(getActiveChannels().has('streamer')).toBe(true);
    expect(getActiveChannels().has('other1234')).toBe(true);
  });

  it('skips DB entries with invalid channel names', async () => {
    vi.mocked(getTwitchEnabledChannels).mockResolvedValue(['!!bad', 'streamer']);
    vi.mocked(getUsers).mockResolvedValue([]);
    await startTwitchBot();

    expect(getActiveChannels().has('streamer')).toBe(true);
    expect(getActiveChannels().size).toBe(1);
  });

  it('caches user IDs for channels loaded at startup', async () => {
    vi.mocked(getTwitchEnabledChannels).mockResolvedValue(['streamer']);
    vi.mocked(getUsers).mockResolvedValue([{ login: 'streamer', id: 'uid99' } as any]);
    await startTwitchBot();

    expect(getActiveChannelUserIds().get('streamer')).toBe('uid99');
  });

  it('does not call getUsers when there are no active channels', async () => {
    vi.mocked(getTwitchEnabledChannels).mockResolvedValue([]);
    await startTwitchBot();

    expect(getUsers).not.toHaveBeenCalled();
  });

  it('re-throws when authentication fails', async () => {
    vi.mocked(getTwitchEnabledChannels).mockResolvedValue([]);
    mockClient.connect.mockImplementation(() => {
      queueMicrotask(() => {
        handlers.authenticationFailureHandlers.slice().forEach((h) => h('bad credentials', 1));
      });
    });

    await expect(startTwitchBot()).rejects.toThrow('Twitch chat authentication failed');
  });

  it('re-throws when fetching a token fails', async () => {
    vi.mocked(getTwitchEnabledChannels).mockResolvedValue([]);
    mockClient.connect.mockImplementation(() => {
      queueMicrotask(() => {
        handlers.tokenFetchFailureHandlers.slice().forEach((h) => h(new Error('token fetch failed')));
      });
    });

    await expect(startTwitchBot()).rejects.toThrow('token fetch failed');
  });

  it('does not start the chat client and alerts the owner when no bot chat token is stored', async () => {
    vi.mocked(getBotChatToken).mockResolvedValue(null);
    vi.mocked(getTwitchEnabledChannels).mockResolvedValue([]);

    await startTwitchBot();

    expect(mockClient.connect).not.toHaveBeenCalled();
    expect(vi.mocked(sendOwnerAlert)).toHaveBeenCalledWith(expect.stringContaining('/admin/bot-auth'));
    await expect(sayInChannel('streamer', 'hi')).rejects.toThrow('not connected');
  });

  it('adds the stored token to the auth provider under the chat intent', async () => {
    vi.mocked(getTwitchEnabledChannels).mockResolvedValue([]);

    await startTwitchBot();

    expect(mockAuthProvider.addUser).toHaveBeenCalledWith(
      STORED_BOT_TOKEN.twitchUserId,
      expect.objectContaining({ accessToken: STORED_BOT_TOKEN.accessToken, refreshToken: STORED_BOT_TOKEN.refreshToken }),
      ['chat'],
    );
  });

  it('persists a refreshed token via the onRefresh handler', async () => {
    vi.mocked(getTwitchEnabledChannels).mockResolvedValue([]);
    await startTwitchBot();

    await authProviderHandlers.refreshHandlers[0]!('bot-uid', {
      accessToken: 'new-access', refreshToken: 'new-refresh', expiresIn: 3600, obtainmentTimestamp: Date.now(),
    });

    expect(vi.mocked(saveBotChatTokenIfOwnedBy)).toHaveBeenCalledWith(STORED_BOT_TOKEN.connectionId, 'new-access', 'new-refresh', expect.any(Number));
  });

  it('logs but does not throw when a refreshed-token write is dropped at the DB level (a reconnect replaced this connection first)', async () => {
    // Simulates a refresh that started before a reconnect (to the same account or a different
    // one — connection_id covers both) and completed after it: the conditional DB write reports
    // no row updated because connection_id moved on underneath it.
    vi.mocked(getTwitchEnabledChannels).mockResolvedValue([]);
    vi.mocked(saveBotChatTokenIfOwnedBy).mockResolvedValue(false);
    await startTwitchBot();

    await expect(authProviderHandlers.refreshHandlers[0]!('bot-uid', {
      accessToken: 'new-access', refreshToken: 'new-refresh', expiresIn: 3600, obtainmentTimestamp: Date.now(),
    })).resolves.toBeUndefined();
  });

  it('does not alert the owner when a token-clear write is dropped at the DB level (a reconnect replaced this connection first)', async () => {
    vi.mocked(getTwitchEnabledChannels).mockResolvedValue([]);
    vi.mocked(clearBotChatTokenIfOwnedBy).mockResolvedValue(false);
    await startTwitchBot();

    const error = Object.assign(new Error('Encountered HTTP status code 401'), {
      statusCode: 401,
      body: JSON.stringify({ status: 401, message: 'Invalid refresh token' }),
    });
    await authProviderHandlers.refreshFailureHandlers[0]!('bot-uid', error);

    expect(vi.mocked(sendOwnerAlert)).not.toHaveBeenCalled();
  });

  // A stale callback firing after a reconnect — to a *different* account or the *same* one — is
  // covered by the "dropped at the DB level" tests above: saveBotChatTokenIfOwnedBy/
  // clearBotChatTokenIfOwnedBy are the actual safety net (a compare-and-swap on connection_id
  // enforced by the database), not an in-process check here, since that alone can't order two
  // independent already-in-flight DB writes against each other. connection_id (rather than the
  // Twitch user ID) is what makes the same-account case covered too — see buildBotAuthProvider's
  // doc and the discussion on PR #666.

  it('drops a refreshed token from a stale connection even when the reconnect was to the same Twitch account', async () => {
    // A same-account reconnect still bumps connection_id (saveBotChatToken always does), so an
    // in-flight refresh captured under the old connection_id is dropped exactly like a
    // different-account reconnect would be — this is the case that used to be an accepted,
    // unfixed residual before connection_id existed.
    vi.mocked(getTwitchEnabledChannels).mockResolvedValue([]);
    vi.mocked(saveBotChatTokenIfOwnedBy).mockResolvedValue(false);
    await startTwitchBot();

    await authProviderHandlers.refreshHandlers[0]!('bot-uid', {
      accessToken: 'new-access', refreshToken: 'new-refresh', expiresIn: 3600, obtainmentTimestamp: Date.now(),
    });

    expect(vi.mocked(saveBotChatTokenIfOwnedBy)).toHaveBeenCalledWith(STORED_BOT_TOKEN.connectionId, 'new-access', 'new-refresh', expect.any(Number));
  });

  it('clears the stored token and alerts the owner when the response body names an invalid refresh token (401)', async () => {
    vi.mocked(getTwitchEnabledChannels).mockResolvedValue([]);
    await startTwitchBot();

    const error = Object.assign(new Error('Encountered HTTP status code 401'), {
      statusCode: 401,
      body: JSON.stringify({ status: 401, message: 'Invalid refresh token' }),
    });
    await authProviderHandlers.refreshFailureHandlers[0]!('bot-uid', error);

    expect(vi.mocked(clearBotChatTokenIfOwnedBy)).toHaveBeenCalled();
    expect(vi.mocked(sendOwnerAlert)).toHaveBeenCalledWith(expect.stringContaining('/admin/bot-auth'));
  });

  it('disconnects the chat client (not just the DB row) after a confirmed invalid refresh token, and does not reconnect', async () => {
    vi.mocked(getTwitchEnabledChannels).mockResolvedValue([]);
    await startTwitchBot();
    mockClient.quit.mockClear();
    mockClient.connect.mockClear();
    // The stored token is genuinely gone after the clear — without this, the default mock would
    // keep resolving the pre-clear token and restartTwitchBot()'s own startTwitchBot() call would
    // reconnect with it, masking a regression where the clear didn't actually take effect.
    vi.mocked(getBotChatToken).mockResolvedValueOnce(null);

    const error = Object.assign(new Error('Encountered HTTP status code 401'), {
      statusCode: 401,
      body: JSON.stringify({ status: 401, message: 'Invalid refresh token' }),
    });
    await authProviderHandlers.refreshFailureHandlers[0]!('bot-uid', error);

    // Leaving the dead session connected until Twitch eventually rejects it would misrepresent
    // the bot's actual state — restartTwitchBot() (not a bare disconnect) tears it down and, since
    // there's no token left to reconnect with, leaves the bot stopped.
    expect(mockClient.quit).toHaveBeenCalled();
    expect(mockClient.connect).not.toHaveBeenCalled();
  });

  it('still alerts the owner even if disconnecting the chat client after the clear fails', async () => {
    vi.mocked(getTwitchEnabledChannels).mockResolvedValue([]);
    await startTwitchBot();

    // Simulates restartTwitchBot()'s own startTwitchBot() call failing (e.g. a transient
    // reconnect error) — the alert must still fire since the DB is already cleared either way.
    mockClient.connect.mockImplementationOnce(() => {
      handlers.tokenFetchFailureHandlers.slice().forEach((h) => h(new Error('token fetch failed')));
    });

    const error = Object.assign(new Error('Encountered HTTP status code 401'), {
      statusCode: 401,
      body: JSON.stringify({ status: 401, message: 'Invalid refresh token' }),
    });
    await expect(authProviderHandlers.refreshFailureHandlers[0]!('bot-uid', error)).resolves.toBeUndefined();

    expect(vi.mocked(sendOwnerAlert)).toHaveBeenCalledWith(expect.stringContaining('/admin/bot-auth'));
  });

  it('does not disconnect the chat client when the clear itself is declined (a reconnect replaced this connection first)', async () => {
    vi.mocked(getTwitchEnabledChannels).mockResolvedValue([]);
    vi.mocked(clearBotChatTokenIfOwnedBy).mockResolvedValue(false);
    await startTwitchBot();
    mockClient.quit.mockClear();

    const error = Object.assign(new Error('Encountered HTTP status code 401'), {
      statusCode: 401,
      body: JSON.stringify({ status: 401, message: 'Invalid refresh token' }),
    });
    await authProviderHandlers.refreshFailureHandlers[0]!('bot-uid', error);

    expect(mockClient.quit).not.toHaveBeenCalled();
  });

  it('clears the stored token and alerts the owner when the response body names an invalid refresh token (400)', async () => {
    vi.mocked(getTwitchEnabledChannels).mockResolvedValue([]);
    await startTwitchBot();

    const error = Object.assign(new Error('Encountered HTTP status code 400'), {
      statusCode: 400,
      body: JSON.stringify({ status: 400, message: 'Invalid refresh token' }),
    });
    await authProviderHandlers.refreshFailureHandlers[0]!('bot-uid', error);

    expect(vi.mocked(clearBotChatTokenIfOwnedBy)).toHaveBeenCalled();
    expect(vi.mocked(sendOwnerAlert)).toHaveBeenCalledWith(expect.stringContaining('/admin/bot-auth'));
  });

  it('clears the stored token and alerts the owner when the response body says the refresh token was revoked', async () => {
    vi.mocked(getTwitchEnabledChannels).mockResolvedValue([]);
    await startTwitchBot();

    const error = Object.assign(new Error('Encountered HTTP status code 400'), {
      statusCode: 400,
      body: JSON.stringify({ status: 400, message: 'Refresh token has been revoked' }),
    });
    await authProviderHandlers.refreshFailureHandlers[0]!('bot-uid', error);

    expect(vi.mocked(clearBotChatTokenIfOwnedBy)).toHaveBeenCalled();
    expect(vi.mocked(sendOwnerAlert)).toHaveBeenCalledWith(expect.stringContaining('/admin/bot-auth'));
  });

  it('leaves the stored token in place when the status is 400/401 but the body does not name an invalid refresh token', async () => {
    vi.mocked(getTwitchEnabledChannels).mockResolvedValue([]);
    await startTwitchBot();

    // Same status Twitch would return for e.g. a bad client secret — not evidence the refresh
    // token itself is invalid.
    const error = Object.assign(new Error('Encountered HTTP status code 400'), {
      statusCode: 400,
      body: JSON.stringify({ status: 400, message: 'Invalid client secret' }),
    });
    await authProviderHandlers.refreshFailureHandlers[0]!('bot-uid', error);

    expect(vi.mocked(clearBotChatTokenIfOwnedBy)).not.toHaveBeenCalled();
    expect(vi.mocked(sendOwnerAlert)).not.toHaveBeenCalled();
  });

  it('leaves the stored token in place when the body mentions the refresh token but does not say it is invalid/revoked (e.g. missing)', async () => {
    vi.mocked(getTwitchEnabledChannels).mockResolvedValue([]);
    await startTwitchBot();

    // Mentions "refresh token", but a missing token is a request-shape problem, not evidence
    // that the stored refresh token itself is bad.
    const error = Object.assign(new Error('Encountered HTTP status code 400'), {
      statusCode: 400,
      body: JSON.stringify({ status: 400, message: 'Missing refresh token parameter' }),
    });
    await authProviderHandlers.refreshFailureHandlers[0]!('bot-uid', error);

    expect(vi.mocked(clearBotChatTokenIfOwnedBy)).not.toHaveBeenCalled();
    expect(vi.mocked(sendOwnerAlert)).not.toHaveBeenCalled();
  });

  it('leaves the stored token in place when the status is 400/401 but the body is not parseable JSON', async () => {
    vi.mocked(getTwitchEnabledChannels).mockResolvedValue([]);
    await startTwitchBot();

    const error = Object.assign(new Error('Encountered HTTP status code 401'), { statusCode: 401, body: 'not json' });
    await authProviderHandlers.refreshFailureHandlers[0]!('bot-uid', error);

    expect(vi.mocked(clearBotChatTokenIfOwnedBy)).not.toHaveBeenCalled();
    expect(vi.mocked(sendOwnerAlert)).not.toHaveBeenCalled();
  });

  it('leaves the stored token in place and does not alert on a transient refresh failure (network error, no statusCode)', async () => {
    vi.mocked(getTwitchEnabledChannels).mockResolvedValue([]);
    await startTwitchBot();

    await authProviderHandlers.refreshFailureHandlers[0]!('bot-uid', new Error('fetch failed'));

    expect(vi.mocked(clearBotChatTokenIfOwnedBy)).not.toHaveBeenCalled();
    expect(vi.mocked(sendOwnerAlert)).not.toHaveBeenCalled();
  });

  it('leaves the stored token in place and does not alert on a transient refresh failure (5xx)', async () => {
    vi.mocked(getTwitchEnabledChannels).mockResolvedValue([]);
    await startTwitchBot();

    const error = Object.assign(new Error('Encountered HTTP status code 503'), {
      statusCode: 503,
      body: JSON.stringify({ status: 503, message: 'Internal server error' }),
    });
    await authProviderHandlers.refreshFailureHandlers[0]!('bot-uid', error);

    expect(vi.mocked(clearBotChatTokenIfOwnedBy)).not.toHaveBeenCalled();
    expect(vi.mocked(sendOwnerAlert)).not.toHaveBeenCalled();
  });

  it('rebuilds the chat connection after a transient refresh failure, instead of merely leaving the dead provider in place', async () => {
    // Twurple's RefreshingAuthProvider permanently caches a refresh failure per user and never
    // retries it on its own — leaving the old provider running would silently and permanently
    // break chat auth for a blip Twitch has already recovered from. A rebuild (via
    // restartTwitchBot(), which re-reads the still-valid stored token) is required to recover
    // within the same process, not just on a manual restart.
    vi.mocked(getTwitchEnabledChannels).mockResolvedValue([]);
    await startTwitchBot();
    mockClient.quit.mockClear();
    mockClient.connect.mockClear();

    const error = Object.assign(new Error('Encountered HTTP status code 503'), {
      statusCode: 503,
      body: JSON.stringify({ status: 503, message: 'Internal server error' }),
    });
    await authProviderHandlers.refreshFailureHandlers[0]!('bot-uid', error);

    expect(mockClient.quit).toHaveBeenCalled();
    expect(mockClient.connect).toHaveBeenCalled();
    // A successfully self-healed blip is not worth paging anyone for.
    expect(vi.mocked(sendOwnerAlert)).not.toHaveBeenCalled();
  });

  it('retries with backoff and does not alert if a later rebuild attempt reconnects', async () => {
    vi.mocked(getTwitchEnabledChannels).mockResolvedValue([]);
    await startTwitchBot();
    mockClient.connect.mockClear();

    // Only the first reconnect attempt fails — falls back to the default (successful) connect
    // implementation afterwards.
    mockClient.connect.mockImplementationOnce(() => {
      handlers.tokenFetchFailureHandlers.slice().forEach((h) => h(new Error('token fetch failed')));
    });

    const error = Object.assign(new Error('Encountered HTTP status code 503'), {
      statusCode: 503,
      body: JSON.stringify({ status: 503, message: 'Internal server error' }),
    });
    const result = authProviderHandlers.refreshFailureHandlers[0]!('bot-uid', error);
    await vi.runAllTimersAsync();
    await expect(result).resolves.toBeUndefined();

    expect(mockClient.connect).toHaveBeenCalledTimes(2);
    // Unlike the invalid-token path, the DB token is untouched here — the alert wording must not
    // imply the credential was cleared.
    expect(vi.mocked(clearBotChatTokenIfOwnedBy)).not.toHaveBeenCalled();
    expect(vi.mocked(sendOwnerAlert)).not.toHaveBeenCalled();
  });

  it('gives up and alerts the owner once after a single onRefreshFailure exhausts the retry budget on its own', async () => {
    // A rebuild that can't reconnect at all (e.g. the stored token is genuinely still bad, or an
    // ongoing Twitch outage) has the new provider's own first token fetch fail too, re-emitting
    // onRefreshFailure — but rebuildAfterTransientRefreshFailure owns its whole bounded retry loop
    // internally rather than depending on being re-invoked (see its doc for why: restart() can also
    // fail for reasons that would never re-trigger onRefreshFailure at all). So a *single* call
    // below must exhaust every attempt and alert exactly once, entirely on its own.
    vi.mocked(getTwitchEnabledChannels).mockResolvedValue([]);
    await startTwitchBot();
    mockClient.connect.mockClear();

    mockClient.connect.mockImplementation(() => {
      handlers.tokenFetchFailureHandlers.slice().forEach((h) => h(new Error('token fetch failed')));
    });

    const error = Object.assign(new Error('Encountered HTTP status code 503'), {
      statusCode: 503,
      body: JSON.stringify({ status: 503, message: 'Internal server error' }),
    });
    const result = authProviderHandlers.refreshFailureHandlers[0]!('bot-uid', error);
    await vi.runAllTimersAsync();
    await expect(result).resolves.toBeUndefined();

    expect(mockClient.connect).toHaveBeenCalledTimes(5);
    // Unlike the invalid-token path, the DB token is untouched here — the alert wording must not
    // imply the credential was cleared.
    expect(vi.mocked(clearBotChatTokenIfOwnedBy)).not.toHaveBeenCalled();
    expect(vi.mocked(sendOwnerAlert)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendOwnerAlert)).toHaveBeenCalledWith(expect.stringContaining('/admin/bot-auth'));
  });

  it('does not become connected if authentication succeeds after the connect timeout', async () => {
    vi.mocked(getTwitchEnabledChannels).mockResolvedValue([]);
    mockClient.connect.mockImplementation(() => {}); // never fires any connectAndWait event

    const started = startTwitchBot();
    // Attached immediately so Node doesn't flag `started`'s rejection as unhandled during the gap
    // between it settling (when the fake timer below fires) and the `await expect(...)` below.
    started.catch(() => {});
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS);
    await expect(started).rejects.toThrow('Twitch connect timed out');

    // A late authentication success arrives after startup already reported failure — the
    // persistent onConnected listener should have been unbound by the timeout cleanup, so this
    // must not mark the bot connected.
    fireAuthSuccess();
    await expect(sayInChannel('streamer', 'hi')).rejects.toThrow('not connected');
  });
});

// ─── stopTwitchBot ────────────────────────────────────────────────────────────

describe('stopTwitchBot', () => {
  it('clears active channels and user IDs', async () => {
    vi.mocked(getTwitchEnabledChannels).mockResolvedValue(['streamer']);
    vi.mocked(getUsers).mockResolvedValue([{ login: 'streamer', id: 'u1' } as any]);
    await startTwitchBot();

    await stopTwitchBot();

    expect(getActiveChannels().size).toBe(0);
    expect(getActiveChannelUserIds().size).toBe(0);
  });

  it('clears cached privileged status even when the disconnect event never fires', async () => {
    await connectBot();
    fireUserState('#streamer', 'moderator/1');
    mockClient.quit.mockImplementation(() => {}); // never fires onDisconnect

    // Restore quit()'s default behavior in a finally, even on assertion failure — otherwise the
    // outer afterEach's stopTwitchBot() call would hang for the full DISCONNECT_TIMEOUT_MS under
    // fake timers nothing advances, masking the real failure behind a hook-timeout error instead.
    try {
      const stopped = stopTwitchBot();
      await vi.advanceTimersByTimeAsync(DISCONNECT_TIMEOUT_MS);
      await stopped;

      // Restart and reconnect without a fresh USERSTATE — privilege must not carry over.
      await connectBot();
      await sayInChannel('#streamer', 'first');
      const second = sayInChannel('#streamer', 'second');

      await vi.advanceTimersByTimeAsync(999);
      expect(mockClient.irc.say).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      await second;
      expect(mockClient.irc.say).toHaveBeenCalledTimes(2);
    } finally {
      mockClient.quit.mockImplementation(() => {
        queueMicrotask(() => fireDisconnect(true));
      });
    }
  });

  it('calls client.quit', async () => {
    await connectBot();

    await stopTwitchBot();

    expect(mockClient.quit).toHaveBeenCalledOnce();
  });

  it('records the health store as disconnected immediately, even before quit() settles', async () => {
    await connectBot();
    vi.mocked(recordTwitchChatConnected).mockClear();
    mockClient.quit.mockImplementation(() => {}); // never fires onDisconnect

    try {
      const stopped = stopTwitchBot();
      expect(recordTwitchChatConnected).toHaveBeenCalledWith(false);
      await vi.advanceTimersByTimeAsync(DISCONNECT_TIMEOUT_MS);
      await stopped;
    } finally {
      mockClient.quit.mockImplementation(() => {
        queueMicrotask(() => fireDisconnect(true));
      });
    }
  });

  it('is a no-op when the client was never started', async () => {
    await stopTwitchBot();
    expect(mockClient.quit).not.toHaveBeenCalled();
  });

  it('active channels remain visible to the disconnected handler while quit() settles', async () => {
    await connectBot();
    vi.mocked(getUsers).mockResolvedValue([]);
    await joinTwitchChannel('streamer');
    vi.mocked(setTwitchChannel).mockClear();

    await stopTwitchBot();

    // onDisconnected must have seen 'streamer' and called setTwitchChannel.
    expect(vi.mocked(setTwitchChannel)).toHaveBeenCalledWith('streamer', false);
    // clearMembershipState runs after, so channels are gone.
    expect(getActiveChannels().size).toBe(0);
  });

  it('marks active channels offline when client.quit() throws synchronously', async () => {
    await connectBot();
    vi.mocked(getUsers).mockResolvedValue([]);
    await joinTwitchChannel('streamer');
    mockClient.quit.mockImplementation(() => { throw new Error('disconnect failed'); });
    vi.mocked(setTwitchChannel).mockClear();

    await stopTwitchBot();

    expect(vi.mocked(setTwitchChannel)).toHaveBeenCalledWith('streamer', false);
    expect(getActiveChannels().size).toBe(0);
  });

  it('does not hang forever when the disconnect event never fires', async () => {
    await connectBot();
    vi.mocked(getUsers).mockResolvedValue([]);
    await joinTwitchChannel('streamer');
    mockClient.quit.mockImplementation(() => {}); // never fires onDisconnect
    vi.mocked(setTwitchChannel).mockClear();
    const setChatClientSpy = vi.spyOn(twitchChannelMembership, 'setChatClient');

    const stopped = stopTwitchBot();
    await vi.advanceTimersByTimeAsync(DISCONNECT_TIMEOUT_MS);
    await stopped;

    expect(vi.mocked(setTwitchChannel)).toHaveBeenCalledWith('streamer', false);
    expect(getActiveChannels().size).toBe(0);
    expect(setChatClientSpy).toHaveBeenCalledWith(null);
    setChatClientSpy.mockRestore();

    // Client reference was cleared despite the hang: a second stop is a no-op
    // (mirrors the "no-op when never started" case) rather than awaiting the
    // still-hanging quit() again.
    mockClient.quit.mockClear();
    await stopTwitchBot();
    expect(mockClient.quit).not.toHaveBeenCalled();
  });

  it('unbinds every listener startTwitchBot() registered (not just quitAndWait\'s temporary one) when stopping', async () => {
    await connectBot();
    mockClient.quit.mockImplementation(() => {}); // never fires onDisconnect

    try {
      const stopped = stopTwitchBot();
      await vi.advanceTimersByTimeAsync(DISCONNECT_TIMEOUT_MS);
      await stopped;

      // The temporary quitAndWait listener and all four persistent listeners registered by
      // startTwitchBot() must be gone — otherwise a late event on this discarded client (a
      // message, an authentication success, a disconnect, or a raw USERSTATE) could still run
      // its handler against whatever module state is current by then, e.g. after a restart.
      expect(handlers.disconnectHandlers).toHaveLength(0);
      expect(handlers.messageHandlers).toHaveLength(0);
      expect(handlers.authSuccessHandlers).toHaveLength(0);
      expect(handlers.userStateHandlers).toHaveLength(0);
    } finally {
      mockClient.quit.mockImplementation(() => {
        queueMicrotask(() => fireDisconnect(true));
      });
    }

    // Restart: only the new client's own listeners should be registered, confirming nothing from
    // the old, timed-out client survived to interfere with the new session.
    await connectBot();
    expect(handlers.disconnectHandlers).toHaveLength(1);
    expect(handlers.messageHandlers).toHaveLength(1);
    expect(handlers.authSuccessHandlers).toHaveLength(1);
    expect(handlers.userStateHandlers).toHaveLength(1);
  });
});

// ─── restartTwitchBot ───────────────────────────────────────────────────────────

describe('restartTwitchBot', () => {
  it('stops the existing client and starts a new one', async () => {
    await connectBot();
    mockClient.quit.mockClear();
    mockClient.connect.mockClear();

    await restartTwitchBot();

    expect(mockClient.quit).toHaveBeenCalledTimes(1);
    expect(mockClient.connect).toHaveBeenCalledTimes(1);
  });

  it('serializes overlapping calls so a second restart does not stop the client until the first has finished starting', async () => {
    await connectBot();

    const callOrder: string[] = [];
    let releaseFirstConnect: () => void = () => {};
    const firstConnectGate = new Promise<void>((resolve) => { releaseFirstConnect = resolve; });
    let connectCallCount = 0;
    mockClient.connect.mockImplementation(() => {
      connectCallCount += 1;
      const gate = connectCallCount === 1 ? firstConnectGate : Promise.resolve();
      void gate.then(() => fireAuthSuccess());
    });
    mockClient.quit.mockImplementation(() => {
      callOrder.push(`quit${connectCallCount + 1}`);
      queueMicrotask(() => fireDisconnect(true));
    });

    const restart1 = restartTwitchBot();
    const restart2 = restartTwitchBot();

    // Flush pending microtasks: restart1's stop (and the start it kicks off) should have run, but
    // restart2's stop must still be blocked behind restart1's still-pending connect() — without
    // the serialization in restartTwitchBot(), restart2's stopTwitchBot() would run immediately
    // instead of waiting.
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(callOrder).toEqual(['quit1']);

    releaseFirstConnect();
    await restart1;
    await restart2;

    expect(callOrder).toEqual(['quit1', 'quit2']);
    expect(connectCallCount).toBe(2);
  });

  it('does not permanently break the restart chain when one restart fails', async () => {
    await connectBot();
    mockClient.connect.mockImplementationOnce(() => {
      handlers.tokenFetchFailureHandlers.slice().forEach((h) => h(new Error('token fetch failed')));
    });

    await expect(restartTwitchBot()).rejects.toThrow('token fetch failed');

    mockClient.connect.mockImplementation(() => { queueMicrotask(() => fireAuthSuccess()); });
    await expect(restartTwitchBot()).resolves.toBeUndefined();
  });
});

// ─── reconcileJoinedChannels (via onConnected) ────────────────────────────────
//
// startTwitchBot() itself only resolves once onAuthenticationSuccess fires (see connectAndWait),
// and that same event triggers onConnected's fire-and-forget reconcileJoinedChannels() call — so by
// the time `await startTwitchBot()` returns, the initial reconciliation has already been *kicked
// off*. These tests seed confirmedJoinedChannels (via __setConfirmedJoinedChannelsForTests) up
// front, before starting the bot, rather than firing a separate synthetic reconnect afterward —
// deliberately not mockClient.currentChannels, which reconcileJoinedChannels no longer trusts (see
// confirmedJoinedChannels's doc in twitchChannelMembership.ts for why). Each reconcile outcome
// (part / join / mark online / cache user ID) is checked once through startTwitchBot() here, so a
// startup-wiring regression can't hide behind the direct reconcileJoinedChannels() unit tests; the
// rules' edge cases (failures, throttling, disconnected client) live in twitchChannelMembership.test.ts.

describe('startTwitchBot — initial channel reconciliation', () => {
  it('parts a joined channel that is not in activeChannels', async () => {
    vi.mocked(getTwitchEnabledChannels).mockResolvedValue([]);
    vi.mocked(getUsers).mockResolvedValue([]);
    __setConfirmedJoinedChannelsForTests(['stale']);

    await startTwitchBot();
    await vi.runAllTimersAsync();

    expect(mockClient.part).toHaveBeenCalledWith('stale');
    expect(vi.mocked(setTwitchChannel)).toHaveBeenCalledWith('stale', false);
  });

  it('marks a channel online without joining or parting when it is in both activeChannels and confirmed joined', async () => {
    vi.mocked(getTwitchEnabledChannels).mockResolvedValue(['streamer']);
    vi.mocked(getUsers).mockResolvedValue([]);
    __setConfirmedJoinedChannelsForTests(['streamer']);

    await startTwitchBot();
    await vi.runAllTimersAsync();

    expect(mockClient.part).not.toHaveBeenCalled();
    expect(mockClient.join).not.toHaveBeenCalled();
    expect(vi.mocked(setTwitchChannel)).toHaveBeenCalledWith('streamer', true);
  });

  it('joins an activeChannels channel that the client is not yet joined to', async () => {
    vi.mocked(getTwitchEnabledChannels).mockResolvedValue(['streamer']);
    vi.mocked(getUsers).mockResolvedValue([]);

    await startTwitchBot();
    await vi.runAllTimersAsync(); // advance JOIN_THROTTLE_MS

    expect(mockClient.join).toHaveBeenCalledWith('streamer');
    expect(vi.mocked(setTwitchChannel)).toHaveBeenCalledWith('streamer', true);
  });

  it('rejoins an active channel even when the client still reports it as previously joined (a reconnect leaves currentChannels stale)', async () => {
    vi.mocked(getTwitchEnabledChannels).mockResolvedValue(['streamer']);
    vi.mocked(getUsers).mockResolvedValue([]);
    mockClient.currentChannels = ['streamer']; // stale Twurple bookkeeping — must not be trusted

    await startTwitchBot();
    await vi.runAllTimersAsync();

    expect(mockClient.join).toHaveBeenCalledWith('streamer');
    expect(vi.mocked(setTwitchChannel)).toHaveBeenCalledWith('streamer', true);
  });

  it('refreshes the user ID cache for a channel confirmed live at connect time', async () => {
    vi.mocked(getTwitchEnabledChannels).mockResolvedValue(['streamer']);
    vi.mocked(getUsers)
      .mockResolvedValueOnce([]) // initializeActiveChannels — simulate failed startup cache
      .mockResolvedValue([{ login: 'streamer', id: 'uid-reconcile' } as any]);
    __setConfirmedJoinedChannelsForTests(['streamer']); // already joined

    await startTwitchBot();
    await vi.runAllTimersAsync();
    await Promise.resolve(); // flush cacheChannelUserId .then

    expect(getActiveChannelUserIds().get('streamer')).toBe('uid-reconcile');
  });

  it('caches the user ID when joinMissingChannel joins a channel at connect time', async () => {
    vi.mocked(getTwitchEnabledChannels).mockResolvedValue(['streamer']);
    vi.mocked(getUsers)
      .mockResolvedValueOnce([]) // initializeActiveChannels
      .mockResolvedValue([{ login: 'streamer', id: 'uid-join' } as any]);

    await startTwitchBot();
    await vi.runAllTimersAsync(); // advance JOIN_THROTTLE_MS
    await Promise.resolve(); // flush cacheChannelUserId .then

    expect(getActiveChannelUserIds().get('streamer')).toBe('uid-join');
  });
});

// ─── onDisconnected ───────────────────────────────────────────────────────────

describe('onDisconnected', () => {
  it('marks all active channels offline', async () => {
    vi.mocked(getTwitchEnabledChannels).mockResolvedValue(['streamer']);
    vi.mocked(getUsers).mockResolvedValue([]);
    await startTwitchBot();
    vi.mocked(setTwitchChannel).mockClear();

    fireDisconnect(false, new Error('Connection closed.'));

    expect(vi.mocked(setTwitchChannel)).toHaveBeenCalledWith('streamer', false);
  });

  it('clears cached privileged status, so a reconnect without a fresh USERSTATE is treated as non-privileged', async () => {
    await connectBot();
    fireUserState('#streamer', 'moderator/1');

    fireDisconnect(false, new Error('Connection closed.'));
    // Twurple reconnects within the same ChatClient instance — model that by re-firing
    // onAuthenticationSuccess without a fresh USERSTATE for the channel.
    fireAuthSuccess();

    await sayInChannel('#streamer', 'first');
    const second = sayInChannel('#streamer', 'second');

    await vi.advanceTimersByTimeAsync(999);
    expect(mockClient.irc.say).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await second;
    expect(mockClient.irc.say).toHaveBeenCalledTimes(2);
  });
});
