import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockLogger } from '../test-utils/loggerMock';

// ─── Hoisted state (available inside vi.mock factories) ───────────────────────

const { mockClient, handlers } = vi.hoisted(() => {
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
  };
});

// ─── Module mocks (must precede imports) ─────────────────────────────────────

// Must use a regular function (not an arrow) so `new ChatClient()` works.
vi.mock('@twurple/chat', () => ({
  ChatClient: vi.fn(function MockChatClient() { return mockClient; }),
  UserState: class MockUserState {},
}));

vi.mock('@twurple/auth', () => ({
  StaticAuthProvider: vi.fn(function MockStaticAuthProvider() { return {}; }),
}));

vi.mock('../shared/logger', () => ({ createLogger: mockLogger }));

vi.mock('../shared/config', () => ({
  TWITCH_OAUTH_TOKEN: 'oauth:test',
  TWITCH_CLIENT_ID: 'test-client-id',
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
    createManagedLookupCache,
    DEFAULT_REFRESH_FAILURE_BACKOFF_MS,
    DEFAULT_REFRESH_FAILURE_MAX_BACKOFF_MS,
  };
});

vi.mock('../discord/voicePresence', () => ({
  resolveGuildIdForDiscordId: vi.fn(),
}));

vi.mock('./twitchApi', () => ({
  getUsers: vi.fn(),
}));

