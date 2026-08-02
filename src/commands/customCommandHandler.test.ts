import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../test-utils/loggerMock';

vi.mock('../shared/logger', () => ({ createLogger: mockLogger }));

vi.mock('../shared/config', () => ({ GLOBAL_COOLDOWN_MS: 3_000 }));

vi.mock('../db', () => ({
  getCustomCommandForDiscord: vi.fn(),
  getCustomCommandForTwitchChannel: vi.fn(),
}));

vi.mock('../twitch/twitchApi', () => ({
  getSharedChatSession: vi.fn().mockResolvedValue(null),
}));

vi.mock('../discord/discordUtils', () => ({
  isDiscordNotFoundError: vi.fn().mockReturnValue(false),
}));

import {
  executeCustomCommandForDiscord,
  executeCustomCommandForTwitch,
  registerTwitchChatRuntime,
  purgeExpiredSessionCache,
  resolveSharedChatSessionId,
  sessionCache,
  forgetGuildCustomCommandCooldown,
} from './customCommandHandler';
import { getCustomCommandForDiscord, getCustomCommandForTwitchChannel } from '../db';
import { isDiscordNotFoundError } from '../discord/discordUtils';
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
  getMultiTwitchDataForChannel: vi.fn().mockReturnValue(null),
};

// Base time far in the future so `Date.now() - 0` always exceeds GLOBAL_COOLDOWN_MS
// at the start of each test. Each beforeEach adds enough to expire any previous claim,
// matching the pattern in commandRouter.test.ts.
const COOLDOWN_MS = 3_000;
let mockNow = 1_000_000_000_000;

