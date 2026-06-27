import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../shared/logger', () => ({ createLogger: () => ({ info: vi.fn(), error: vi.fn() }) }));

vi.mock('../db', () => ({
  getCustomCommandForDiscord: vi.fn(),
  getCustomCommandForTwitchChannel: vi.fn(),
}));

vi.mock('./commandMonitorStore', () => ({
  recordCommandTestEntry: vi.fn(),
}));

vi.mock('../twitch/twitchApi', () => ({
  getSharedChatSession: vi.fn().mockResolvedValue(null),
}));

vi.mock('../discord/discordUtils', () => ({
  isDiscordNotFoundError: vi.fn().mockReturnValue(false),
}));

vi.mock('../twitch/monitor/twitchMonitor', () => ({
  getMultiTwitchDataForChannel: vi.fn().mockReturnValue(null),
}));

import {
  executeCustomCommandForDiscord,
  executeCustomCommandForTwitch,
  registerTwitchChatRuntime,
  purgeExpiredSessionCache,
  resolveSharedChatSessionId,
  sessionCache,
} from './customCommandHandler';
import { getCustomCommandForDiscord, getCustomCommandForTwitchChannel } from '../db';
import { recordCommandTestEntry } from './commandMonitorStore';
import { isDiscordNotFoundError } from '../discord/discordUtils';
import { getMultiTwitchDataForChannel } from '../twitch/monitor/twitchMonitor';
import { getSharedChatSession } from '../twitch/twitchApi';

function mockMsg(content: string) {
  return {
    id: 'msg-1',
    content,
    guildId: 'guild-1',
    reply: vi.fn().mockResolvedValue(undefined),
  };
}

const mockRuntime = {
  send: vi.fn().mockResolvedValue(undefined),
  getActiveChannels: vi.fn<() => ReadonlySet<string>>().mockReturnValue(new Set()),
  getLoginUserIds: vi.fn<() => ReadonlyMap<string, string>>().mockReturnValue(new Map()),
};

beforeEach(() => {
  vi.clearAllMocks();
  mockRuntime.send.mockResolvedValue(undefined);
  mockRuntime.getActiveChannels.mockReturnValue(new Set());
  mockRuntime.getLoginUserIds.mockReturnValue(new Map());
  registerTwitchChatRuntime(mockRuntime);
});

// ─── Discord ──────────────────────────────────────────────────────────────────

describe('executeCustomCommandForDiscord', () => {
  it('does nothing for an empty message', async () => {
    const msg = mockMsg('');
    await executeCustomCommandForDiscord(msg as any);
    expect(vi.mocked(getCustomCommandForDiscord)).not.toHaveBeenCalled();
  });

  it('does nothing when the command is not found', async () => {
    vi.mocked(getCustomCommandForDiscord).mockResolvedValue(null);
    const msg = mockMsg('!unknown');
    await executeCustomCommandForDiscord(msg as any);
    expect(msg.reply).not.toHaveBeenCalled();
  });

  it('replies with the command output and records the entry', async () => {
    vi.mocked(getCustomCommandForDiscord).mockResolvedValue({
      output: 'Hello Discord!',
      is_multi_twitch: false,
    } as any);
    const msg = mockMsg('!hello');

    await executeCustomCommandForDiscord(msg as any, 'viewer1');

    expect(msg.reply).toHaveBeenCalledWith('Hello Discord!');
    expect(vi.mocked(recordCommandTestEntry)).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'discord', command: '!hello', user: 'viewer1' }),
    );
  });

  it('swallows Discord not-found errors on reply failure', async () => {
    vi.mocked(getCustomCommandForDiscord).mockResolvedValue({
      output: 'Hi!',
      is_multi_twitch: false,
    } as any);
    vi.mocked(isDiscordNotFoundError).mockReturnValue(true);
    const msg = mockMsg('!hi');
    msg.reply.mockRejectedValue(new Error('Unknown message'));

    await expect(executeCustomCommandForDiscord(msg as any)).resolves.toBeUndefined();
  });

  it('threads an explicit guildId into the override-aware lookup', async () => {
    vi.mocked(getCustomCommandForDiscord).mockResolvedValue({ output: 'Hi!', is_multi_twitch: false } as any);
    const msg = mockMsg('!hello');

    await executeCustomCommandForDiscord(msg as any, 'viewer1', 'explicit-guild');

    expect(vi.mocked(getCustomCommandForDiscord)).toHaveBeenCalledWith('!hello', 'explicit-guild');
  });

  it('falls back to the message guild when no guildId is passed', async () => {
    vi.mocked(getCustomCommandForDiscord).mockResolvedValue({ output: 'Hi!', is_multi_twitch: false } as any);
    const msg = mockMsg('!hello');

    await executeCustomCommandForDiscord(msg as any, 'viewer1');

    expect(vi.mocked(getCustomCommandForDiscord)).toHaveBeenCalledWith('!hello', 'guild-1');
  });

  it('does nothing when no guild context is available', async () => {
    const msg = { id: 'm', content: '!hello', guildId: null, reply: vi.fn() };

    await executeCustomCommandForDiscord(msg as any, 'viewer1');

    expect(vi.mocked(getCustomCommandForDiscord)).not.toHaveBeenCalled();
    expect(msg.reply).not.toHaveBeenCalled();
  });
});

