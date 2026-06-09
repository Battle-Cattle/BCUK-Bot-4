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
  sessionCache,
} from './customCommandHandler';
import { getCustomCommandForDiscord, getCustomCommandForTwitchChannel } from '../db';
import { recordCommandTestEntry } from './commandMonitorStore';
import { isDiscordNotFoundError } from '../discord/discordUtils';
import { getMultiTwitchDataForChannel } from '../twitch/monitor/twitchMonitor';

function mockMsg(content: string) {
  return {
    id: 'msg-1',
    content,
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