beforeEach(() => {
  mockNow += COOLDOWN_MS + 1_000;
  vi.clearAllMocks();
  vi.spyOn(Date, 'now').mockReturnValue(mockNow);
  mockRuntime.send.mockResolvedValue(undefined);
  mockRuntime.getActiveChannels.mockReturnValue(new Set());
  mockRuntime.getLoginUserIds.mockReturnValue(new Map());
  mockRuntime.getMultiTwitchDataForChannel.mockReturnValue(null);
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

  it('replies with the command output', async () => {
    vi.mocked(getCustomCommandForDiscord).mockResolvedValue({
      output: 'Hello Discord!',
      is_multi_twitch: false,
    } as any);
    const msg = mockMsg('!hello');

    await executeCustomCommandForDiscord(msg as any, 'viewer1');

    expect(msg.reply).toHaveBeenCalledWith('Hello Discord!');
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

  it('substitutes {user}, {args}, and {arg} in the response before replying', async () => {
    vi.mocked(getCustomCommandForDiscord).mockResolvedValue({
      output: '{user} said {args} (first: {arg})',
      is_multi_twitch: false,
    } as any);
    const msg = mockMsg('!hello foo bar');

    await executeCustomCommandForDiscord(msg as any, 'viewer1');

    const expected = 'viewer1 said foo bar (first: foo)';
    expect(msg.reply).toHaveBeenCalledWith(expected);
  });

  it('substitutes an unknown placeholder with an empty string', async () => {
    vi.mocked(getCustomCommandForDiscord).mockResolvedValue({
      output: 'Hi {user}, unknown: [{nope}]',
      is_multi_twitch: false,
    } as any);
    const msg = mockMsg('!hello');

    await executeCustomCommandForDiscord(msg as any, 'viewer1');

    expect(msg.reply).toHaveBeenCalledWith('Hi viewer1, unknown: []');
  });

  it('substitutes {args} and {arg} as empty strings when no args are given', async () => {
    vi.mocked(getCustomCommandForDiscord).mockResolvedValue({
      output: 'args=[{args}] arg=[{arg}]',
      is_multi_twitch: false,
    } as any);
    const msg = mockMsg('!hello');

    await executeCustomCommandForDiscord(msg as any, 'viewer1');

    expect(msg.reply).toHaveBeenCalledWith('args=[] arg=[]');
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
  });

  it('broadcasts to all active registered channels for a multi-twitch command', async () => {
    // Source channel is #a; #b is also active and has the command registered
    vi.mocked(getCustomCommandForTwitchChannel).mockResolvedValue({
      output: 'Multi!',
      is_multi_twitch: true,
    } as any);
    mockRuntime.getMultiTwitchDataForChannel.mockReturnValue({
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
    mockRuntime.getMultiTwitchDataForChannel.mockReturnValue(null); // not in a group
    mockRuntime.getActiveChannels.mockReturnValue(new Set(['#a', '#b']));

    await executeCustomCommandForTwitch('#a', '!hi', null);

    // Falls back to source channel only
    expect(mockRuntime.send).toHaveBeenCalledTimes(1);
    expect(mockRuntime.send).toHaveBeenCalledWith('#a', 'Hi!');
  });

  it('substitutes {user}, {args}, and {arg} in the response before sending', async () => {
    vi.mocked(getCustomCommandForTwitchChannel).mockResolvedValue({
      output: '{user} said {args} (first: {arg})',
      is_multi_twitch: false,
    } as any);

    await executeCustomCommandForTwitch('#chan', '!hey foo bar', 'viewer1');

    const expected = 'viewer1 said foo bar (first: foo)';
    expect(mockRuntime.send).toHaveBeenCalledWith('#chan', expected);
  });

  it('substitutes an unknown placeholder with an empty string', async () => {
    vi.mocked(getCustomCommandForTwitchChannel).mockResolvedValue({
      output: 'Hi {user}, unknown: [{nope}]',
      is_multi_twitch: false,
    } as any);

    await executeCustomCommandForTwitch('#chan', '!hey', 'viewer1');

    expect(mockRuntime.send).toHaveBeenCalledWith('#chan', 'Hi viewer1, unknown: []');
  });

  it('substitutes {args} and {arg} as empty strings when no args are given', async () => {
    vi.mocked(getCustomCommandForTwitchChannel).mockResolvedValue({
      output: 'args=[{args}] arg=[{arg}]',
      is_multi_twitch: false,
    } as any);

    await executeCustomCommandForTwitch('#chan', '!hey', 'viewer1');

    expect(mockRuntime.send).toHaveBeenCalledWith('#chan', 'args=[] arg=[]');
  });

  it('only checks registration for channels in the active multi-twitch group, not every active channel', async () => {
    // Source channel is #a; #b is in the group, #c is active but not in the group.
    vi.mocked(getCustomCommandForTwitchChannel).mockResolvedValue({
      output: 'Multi!',
      is_multi_twitch: true,
    } as any);
    mockRuntime.getMultiTwitchDataForChannel.mockReturnValue({
      url: 'multitwitch.tv/a/b',
      participants: ['#a', '#b'],
    } as any);
    mockRuntime.getActiveChannels.mockReturnValue(new Set(['#a', '#b', '#c']));

    await executeCustomCommandForTwitch('#a', '!multi', null);

    expect(mockRuntime.send).toHaveBeenCalledWith('#a', 'Multi!');
    expect(mockRuntime.send).toHaveBeenCalledWith('#b', 'Multi!');
    expect(mockRuntime.send).not.toHaveBeenCalledWith('#c', 'Multi!');
    const checkedChannels = vi.mocked(getCustomCommandForTwitchChannel).mock.calls.map((call) => call[0]);
    expect(checkedChannels).toContain('#a');
    expect(checkedChannels).toContain('#b');
    expect(checkedChannels).not.toContain('#c');
  });

  it('reuses the same filled response for every channel in a multi-twitch broadcast', async () => {
    vi.mocked(getCustomCommandForTwitchChannel).mockResolvedValue({
      output: '{user} said {args}',
      is_multi_twitch: true,
    } as any);
    mockRuntime.getMultiTwitchDataForChannel.mockReturnValue({
      url: 'multitwitch.tv/a/b',
      participants: ['#a', '#b'],
    } as any);
    mockRuntime.getActiveChannels.mockReturnValue(new Set(['#a', '#b']));

    await executeCustomCommandForTwitch('#a', '!multi hello there', 'viewer1');

    const expected = 'viewer1 said hello there';
    expect(mockRuntime.send).toHaveBeenCalledWith('#a', expected);
    expect(mockRuntime.send).toHaveBeenCalledWith('#b', expected);
  });
});

// ─── Cooldown ─────────────────────────────────────────────────────────────────

describe('custom-command cooldown', () => {
  it('blocks a second Discord custom command in the same guild within the cooldown window', async () => {
    vi.mocked(getCustomCommandForDiscord).mockResolvedValue({ output: 'Hi!', is_multi_twitch: false } as any);

    const msg1 = mockMsg('!hello');
    await executeCustomCommandForDiscord(msg1 as any, 'viewer1');
    expect(msg1.reply).toHaveBeenCalledTimes(1);

    // Same timestamp — cooldown has not elapsed
    const msg2 = mockMsg('!hello');
    await executeCustomCommandForDiscord(msg2 as any, 'viewer1');
    expect(msg2.reply).not.toHaveBeenCalled();
  });

  it("does not apply one Discord guild's cooldown to another guild", async () => {
    vi.mocked(getCustomCommandForDiscord).mockResolvedValue({ output: 'Hi!', is_multi_twitch: false } as any);

    const msg1 = mockMsg('!hello');
    await executeCustomCommandForDiscord(msg1 as any, 'viewer1');
    expect(msg1.reply).toHaveBeenCalledTimes(1);

    const msg2 = { ...mockMsg('!hello'), guildId: 'guild-2' };
    await executeCustomCommandForDiscord(msg2 as any, 'viewer1');
    expect(msg2.reply).toHaveBeenCalledTimes(1);
  });

  it("forgetGuildCustomCommandCooldown resets a guild's cooldown so a subsequent command fires immediately", async () => {
    vi.mocked(getCustomCommandForDiscord).mockResolvedValue({ output: 'Hi!', is_multi_twitch: false } as any);

    const msg1 = mockMsg('!hello');
    await executeCustomCommandForDiscord(msg1 as any, 'viewer1');
    expect(msg1.reply).toHaveBeenCalledTimes(1);

    forgetGuildCustomCommandCooldown('guild-1');

    const msg2 = mockMsg('!hello');
    await executeCustomCommandForDiscord(msg2 as any, 'viewer1');
    expect(msg2.reply).toHaveBeenCalledTimes(1);
  });

  it('forgetGuildCustomCommandCooldown is a no-op for a guild with no state', () => {
    expect(() => forgetGuildCustomCommandCooldown('never-seen')).not.toThrow();
  });

  it('blocks a second Twitch custom command in the same channel within the cooldown window', async () => {
    vi.mocked(getCustomCommandForTwitchChannel).mockResolvedValue({ output: 'Hey!', is_multi_twitch: false } as any);

    await executeCustomCommandForTwitch('#chan', '!hey', 'viewer1');
    expect(mockRuntime.send).toHaveBeenCalledTimes(1);

    await executeCustomCommandForTwitch('#chan', '!hey', 'viewer1');
    expect(mockRuntime.send).toHaveBeenCalledTimes(1);
  });

  it("does not apply one Twitch channel's cooldown to another channel", async () => {
    vi.mocked(getCustomCommandForTwitchChannel).mockResolvedValue({ output: 'Hey!', is_multi_twitch: false } as any);

    await executeCustomCommandForTwitch('#chan-a', '!hey', 'viewer1');
    expect(mockRuntime.send).toHaveBeenCalledTimes(1);

    await executeCustomCommandForTwitch('#chan-b', '!hey', 'viewer1');
    expect(mockRuntime.send).toHaveBeenCalledTimes(2);
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
    const after = Date.now();

    const entry = sessionCache.get('user-1');
    expect(entry?.sessionId).toBe('stale');
    // Pin the bounds to the short retry window (5s) bracketed by [before, after], not just
    // "before some later Date.now()", so this fails if the implementation falls back to the
    // much longer normal cache TTL instead — while tolerating slow-CI timing jitter.
    expect(entry!.expiry).toBeGreaterThanOrEqual(before + 5_000);
    expect(entry!.expiry).toBeLessThanOrEqual(after + 5_000);
  });
});