// ─── Twitch ───────────────────────────────────────────────────────────────────

describe('executeCustomCommandForTwitch', () => {
  it('does nothing for an empty message', async () => {
    await executeCustomCommandForTwitch('#chan', '', null);
    expect(vi.mocked(getCustomCommandForTwitchChannel)).not.toHaveBeenCalled();
  });

  it('does nothing when the command is not registered for that channel', async () => {
    vi.mocked(getCustomCommandForTwitchChannel).mockResolvedValue(null);
    await executeCustomCommandForTwitch('#chan', '!missing', null);
    expect(mockRuntime.send).not.toHaveBeenCalled();
  });

  it('sends directly to the channel for a non-multi-twitch command', async () => {
    vi.mocked(getCustomCommandForTwitchChannel).mockResolvedValue({
      output: 'Hey Twitch!',
      is_multi_twitch: false,
    } as any);

    await executeCustomCommandForTwitch('#chan', '!hey', 'viewer1');

    expect(mockRuntime.send).toHaveBeenCalledWith('#chan', 'Hey Twitch!');
    expect(vi.mocked(recordCommandTestEntry)).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'twitch', channel: '#chan', user: 'viewer1' }),
    );
  });

  it('broadcasts to all active registered channels for a multi-twitch command', async () => {
    // Source channel is #a; #b is also active and has the command registered
    vi.mocked(getCustomCommandForTwitchChannel).mockResolvedValue({
      output: 'Multi!',
      is_multi_twitch: true,
    } as any);
    vi.mocked(getMultiTwitchDataForChannel).mockReturnValue({
      url: 'multitwitch.tv/a/b',
      participants: ['#a', '#b'],
    } as any);
    mockRuntime.getActiveChannels.mockReturnValue(new Set(['#a', '#b']));

    await executeCustomCommandForTwitch('#a', '!multi', null);

    expect(mockRuntime.send).toHaveBeenCalledWith('#a', 'Multi!');
    expect(mockRuntime.send).toHaveBeenCalledWith('#b', 'Multi!');
  });

  it('only sends to source channel when not in a multi-twitch group', async () => {
    vi.mocked(getCustomCommandForTwitchChannel).mockResolvedValue({
      output: 'Hi!',
      is_multi_twitch: true,
    } as any);
    vi.mocked(getMultiTwitchDataForChannel).mockReturnValue(null); // not in a group
    mockRuntime.getActiveChannels.mockReturnValue(new Set(['#a', '#b']));

    await executeCustomCommandForTwitch('#a', '!hi', null);

    // Falls back to source channel only
    expect(mockRuntime.send).toHaveBeenCalledTimes(1);
    expect(mockRuntime.send).toHaveBeenCalledWith('#a', 'Hi!');
  });
});

// ─── Session cache cleanup ────────────────────────────────────────────────────