vi.mock('../shared/statusStore', () => ({
  setTwitchChannel: vi.fn(),
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

vi.mock('./twitchChatActivity', () => ({
  recordChatMessage: vi.fn(),
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import {
  startTwitchBot,
  stopTwitchBot,
  sayInChannel,
  __resetTwitchChannelDiscordIdCacheForTests,
  __resetTwitchPrivilegedChannelsForTests,
  CONNECT_TIMEOUT_MS,
  DISCONNECT_TIMEOUT_MS,
} from './twitchBot';
import { __resetTwitchSendQueueForTests } from './twitchSendQueue';
import {
  joinTwitchChannel,
  partTwitchChannel,
  getActiveChannels,
  getActiveChannelUserIds,
  setChannelJoinedHook,
} from './twitchChannelMembership';
import * as twitchChannelMembership from './twitchChannelMembership';
import { getTwitchEnabledChannels, getAllTwitchLinkedUsers, findUserByTwitchName } from '../db';
import { resolveGuildIdForDiscordId } from '../discord/voicePresence';
import { getUsers } from './twitchApi';
import { setTwitchChannel } from '../shared/statusStore';
import { executeCustomCommandForTwitch } from '../commands/customCommandHandler';
import { executeCounterCommandForTwitch } from '../commands/counterHandler';
import { executeMultiCommandForTwitch } from '../commands/multiCommandHandler';
import { executeShoutoutForTwitch } from '../commands/shoutoutHandler';
import { handleCommand } from '../commands/commandRouter';
import { executeCountdownForTwitch } from '../commands/countdownHandler';
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
  channelId?: string | null;
  sourceChannelId?: string | null;
} = {}): any {
  return {
    userInfo: {
      isMod: overrides.isMod ?? false,
      isVip: overrides.isVip ?? false,
      isBroadcaster: overrides.isBroadcaster ?? false,
      displayName: overrides.displayName,
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

// ─── Lifecycle ────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  resetMockClient();
  clearHandlerArrays();
  twitchChannelMembership.setTmiClient(null);
  twitchChannelMembership.setConnected(false);
  vi.useFakeTimers();
  __resetTwitchSendQueueForTests();
  __resetTwitchPrivilegedChannelsForTests();
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
    expect(executeCustomCommandForTwitch).toHaveBeenCalledWith('streamer', 'hello', 'alice');
    expect(recordChatMessage).toHaveBeenCalledWith('streamer');
  });

  it('records chat activity for a normal message', () => {
    sendMessage('#streamer', 'alice', 'hello');
    expect(recordChatMessage).toHaveBeenCalledWith('streamer');
  });

  it('dispatches all six executors for a normal message', async () => {
    vi.mocked(executeCustomCommandForTwitch).mockResolvedValue(undefined);
    vi.mocked(executeCounterCommandForTwitch).mockResolvedValue(undefined);
    vi.mocked(executeMultiCommandForTwitch).mockResolvedValue(undefined);
    vi.mocked(executeShoutoutForTwitch).mockResolvedValue(undefined);
    vi.mocked(handleCommand).mockResolvedValue(undefined);
    vi.mocked(executeCountdownForTwitch).mockResolvedValue(undefined);

    sendMessage('#streamer', 'alice', '!cmd', { displayName: 'Alice' });

    expect(executeCustomCommandForTwitch).toHaveBeenCalledOnce();
    expect(executeCounterCommandForTwitch).toHaveBeenCalledOnce();
    expect(executeMultiCommandForTwitch).toHaveBeenCalledOnce();
    expect(executeShoutoutForTwitch).toHaveBeenCalledOnce();
    // Guild resolution (Twitch-channel → discord_id → active voice guild) runs
    // asynchronously before handleCommand is invoked.
    await vi.waitFor(() => expect(handleCommand).toHaveBeenCalledOnce());
    expect(handleCommand).toHaveBeenCalledWith('!cmd', 'twitch', 'guild-A');
    expect(executeCountdownForTwitch).toHaveBeenCalledOnce();
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
    expect(handleCommand).toHaveBeenCalledWith('!cmd', 'twitch', null);
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
    expect(executeCustomCommandForTwitch).toHaveBeenCalledWith('streamer', '!clap', 'Alice');
  });

  it('falls back to the login username when userInfo.displayName is absent', () => {
    vi.mocked(executeCustomCommandForTwitch).mockResolvedValue(undefined);
    sendMessage('#streamer', 'alice', '!hi');
    expect(executeCustomCommandForTwitch).toHaveBeenCalledWith('streamer', '!hi', 'alice');
  });

  it('detects isMod=true from userInfo.isMod', () => {
    vi.mocked(executeShoutoutForTwitch).mockResolvedValue(undefined);
    sendMessage('#streamer', 'alice', '!so alice', { isMod: true });
    expect(executeShoutoutForTwitch).toHaveBeenCalledWith('streamer', '!so alice', 'alice', true);
  });

  it('detects isMod=true from userInfo.isBroadcaster', () => {
    vi.mocked(executeShoutoutForTwitch).mockResolvedValue(undefined);
    sendMessage('#streamer', 'alice', '!so alice', { isBroadcaster: true });
    expect(executeShoutoutForTwitch).toHaveBeenCalledWith('streamer', '!so alice', 'alice', true);
  });

  it('passes isMod=false when neither isMod nor isBroadcaster is set', () => {
    vi.mocked(executeShoutoutForTwitch).mockResolvedValue(undefined);
    sendMessage('#streamer', 'alice', '!so alice');
    expect(executeShoutoutForTwitch).toHaveBeenCalledWith('streamer', '!so alice', 'alice', false);
  });
});

// ─── joinTwitchChannel ────────────────────────────────────────────────────────

describe('joinTwitchChannel', () => {
  it('throws for an invalid channel name', async () => {
    await connectBot();
    await expect(joinTwitchChannel('!!bad')).rejects.toThrow('Invalid channel name');
  });

  it('queues the channel locally when the client is not yet connected', async () => {
    // A client can be assigned before the connection is confirmed (e.g. while startTwitchBot's
    // connectAndWait is still pending) — drive that state directly via the same setters
    // startTwitchBot itself uses, rather than racing an unawaited startTwitchBot() call.
    twitchChannelMembership.setTmiClient(mockClient as any);
    twitchChannelMembership.setConnected(false);

    await joinTwitchChannel('streamer');

    expect(getActiveChannels().has('streamer')).toBe(true);
    expect(vi.mocked(setTwitchChannel)).toHaveBeenCalledWith('streamer', false);
    expect(mockClient.join).not.toHaveBeenCalled();
  });

  it('syncs state without calling client.join when already joined', async () => {
    await connectBot();
    mockClient.currentChannels = ['streamer'];

    await joinTwitchChannel('streamer');

    expect(mockClient.join).not.toHaveBeenCalled();
    expect(getActiveChannels().has('streamer')).toBe(true);
    expect(vi.mocked(setTwitchChannel)).toHaveBeenCalledWith('streamer', true);
  });

  it('calls client.join and marks the channel connected on success', async () => {
    await connectBot();
    vi.mocked(getUsers).mockResolvedValue([]);

    await joinTwitchChannel('streamer');

    expect(mockClient.join).toHaveBeenCalledWith('streamer');
    expect(getActiveChannels().has('streamer')).toBe(true);
    expect(vi.mocked(setTwitchChannel)).toHaveBeenCalledWith('streamer', true);
  });

  it('caches the channel user ID after a successful join', async () => {
    await connectBot();
    vi.mocked(getUsers).mockResolvedValue([{ login: 'streamer', id: 'uid42' } as any]);

    await joinTwitchChannel('streamer');
    await Promise.resolve(); // flush the fire-and-forget getUsers promise

    expect(getActiveChannelUserIds().get('streamer')).toBe('uid42');
  });

  it('rolls back activeChannels and status when client.join throws', async () => {
    await connectBot();
    mockClient.join.mockRejectedValue(new Error('join failed'));

    await expect(joinTwitchChannel('streamer')).rejects.toThrow('join failed');

    expect(getActiveChannels().has('streamer')).toBe(false);
    expect(vi.mocked(setTwitchChannel)).toHaveBeenCalledWith('streamer', false);
  });

  it('invokes the channelJoined hook after a successful join', async () => {
    await connectBot();
    const hook = vi.fn();
    setChannelJoinedHook(hook);

    await joinTwitchChannel('streamer');

    expect(hook).toHaveBeenCalledWith('streamer');
  });

  it('normalizes the channel name before joining', async () => {
    await connectBot();

    await joinTwitchChannel('#STREAMER');

    expect(mockClient.join).toHaveBeenCalledWith('streamer');
    expect(getActiveChannels().has('streamer')).toBe(true);
  });

  it('fires the channel-joined hook when already joined', async () => {
    await connectBot();
    const hook = vi.fn();
    setChannelJoinedHook(hook);
    mockClient.currentChannels = ['streamer'];

    await joinTwitchChannel('streamer');

    expect(hook).toHaveBeenCalledWith('streamer');
  });

  it('caches the user ID when already joined', async () => {
    await connectBot();
    vi.mocked(getUsers).mockResolvedValue([{ login: 'streamer', id: 'uid99' } as any]);
    mockClient.currentChannels = ['streamer'];

    await joinTwitchChannel('streamer');
    await Promise.resolve(); // flush cacheChannelUserId

    expect(getActiveChannelUserIds().get('streamer')).toBe('uid99');
  });

  it('caches the user ID when queuing a channel while disconnected', async () => {
    vi.mocked(getUsers).mockResolvedValue([{ login: 'streamer', id: 'uid77' } as any]);
    twitchChannelMembership.setTmiClient(mockClient as any);
    twitchChannelMembership.setConnected(false);

    await joinTwitchChannel('streamer');
    await Promise.resolve(); // flush cacheChannelUserId

    expect(getActiveChannelUserIds().get('streamer')).toBe('uid77');
  });
});

// ─── partTwitchChannel ───────────────────────────────────────────────────────

describe('partTwitchChannel', () => {
  it('does nothing for an invalid channel name', async () => {
    await connectBot();
    await partTwitchChannel('!!bad');
    expect(mockClient.part).not.toHaveBeenCalled();
  });

  it('does nothing when the channel is neither active nor already joined', async () => {
    await connectBot();
    await partTwitchChannel('streamer');
    expect(mockClient.part).not.toHaveBeenCalled();
    expect(vi.mocked(setTwitchChannel)).not.toHaveBeenCalledWith('streamer', false);
  });

  it('removes local state only when the client is not connected', async () => {
    twitchChannelMembership.setTmiClient(mockClient as any);
    twitchChannelMembership.setConnected(false);
    await joinTwitchChannel('streamer'); // queued into activeChannels

    await partTwitchChannel('streamer');

    expect(getActiveChannels().has('streamer')).toBe(false);
    expect(mockClient.part).not.toHaveBeenCalled();
  });

  it('calls client.part when the channel is active and already joined', async () => {
    await connectBot();
    vi.mocked(getUsers).mockResolvedValue([]);
    await joinTwitchChannel('streamer');
    mockClient.currentChannels = ['streamer'];

    await partTwitchChannel('streamer');

    expect(mockClient.part).toHaveBeenCalledWith('streamer');
    expect(getActiveChannels().has('streamer')).toBe(false);
    expect(vi.mocked(setTwitchChannel)).toHaveBeenCalledWith('streamer', false);
  });

  it('removes from activeChannels without calling part when not already joined', async () => {
    await connectBot();
    vi.mocked(getUsers).mockResolvedValue([]);
    await joinTwitchChannel('streamer');
    mockClient.currentChannels = []; // client reports no joined channels

    await partTwitchChannel('streamer');

    expect(mockClient.part).not.toHaveBeenCalled();
    expect(getActiveChannels().has('streamer')).toBe(false);
  });

  it('re-throws when client.part fails (state already cleaned up)', async () => {
    await connectBot();
    vi.mocked(getUsers).mockResolvedValue([]);
    await joinTwitchChannel('streamer');
    mockClient.currentChannels = ['streamer'];
    mockClient.part.mockImplementation(() => { throw new Error('part failed'); });

    await expect(partTwitchChannel('streamer')).rejects.toThrow('part failed');
    expect(getActiveChannels().has('streamer')).toBe(false);
  });

  it('removes the user ID from the cache on a successful part', async () => {
    await connectBot();
    vi.mocked(getUsers).mockResolvedValue([{ login: 'streamer', id: 'uid42' } as any]);
    await joinTwitchChannel('streamer');
    await Promise.resolve(); // flush cacheChannelUserId
    mockClient.currentChannels = ['streamer'];

    await partTwitchChannel('streamer');

    expect(getActiveChannelUserIds().has('streamer')).toBe(false);
  });

  it('does not write a stale user ID back if the channel was parted before getUsers resolved', async () => {
    await connectBot();
    let resolveGetUsers!: (val: any) => void;
    vi.mocked(getUsers).mockImplementationOnce(
      () => new Promise((resolve) => { resolveGetUsers = resolve; }),
    );
    await joinTwitchChannel('streamer'); // cacheChannelUserId fires but getUsers is pending
    mockClient.currentChannels = ['streamer'];
    await partTwitchChannel('streamer'); // removes from activeChannels before getUsers resolves

    resolveGetUsers([{ login: 'streamer', id: 'uid-stale' }]);
    await Promise.resolve(); // flush the .then

    expect(getActiveChannelUserIds().has('streamer')).toBe(false);
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
    await sayInChannel('#streamer', longMessage);
    expect(mockClient.irc.say).toHaveBeenCalledTimes(2);
    expect(mockClient.irc.say).toHaveBeenNthCalledWith(1, '#streamer', 'a'.repeat(490));
    expect(mockClient.irc.say).toHaveBeenNthCalledWith(2, '#streamer', 'b'.repeat(20));
  });

  it('splits a single token longer than the length limit, with no space to break on', async () => {
    await connectBot();
    await sayInChannel('#streamer', 'a'.repeat(600));
    const chunks = mockClient.irc.say.mock.calls.map((call) => call[1] as string);
    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((chunk) => { expect(chunk.length).toBeLessThanOrEqual(500); });
    expect(chunks.join('')).toBe('a'.repeat(600));
  });

  it('keeps an exact-500-character final remainder as one message, even though it contains a space', async () => {
    await connectBot();
    const message = `${'a'.repeat(500)} ${'b'.repeat(250)} ${'c'.repeat(249)}`;
    await sayInChannel('#streamer', message);
    const chunks = mockClient.irc.say.mock.calls.map((call) => call[1] as string);
    expect(chunks).toEqual(['a'.repeat(500), `${'b'.repeat(250)} ${'c'.repeat(249)}`]);
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
    const setTmiClientSpy = vi.spyOn(twitchChannelMembership, 'setTmiClient');

    const stopped = stopTwitchBot();
    await vi.advanceTimersByTimeAsync(DISCONNECT_TIMEOUT_MS);
    await stopped;

    expect(vi.mocked(setTwitchChannel)).toHaveBeenCalledWith('streamer', false);
    expect(getActiveChannels().size).toBe(0);
    expect(setTmiClientSpy).toHaveBeenCalledWith(null);
    setTmiClientSpy.mockRestore();

    // Client reference was cleared despite the hang: a second stop is a no-op
    // (mirrors the "no-op when never started" case) rather than awaiting the
    // still-hanging quit() again.
    mockClient.quit.mockClear();
    await stopTwitchBot();
    expect(mockClient.quit).not.toHaveBeenCalled();
  });
});

// ─── reconcileJoinedChannels (via onConnected) ────────────────────────────────
//
// startTwitchBot() itself only resolves once onAuthenticationSuccess fires (see connectAndWait),
// and that same event triggers onConnected's fire-and-forget reconcileJoinedChannels() call — so by the
// time `await startTwitchBot()` returns, the initial reconciliation has already been *kicked off*
// against whatever mockClient.currentChannels was at that moment. These tests set currentChannels
// up front, before starting the bot, rather than firing a separate synthetic reconnect afterward.

describe('reconcileJoinedChannels', () => {
  it('parts a joined channel that is not in activeChannels', async () => {
    vi.mocked(getTwitchEnabledChannels).mockResolvedValue([]);
    vi.mocked(getUsers).mockResolvedValue([]);
    mockClient.currentChannels = ['stale'];

    await startTwitchBot();
    await vi.runAllTimersAsync();

    expect(mockClient.part).toHaveBeenCalledWith('stale');
    expect(vi.mocked(setTwitchChannel)).toHaveBeenCalledWith('stale', false);
  });

  it('joins an activeChannels channel that the client is not yet joined to', async () => {
    vi.mocked(getTwitchEnabledChannels).mockResolvedValue(['streamer']);
    vi.mocked(getUsers).mockResolvedValue([]);
    mockClient.currentChannels = [];

    await startTwitchBot();
    await vi.runAllTimersAsync(); // advance JOIN_THROTTLE_MS

    expect(mockClient.join).toHaveBeenCalledWith('streamer');
    expect(vi.mocked(setTwitchChannel)).toHaveBeenCalledWith('streamer', true);
  });

  it('marks a channel online when it is in both activeChannels and the client', async () => {
    vi.mocked(getTwitchEnabledChannels).mockResolvedValue(['streamer']);
    vi.mocked(getUsers).mockResolvedValue([]);
    mockClient.currentChannels = ['streamer'];

    await startTwitchBot();
    await vi.runAllTimersAsync();

    expect(mockClient.part).not.toHaveBeenCalled();
    expect(mockClient.join).not.toHaveBeenCalled();
    expect(vi.mocked(setTwitchChannel)).toHaveBeenCalledWith('streamer', true);
  });

  it('refreshes the user ID cache for a channel confirmed live at connect time', async () => {
    vi.mocked(getTwitchEnabledChannels).mockResolvedValue(['streamer']);
    vi.mocked(getUsers)
      .mockResolvedValueOnce([]) // initializeActiveChannels — simulate failed startup cache
      .mockResolvedValue([{ login: 'streamer', id: 'uid-reconcile' } as any]);
    mockClient.currentChannels = ['streamer']; // already joined

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
    mockClient.currentChannels = []; // not yet joined

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
