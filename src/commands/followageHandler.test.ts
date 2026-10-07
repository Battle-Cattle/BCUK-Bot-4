import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockLog } = vi.hoisted(() => ({ mockLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

vi.mock('../shared/logger', () => ({ createLogger: () => mockLog }));
vi.mock('../shared/config', () => ({ GLOBAL_COOLDOWN_MS: 3_000 }));
vi.mock('../twitch/twitchApi', () => ({ getUsers: vi.fn(), getChannelFollower: vi.fn() }));
vi.mock('../twitch/twitchUserTokens', () => ({ getValidToken: vi.fn() }));
vi.mock('../db', () => ({ getStreamerByTwitchUserId: vi.fn() }));

import { executeFollowageForTwitch, registerFollowageRuntime, formatFollowDuration } from './followageHandler';
import { getUsers, getChannelFollower } from '../twitch/twitchApi';
import { getValidToken } from '../twitch/twitchUserTokens';
import { getStreamerByTwitchUserId } from '../db';

const mockRuntime = { send: vi.fn() };
const STREAMER = { id: 1, twitch_user_id: 'bc1' } as any;

// Advanced per test so a cooldown claim left over from a previous test has already expired.
const COOLDOWN_MS = 3_000;
let mockNow = Date.UTC(2026, 9, 6, 12, 0, 0);

beforeEach(() => {
  mockNow += COOLDOWN_MS + 1_000;
  vi.useFakeTimers();
  vi.setSystemTime(mockNow);
  vi.clearAllMocks();
  mockRuntime.send.mockResolvedValue(undefined);
  registerFollowageRuntime(mockRuntime);
  vi.mocked(getStreamerByTwitchUserId).mockResolvedValue(STREAMER);
  vi.mocked(getValidToken).mockResolvedValue('user-token');
});

afterEach(() => vi.useRealTimers());

describe('formatFollowDuration', () => {
  const at = (iso: string) => new Date(iso);

  it('returns "less than a day" for under a day', () => {
    expect(formatFollowDuration(at('2026-01-01T00:00:00Z'), at('2026-01-01T23:59:00Z'))).toBe('less than a day');
  });

  it('returns "less than a day" when the follow date is in the future', () => {
    expect(formatFollowDuration(at('2026-01-02T00:00:00Z'), at('2026-01-01T00:00:00Z'))).toBe('less than a day');
  });

  it('formats years, months and days, pluralising and skipping zero parts', () => {
    expect(formatFollowDuration(at('2024-03-12T10:00:00Z'), at('2026-06-16T11:00:00Z'))).toBe('2 years, 3 months, 4 days');
    expect(formatFollowDuration(at('2025-03-12T10:00:00Z'), at('2026-03-13T10:00:00Z'))).toBe('1 year, 1 day');
  });

  it('counts exact months without a stray day', () => {
    expect(formatFollowDuration(at('2026-01-15T10:00:00Z'), at('2026-04-15T10:00:00Z'))).toBe('3 months');
  });

  it('does not count a month that has not fully elapsed by time of day', () => {
    expect(formatFollowDuration(at('2026-01-15T10:00:00Z'), at('2026-02-15T09:00:00Z'))).toBe('30 days');
  });

  it('clamps month-end follows to shorter months', () => {
    expect(formatFollowDuration(at('2026-01-31T00:00:00Z'), at('2026-02-28T00:00:00Z'))).toBe('1 month');
  });

  it('handles a leap-day follow', () => {
    expect(formatFollowDuration(at('2024-02-29T00:00:00Z'), at('2025-02-28T00:00:00Z'))).toBe('1 year');
    expect(formatFollowDuration(at('2024-02-29T00:00:00Z'), at('2025-03-01T00:00:00Z'))).toBe('1 year, 1 day');
  });
});

describe('executeFollowageForTwitch', () => {
  it('does nothing for other commands', async () => {
    await executeFollowageForTwitch('chan', '!other', 'bc1', { id: 'u1', name: 'Alice' });
    expect(getChannelFollower).not.toHaveBeenCalled();
    expect(mockRuntime.send).not.toHaveBeenCalled();
  });

  it('does nothing when the broadcaster ID is unknown', async () => {
    await executeFollowageForTwitch('chan', '!followage', null, { id: 'u1', name: 'Alice' });
    expect(mockRuntime.send).not.toHaveBeenCalled();
  });

  it("replies with the caller's follow age", async () => {
    vi.mocked(getChannelFollower).mockResolvedValue({
      user_id: 'u1', user_login: 'alice', user_name: 'Alice', followed_at: '2024-03-12T10:00:00Z',
    });

    await executeFollowageForTwitch('chan', '!followage', 'bc1', { id: 'u1', name: 'Alice' }, '!followage');

    expect(getStreamerByTwitchUserId).toHaveBeenCalledWith('bc1');
    expect(getChannelFollower).toHaveBeenCalledWith('bc1', 'u1', 'user-token');
    expect(getUsers).not.toHaveBeenCalled();
    expect(mockRuntime.send).toHaveBeenCalledWith(
      'chan',
      expect.stringMatching(/^@Alice has been following chan for 2 years, 6 months, \d+ days? \(since 12 Mar 2024\)\.$/),
    );
  });

  it('looks up a named @target instead of the caller', async () => {
    vi.mocked(getUsers).mockResolvedValue([{ login: 'bob', id: 'u2' }]);
    vi.mocked(getChannelFollower).mockResolvedValue(null);

    await executeFollowageForTwitch('chan', '!followage @Bob', 'bc1', { id: 'u1', name: 'Alice' });

    expect(getUsers).toHaveBeenCalledWith(['bob']);
    expect(getChannelFollower).toHaveBeenCalledWith('bc1', 'u2', 'user-token');
    expect(mockRuntime.send).toHaveBeenCalledWith('chan', "@bob isn't following chan.");
  });

  it('stays silent when a named target is not a Twitch user', async () => {
    vi.mocked(getUsers).mockResolvedValue([]);
    await executeFollowageForTwitch('chan', '!followage nobody', 'bc1', { id: 'u1', name: 'Alice' });
    expect(getChannelFollower).not.toHaveBeenCalled();
    expect(mockRuntime.send).not.toHaveBeenCalled();
  });

  it('replies that the broadcaster cannot follow themselves', async () => {
    await executeFollowageForTwitch('chan', '!followage', 'bc1', { id: 'bc1', name: 'Chan' });
    expect(getChannelFollower).not.toHaveBeenCalled();
    expect(mockRuntime.send).toHaveBeenCalledWith('chan', "chan can't follow themselves!");
  });

  it('stays silent and warns when the streamer has no usable token', async () => {
    vi.mocked(getValidToken).mockResolvedValue(null);
    await executeFollowageForTwitch('chan', '!followage', 'bc1', { id: 'u1', name: 'Alice' });
    expect(getChannelFollower).not.toHaveBeenCalled();
    expect(mockRuntime.send).not.toHaveBeenCalled();
    expect(mockLog.warn).toHaveBeenCalled();
  });

  it('stays silent when the channel has no streamer row', async () => {
    vi.mocked(getStreamerByTwitchUserId).mockResolvedValue(null);
    await executeFollowageForTwitch('chan', '!followage', 'bc1', { id: 'u1', name: 'Alice' });
    expect(getValidToken).not.toHaveBeenCalled();
    expect(mockRuntime.send).not.toHaveBeenCalled();
  });

  it('logs instead of throwing when the Helix call fails', async () => {
    vi.mocked(getChannelFollower).mockRejectedValue(new Error('[TwitchAPI] getChannelFollower failed: 403'));
    await expect(executeFollowageForTwitch('chan', '!followage', 'bc1', { id: 'u1', name: 'Alice' })).resolves.toBeUndefined();
    expect(mockRuntime.send).not.toHaveBeenCalled();
    expect(mockLog.error).toHaveBeenCalled();
  });

  it('is throttled per channel', async () => {
    vi.mocked(getChannelFollower).mockResolvedValue(null);
    await executeFollowageForTwitch('chan-a', '!followage', 'bc1', { id: 'u1', name: 'Alice' });
    await executeFollowageForTwitch('chan-a', '!followage', 'bc1', { id: 'u1', name: 'Alice' });
    await executeFollowageForTwitch('chan-b', '!followage', 'bc1', { id: 'u1', name: 'Alice' });
    expect(mockRuntime.send).toHaveBeenCalledTimes(2);
  });
});