describe('purgeExpiredSessionCache', () => {
  beforeEach(() => {
    sessionCache.clear();
  });

  it('removes entries whose expiry has passed', () => {
    const now = Date.now();
    sessionCache.set('user-expired', { sessionId: 'abc', expiry: now - 1 });
    sessionCache.set('user-fresh',   { sessionId: 'xyz', expiry: now + 60_000 });

    purgeExpiredSessionCache();

    expect(sessionCache.has('user-expired')).toBe(false);
    expect(sessionCache.has('user-fresh')).toBe(true);
  });

  it('leaves all entries intact when none have expired', () => {
    const now = Date.now();
    sessionCache.set('user-a', { sessionId: '1', expiry: now + 10_000 });
    sessionCache.set('user-b', { sessionId: '2', expiry: now + 20_000 });

    purgeExpiredSessionCache();

    expect(sessionCache.size).toBe(2);
  });

  it('empties the map when all entries have expired', () => {
    const past = Date.now() - 1000;
    sessionCache.set('user-a', { sessionId: '1', expiry: past });
    sessionCache.set('user-b', { sessionId: '2', expiry: past });

    purgeExpiredSessionCache();

    expect(sessionCache.size).toBe(0);
  });
});

// ─── resolveSharedChatSessionId ───────────────────────────────────────────────

describe('resolveSharedChatSessionId', () => {
  beforeEach(() => {
    sessionCache.clear();
    vi.mocked(getSharedChatSession).mockReset();
  });

  it('fetches and caches the session id on a cold cache', async () => {
    vi.mocked(getSharedChatSession).mockResolvedValue({ session_id: 'sess-1' } as any);

    const result = await resolveSharedChatSessionId('user-1');

    expect(result).toBe('sess-1');
    expect(getSharedChatSession).toHaveBeenCalledWith('user-1');
    expect(sessionCache.get('user-1')?.sessionId).toBe('sess-1');
  });

  it('caches a null session id and retries sooner on fetch failure', async () => {
    vi.mocked(getSharedChatSession).mockRejectedValue(new Error('helix down'));

    const result = await resolveSharedChatSessionId('user-1');

    expect(result).toBeNull();
    expect(sessionCache.get('user-1')?.sessionId).toBeNull();
  });

  it('returns the cached value without fetching while still fresh', async () => {
    sessionCache.set('user-1', { sessionId: 'cached', expiry: Date.now() + 60_000 });

    const result = await resolveSharedChatSessionId('user-1');

    expect(result).toBe('cached');
    expect(getSharedChatSession).not.toHaveBeenCalled();
  });

  it('serves the stale cached value immediately and refreshes in the background', async () => {
    sessionCache.set('user-1', { sessionId: 'stale', expiry: Date.now() - 1 });
    let resolveFetch: (v: any) => void;
    vi.mocked(getSharedChatSession).mockReturnValue(
      new Promise((resolve) => { resolveFetch = resolve; }),
    );

    const result = await resolveSharedChatSessionId('user-1');

    expect(result).toBe('stale');
    expect(getSharedChatSession).toHaveBeenCalledWith('user-1');

    resolveFetch!({ session_id: 'fresh' });
    await Promise.resolve();
    await Promise.resolve();

    expect(sessionCache.get('user-1')?.sessionId).toBe('fresh');
  });

  it('coalesces concurrent background refreshes for the same user into one call', async () => {
    sessionCache.set('user-1', { sessionId: 'stale', expiry: Date.now() - 1 });
    vi.mocked(getSharedChatSession).mockResolvedValue({ session_id: 'fresh' } as any);

    await Promise.all([
      resolveSharedChatSessionId('user-1'),
      resolveSharedChatSessionId('user-1'),
    ]);

    expect(getSharedChatSession).toHaveBeenCalledTimes(1);
  });

  it('keeps the last known value but shortens the retry window when a background refresh fails', async () => {
    sessionCache.set('user-1', { sessionId: 'stale', expiry: Date.now() - 1 });
    vi.mocked(getSharedChatSession).mockRejectedValue(new Error('helix down'));

    const before = Date.now();
    await resolveSharedChatSessionId('user-1');
    await Promise.resolve();
    await Promise.resolve();

    const entry = sessionCache.get('user-1');
    expect(entry?.sessionId).toBe('stale');
    // Pin the upper bound to the short retry window (5s), not just "before some later Date.now()",
    // so this fails if the implementation falls back to the much longer normal cache TTL instead.
    expect(entry!.expiry).toBeGreaterThan(before);
    expect(entry!.expiry).toBeLessThanOrEqual(before + 5_000);
  });
});
