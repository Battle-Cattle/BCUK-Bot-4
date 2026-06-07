import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Hoisted state (available inside vi.mock factories) ───────────────────────

const { mockClient, registeredHandlers } = vi.hoisted(() => {
  const handlers: Record<string, (...args: any[]) => any> = {};
  const client = {
    on: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    getChannels: vi.fn(),
    join: vi.fn(),
    part: vi.fn(),
    say: vi.fn(),
    channels: [] as string[],
  };
  return { mockClient: client, registeredHandlers: handlers };
});

// ─── Module mocks (must precede imports) ─────────────────────────────────────

// Must use a regular function (not an arrow) so `new tmi.Client()` works.
vi.mock('tmi.js', () => ({
  default: {
    Client: vi.fn(function MockTmiClient() { return mockClient; }),
  },
}));

vi.mock('../shared/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('../shared/config', () => ({
  TWITCH_USERNAME: 'testbot',
  TWITCH_OAUTH_TOKEN: 'oauth:test',
}));

vi.mock('../db', () => ({
  getTwitchEnabledChannels: vi.fn(),
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

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import {
  startTwitchBot,
  stopTwitchBot,
  sayInChannel,
} from './twitchBot';
import {
  joinTwitchChannel,
  partTwitchChannel,
  getActiveChannels,
  getActiveChannelUserIds,
  setChannelJoinedHook,
} from './twitchChannelMembership';
import { getTwitchEnabledChannels } from '../db';
import { getUsers } from './twitchApi';
import { setTwitchChannel } from '../shared/statusStore';
import { executeCustomCommandForTwitch } from '../commands/customCommandHandler';
import { executeCounterCommandForTwitch } from '../commands/counterHandler';
import { executeMultiCommandForTwitch } from '../commands/multiCommandHandler';
import { executeShoutoutForTwitch } from '../commands/shoutoutHandler';
import { handleCommand } from '../commands/commandRouter';
import { executeCountdownForTwitch } from '../commands/countdownHandler';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resetMockClient(): void {
  // Re-apply default implementations after vi.clearAllMocks() wipes call history
  // but preserves implementations — some tests override join/part/etc., so we
  // explicitly restore defaults here each time.
  mockClient.on.mockImplementation((event: string, handler: (...args: any[]) => any) => {
    registeredHandlers[event] = handler;
  });
  mockClient.connect.mockResolvedValue(undefined);
  mockClient.disconnect.mockResolvedValue(undefined);
  mockClient.getChannels.mockReturnValue([]);
  mockClient.join.mockResolvedValue(undefined);
  mockClient.part.mockResolvedValue(undefined);
  mockClient.say.mockResolvedValue(undefined);
}

/** Start the bot with an empty channel list and simulate a successful connection. */
async function connectBot(): Promise<void> {
  vi.mocked(getTwitchEnabledChannels).mockResolvedValue([]);
  vi.mocked(getUsers).mockResolvedValue([]);
  await startTwitchBot();
  // Simulate the IRC server acknowledging the connection.
  registeredHandlers['connected']('irc.twitch.tv', 6667);
  // Let reconcileJoinedChannels and queued microtasks settle.
  await Promise.resolve();
}

function makeTags(overrides: Record<string, any> = {}): any {
  return { mod: false, badges: null, ...overrides };
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  resetMockClient();
  for (const key of Object.keys(registeredHandlers)) delete registeredHandlers[key];
  vi.useFakeTimers();
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
    // Reset call history so only message-dispatch calls are visible to assertions.
    vi.clearAllMocks();
    resetMockClient();
  });

  function sendMessage(
    channel: string,
    msgTags: Record<string, any>,
    message: string,
    self = false,
  ): void {
    registeredHandlers['message'](channel, msgTags, message, self);
  }

  it('ignores self-messages', () => {
    sendMessage('#streamer', makeTags(), 'hello', true);
    expect(executeCustomCommandForTwitch).not.toHaveBeenCalled();
  });

  it('ignores messages for an invalid channel name', () => {
    sendMessage('!!bad', makeTags(), 'hello');
    expect(executeCustomCommandForTwitch).not.toHaveBeenCalled();
  });

  it('ignores messages for channels not in activeChannels', () => {
    sendMessage('#otherchan', makeTags(), 'hello');
    expect(executeCustomCommandForTwitch).not.toHaveBeenCalled();
  });

  it('ignores shared-chat messages that originated in a different channel', () => {
    sendMessage('#streamer', makeTags({ 'room-id': '111', 'source-room-id': '999' }), 'hello');
    expect(executeCustomCommandForTwitch).not.toHaveBeenCalled();
  });

  it('processes messages when source-room-id matches room-id', () => {
    vi.mocked(executeCustomCommandForTwitch).mockResolvedValue(undefined);
    sendMessage('#streamer', makeTags({ 'room-id': '111', 'source-room-id': '111' }), 'hello');
    expect(executeCustomCommandForTwitch).toHaveBeenCalledWith('streamer', 'hello', null);
  });

  it('dispatches all six executors for a normal message', () => {
    vi.mocked(executeCustomCommandForTwitch).mockResolvedValue(undefined);
    vi.mocked(executeCounterCommandForTwitch).mockResolvedValue(undefined);
    vi.mocked(executeMultiCommandForTwitch).mockResolvedValue(undefined);
    vi.mocked(executeShoutoutForTwitch).mockResolvedValue(undefined);
    vi.mocked(handleCommand).mockResolvedValue(undefined);
    vi.mocked(executeCountdownForTwitch).mockResolvedValue(undefined);

    sendMessage('#streamer', makeTags({ 'display-name': 'Alice' }), '!cmd');

    expect(executeCustomCommandForTwitch).toHaveBeenCalledOnce();
    expect(executeCounterCommandForTwitch).toHaveBeenCalledOnce();
    expect(executeMultiCommandForTwitch).toHaveBeenCalledOnce();
    expect(executeShoutoutForTwitch).toHaveBeenCalledOnce();
    expect(handleCommand).toHaveBeenCalledOnce();
    expect(executeCountdownForTwitch).toHaveBeenCalledOnce();
  });

  it('passes the normalized channel and message to executors', () => {
    vi.mocked(executeCustomCommandForTwitch).mockResolvedValue(undefined);
    sendMessage('#STREAMER', makeTags({ 'display-name': 'Alice' }), '!clap');
    expect(executeCustomCommandForTwitch).toHaveBeenCalledWith('streamer', '!clap', 'Alice');
  });

  it('falls back to username when display-name is absent', () => {
    vi.mocked(executeCustomCommandForTwitch).mockResolvedValue(undefined);
    sendMessage('#streamer', makeTags({ username: 'alice' }), '!hi');
    expect(executeCustomCommandForTwitch).toHaveBeenCalledWith('streamer', '!hi', 'alice');
  });

  it('passes null displayName when neither display-name nor username is present', () => {
    vi.mocked(executeCustomCommandForTwitch).mockResolvedValue(undefined);
    sendMessage('#streamer', makeTags(), '!hi');
    expect(executeCustomCommandForTwitch).toHaveBeenCalledWith('streamer', '!hi', null);
  });

  it('detects isMod=true from the mod tag', () => {
    vi.mocked(executeShoutoutForTwitch).mockResolvedValue(undefined);
    sendMessage('#streamer', makeTags({ mod: true }), '!so alice');
    expect(executeShoutoutForTwitch).toHaveBeenCalledWith('streamer', '!so alice', null, true);
  });

  it('detects isMod=true from the broadcaster badge', () => {
    vi.mocked(executeShoutoutForTwitch).mockResolvedValue(undefined);
    sendMessage('#streamer', makeTags({ badges: { broadcaster: '1' } }), '!so alice');
    expect(executeShoutoutForTwitch).toHaveBeenCalledWith('streamer', '!so alice', null, true);
  });

  it('passes isMod=false when neither mod nor broadcaster badge is set', () => {
    vi.mocked(executeShoutoutForTwitch).mockResolvedValue(undefined);
    sendMessage('#streamer', makeTags({ mod: false, badges: {} }), '!so alice');
    expect(executeShoutoutForTwitch).toHaveBeenCalledWith('streamer', '!so alice', null, false);
  });
});

// ─── joinTwitchChannel ────────────────────────────────────────────────────────

describe('joinTwitchChannel', () => {
  it('throws for an invalid channel name', async () => {
    await connectBot();
    await expect(joinTwitchChannel('!!bad')).rejects.toThrow('Invalid channel name');
  });

  it('queues the channel locally when the client is not yet connected', async () => {
    // startTwitchBot assigns client but 'connected' stays false until the event fires.
    vi.mocked(getTwitchEnabledChannels).mockResolvedValue([]);
    vi.mocked(getUsers).mockResolvedValue([]);
    await startTwitchBot();

    await joinTwitchChannel('streamer');

    expect(getActiveChannels().has('streamer')).toBe(true);
    expect(vi.mocked(setTwitchChannel)).toHaveBeenCalledWith('streamer', false);
    expect(mockClient.join).not.toHaveBeenCalled();
  });

  it('syncs state without calling client.join when already joined in tmi.js', async () => {
    await connectBot();
    mockClient.getChannels.mockReturnValue(['#streamer']);

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

  it('fires the channel-joined hook when already joined in tmi.js', async () => {
    await connectBot();
    const hook = vi.fn();
    setChannelJoinedHook(hook);
    mockClient.getChannels.mockReturnValue(['#streamer']);

    await joinTwitchChannel('streamer');

    expect(hook).toHaveBeenCalledWith('streamer');
  });

  it('caches the user ID when already joined in tmi.js', async () => {
    await connectBot();
    vi.mocked(getUsers).mockResolvedValue([{ login: 'streamer', id: 'uid99' } as any]);
    mockClient.getChannels.mockReturnValue(['#streamer']);

    await joinTwitchChannel('streamer');
    await Promise.resolve(); // flush cacheChannelUserId

    expect(getActiveChannelUserIds().get('streamer')).toBe('uid99');
  });

  it('caches the user ID when queuing a channel while disconnected', async () => {
    // startTwitchBot assigns the client but 'connected' stays false until the event fires.
    vi.mocked(getTwitchEnabledChannels).mockResolvedValue([]);
    vi.mocked(getUsers).mockResolvedValue([{ login: 'streamer', id: 'uid77' } as any]);
    await startTwitchBot();

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

  it('does nothing when the channel is neither active nor tmi-joined', async () => {
    await connectBot();
    await partTwitchChannel('streamer');
    expect(mockClient.part).not.toHaveBeenCalled();
    expect(vi.mocked(setTwitchChannel)).not.toHaveBeenCalledWith('streamer', false);
  });

  it('removes local state only when the client is not connected', async () => {
    // start without firing 'connected' so connected=false
    vi.mocked(getTwitchEnabledChannels).mockResolvedValue([]);
    vi.mocked(getUsers).mockResolvedValue([]);
    await startTwitchBot();
    await joinTwitchChannel('streamer'); // queued into activeChannels

    await partTwitchChannel('streamer');

    expect(getActiveChannels().has('streamer')).toBe(false);
    expect(mockClient.part).not.toHaveBeenCalled();
  });

  it('calls client.part when the channel is active and tmi-joined', async () => {
    await connectBot();
    vi.mocked(getUsers).mockResolvedValue([]);
    await joinTwitchChannel('streamer');
    mockClient.getChannels.mockReturnValue(['#streamer']);

    await partTwitchChannel('streamer');

    expect(mockClient.part).toHaveBeenCalledWith('streamer');
    expect(getActiveChannels().has('streamer')).toBe(false);
    expect(vi.mocked(setTwitchChannel)).toHaveBeenCalledWith('streamer', false);
  });

  it('removes from activeChannels without calling part when not tmi-joined', async () => {
    await connectBot();
    vi.mocked(getUsers).mockResolvedValue([]);
    await joinTwitchChannel('streamer');
    mockClient.getChannels.mockReturnValue([]); // tmi.js reports no joined channels

    await partTwitchChannel('streamer');

    expect(mockClient.part).not.toHaveBeenCalled();
    expect(getActiveChannels().has('streamer')).toBe(false);
  });

  it('re-throws when client.part fails (state already cleaned up)', async () => {
    await connectBot();
    vi.mocked(getUsers).mockResolvedValue([]);
    await joinTwitchChannel('streamer');
    mockClient.getChannels.mockReturnValue(['#streamer']);
    mockClient.part.mockRejectedValue(new Error('part failed'));

    await expect(partTwitchChannel('streamer')).rejects.toThrow('part failed');
    expect(getActiveChannels().has('streamer')).toBe(false);
  });

  it('removes the user ID from the cache on a successful part', async () => {
    await connectBot();
    vi.mocked(getUsers).mockResolvedValue([{ login: 'streamer', id: 'uid42' } as any]);
    await joinTwitchChannel('streamer');
    await Promise.resolve(); // flush cacheChannelUserId
    mockClient.getChannels.mockReturnValue(['#streamer']);

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
    mockClient.getChannels.mockReturnValue(['#streamer']);
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

  it('delegates to client.say with the normalized channel', async () => {
    await connectBot();
    await sayInChannel('#STREAMER', 'hello!');
    expect(mockClient.say).toHaveBeenCalledWith('streamer', 'hello!');
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

  it('re-throws when client.connect fails', async () => {
    vi.mocked(getTwitchEnabledChannels).mockResolvedValue([]);
    mockClient.connect.mockRejectedValue(new Error('connection refused'));

    await expect(startTwitchBot()).rejects.toThrow('connection refused');
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

  it('calls client.disconnect', async () => {
    await connectBot();

    await stopTwitchBot();

    expect(mockClient.disconnect).toHaveBeenCalledOnce();
  });

  it('is a no-op when the client was never started', async () => {
    await stopTwitchBot();
    expect(mockClient.disconnect).not.toHaveBeenCalled();
  });

  it('active channels remain visible to the disconnected handler during client.disconnect', async () => {
    await connectBot();
    vi.mocked(getUsers).mockResolvedValue([]);
    await joinTwitchChannel('streamer');
    // Make disconnect synchronously fire the 'disconnected' event, as tmi.js does in production.
    mockClient.disconnect.mockImplementation(async () => {
      registeredHandlers['disconnected']('Connection closed.');
    });
    vi.mocked(setTwitchChannel).mockClear();

    await stopTwitchBot();

    // onDisconnected must have seen 'streamer' and called setTwitchChannel.
    expect(vi.mocked(setTwitchChannel)).toHaveBeenCalledWith('streamer', false);
    // clearMembershipState runs after, so channels are gone.
    expect(getActiveChannels().size).toBe(0);
  });
});

// ─── reconcileJoinedChannels (via onConnected) ────────────────────────────────

describe('reconcileJoinedChannels', () => {
  it('parts a tmi.js-joined channel that is not in activeChannels', async () => {
    vi.mocked(getTwitchEnabledChannels).mockResolvedValue([]);
    vi.mocked(getUsers).mockResolvedValue([]);
    await startTwitchBot();
    mockClient.getChannels.mockReturnValue(['#stale']);

    registeredHandlers['connected']('irc.twitch.tv', 6667);
    await vi.runAllTimersAsync();

    expect(mockClient.part).toHaveBeenCalledWith('stale');
    expect(vi.mocked(setTwitchChannel)).toHaveBeenCalledWith('stale', false);
  });

  it('joins an activeChannels channel that tmi.js is not yet joined to', async () => {
    vi.mocked(getTwitchEnabledChannels).mockResolvedValue(['streamer']);
    vi.mocked(getUsers).mockResolvedValue([]);
    await startTwitchBot();
    mockClient.getChannels.mockReturnValue([]);

    registeredHandlers['connected']('irc.twitch.tv', 6667);
    await vi.runAllTimersAsync(); // advance JOIN_THROTTLE_MS

    expect(mockClient.join).toHaveBeenCalledWith('streamer');
    expect(vi.mocked(setTwitchChannel)).toHaveBeenCalledWith('streamer', true);
  });

  it('marks a channel online when it is in both activeChannels and tmi.js', async () => {
    vi.mocked(getTwitchEnabledChannels).mockResolvedValue(['streamer']);
    vi.mocked(getUsers).mockResolvedValue([]);
    await startTwitchBot();
    mockClient.getChannels.mockReturnValue(['#streamer']);

    registeredHandlers['connected']('irc.twitch.tv', 6667);
    await Promise.resolve();

    expect(mockClient.part).not.toHaveBeenCalled();
    expect(mockClient.join).not.toHaveBeenCalled();
    expect(vi.mocked(setTwitchChannel)).toHaveBeenCalledWith('streamer', true);
  });

  it('refreshes the user ID cache for a channel confirmed live by tmi.js on reconnect', async () => {
    vi.mocked(getTwitchEnabledChannels).mockResolvedValue(['streamer']);
    vi.mocked(getUsers)
      .mockResolvedValueOnce([]) // initializeActiveChannels — simulate failed startup cache
      .mockResolvedValue([{ login: 'streamer', id: 'uid-reconcile' } as any]);
    await startTwitchBot();
    mockClient.getChannels.mockReturnValue(['#streamer']); // tmi.js already joined

    registeredHandlers['connected']('irc.twitch.tv', 6667);
    await vi.runAllTimersAsync();
    await Promise.resolve(); // flush cacheChannelUserId .then

    expect(getActiveChannelUserIds().get('streamer')).toBe('uid-reconcile');
  });

  it('caches the user ID when joinMissingChannel joins a channel on reconnect', async () => {
    vi.mocked(getTwitchEnabledChannels).mockResolvedValue(['streamer']);
    vi.mocked(getUsers)
      .mockResolvedValueOnce([]) // initializeActiveChannels
      .mockResolvedValue([{ login: 'streamer', id: 'uid-join' } as any]);
    await startTwitchBot();
    mockClient.getChannels.mockReturnValue([]); // tmi.js not yet joined

    registeredHandlers['connected']('irc.twitch.tv', 6667);
    await vi.runAllTimersAsync(); // advance JOIN_THROTTLE_MS
    await Promise.resolve(); // flush cacheChannelUserId .then

    expect(getActiveChannelUserIds().get('streamer')).toBe('uid-join');
  });

  it('caches the user ID when joinMissingChannel finds the channel already joined', async () => {
    vi.mocked(getTwitchEnabledChannels).mockResolvedValue(['streamer']);
    vi.mocked(getUsers)
      .mockResolvedValueOnce([]) // initializeActiveChannels
      .mockResolvedValue([{ login: 'streamer', id: 'uid-prejoin' } as any]);
    await startTwitchBot();
    // Snapshot at reconcile start sees no joins; by the time joinMissingChannel
    // runs its isChannelJoined check, the channel is already joined.
    mockClient.getChannels.mockReturnValue([]);
    registeredHandlers['connected']('irc.twitch.tv', 6667);
    mockClient.getChannels.mockReturnValue(['#streamer']);
    await vi.runAllTimersAsync();
    await Promise.resolve(); // flush cacheChannelUserId .then

    expect(getActiveChannelUserIds().get('streamer')).toBe('uid-prejoin');
  });
});

// ─── onDisconnected ───────────────────────────────────────────────────────────

describe('onDisconnected', () => {
  it('marks all active channels offline', async () => {
    vi.mocked(getTwitchEnabledChannels).mockResolvedValue(['streamer']);
    vi.mocked(getUsers).mockResolvedValue([]);
    await startTwitchBot();
    vi.mocked(setTwitchChannel).mockClear();

    registeredHandlers['disconnected']('Connection closed.');

    expect(vi.mocked(setTwitchChannel)).toHaveBeenCalledWith('streamer', false);
  });

  it('clears the tmi.js channels array to prevent auto-rejoin', async () => {
    await connectBot();
    mockClient.channels = ['#streamer', '#other'];

    registeredHandlers['disconnected']('Connection closed.');

    expect(mockClient.channels).toEqual([]);
  });
});
