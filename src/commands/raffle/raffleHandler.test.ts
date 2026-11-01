import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../db', () => ({
  adjustLoyaltyPointsBalance: vi.fn(),
  getLoyaltyPointsConfig: vi.fn(),
  isExcludedFromLoyaltyPoints: vi.fn(),
  MAX_LOYALTY_POINTS_BALANCE: 2_147_483_647,
}));

vi.mock('../customCommandHandler', () => ({ resolveSharedChatSessionId: vi.fn() }));

const { logErrorSpy, logInfoSpy } = vi.hoisted(() => ({ logErrorSpy: vi.fn(), logInfoSpy: vi.fn() }));
vi.mock('../../shared/logger', () => ({ createLogger: () => ({ info: logInfoSpy, error: logErrorSpy }) }));

import { adjustLoyaltyPointsBalance, getLoyaltyPointsConfig, isExcludedFromLoyaltyPoints } from '../../db';
import { resolveSharedChatSessionId } from '../customCommandHandler';
import {
  executeRaffleCommandForTwitch,
  parseRaffleAmount,
  registerRaffleTwitchRuntime,
  startRaffle,
  stopAllRaffles,
} from './raffleHandler';

const SEND = vi.fn();
const USER_IDS = new Map([['streamer', 'streamer-id']]);
const ENABLED_CONFIG = { enabled: true, pointsPerMessage: 1, cooldownSeconds: 60, pointsPerSub: 100, pointsPerGiftSub: 100 };

/** Sends a chat message through the handler as `user` in #streamer. */
function chat(user: string, message: string, isBroadcaster = false): Promise<void> {
  return executeRaffleCommandForTwitch({
    channel: 'streamer', streamerId: 7, message, userLogin: user, command: message.split(' ')[0]!.toLowerCase(), isBroadcaster,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  SEND.mockResolvedValue(undefined);
  registerRaffleTwitchRuntime({ send: SEND, getLoginUserIds: () => USER_IDS });
  vi.mocked(getLoyaltyPointsConfig).mockResolvedValue(ENABLED_CONFIG);
  vi.mocked(isExcludedFromLoyaltyPoints).mockResolvedValue(false);
  vi.mocked(adjustLoyaltyPointsBalance).mockResolvedValue(0);
  vi.mocked(resolveSharedChatSessionId).mockResolvedValue(null);
});

afterEach(() => {
  stopAllRaffles();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('parseRaffleAmount', () => {
  it.each([['100', 100], ['1K', 1000], ['1,000', 1000]])('accepts %j', (input, expected) => {
    expect(parseRaffleAmount(input)).toBe(expected);
  });

  it.each(['', '0', 'abc', '50%', '9999999999'])('rejects %j', (input) => {
    expect(parseRaffleAmount(input)).toBeNull();
  });
});

describe('!raffle', () => {
  it('lets the broadcaster start a raffle and announces it', async () => {
    await chat('streamer', '!raffle 1K', true);
    expect(SEND).toHaveBeenCalledExactlyOnceWith('streamer', expect.stringContaining('1,000 points up for grabs'));
    expect(SEND.mock.calls[0]![1]).not.toMatch(/shared chat/i);
  });

  it('warns about shared chat when the channel is in a shared-chat session', async () => {
    vi.mocked(resolveSharedChatSessionId).mockResolvedValue('session-1');
    await chat('streamer', '!raffle 100', true);
    expect(resolveSharedChatSessionId).toHaveBeenCalledWith('streamer-id');
    expect(SEND).toHaveBeenCalledWith('streamer', expect.stringContaining("shared chat don't count"));
  });

  it('treats a failed shared-chat lookup as not shared', async () => {
    vi.mocked(resolveSharedChatSessionId).mockRejectedValue(new Error('helix down'));
    await chat('streamer', '!raffle 100', true);
    expect(SEND.mock.calls[0]![1]).not.toMatch(/shared chat/i);
  });

  it('ignores !raffle from anyone but the broadcaster', async () => {
    await chat('alice', '!raffle 100');
    expect(SEND).not.toHaveBeenCalled();
    expect(getLoyaltyPointsConfig).not.toHaveBeenCalled();
  });

  it('replies with usage for a bad amount', async () => {
    await chat('streamer', '!raffle lots', true);
    expect(SEND).toHaveBeenCalledWith('streamer', expect.stringContaining('Usage: !raffle'));
  });

  it('says a raffle is already running, and when it ends', async () => {
    await chat('streamer', '!raffle 100', true);
    await vi.advanceTimersByTimeAsync(20_000);
    await chat('streamer', '!raffle 200', true);
    expect(SEND).toHaveBeenLastCalledWith('streamer', 'A raffle is already running. It ends in 40s.');
  });

  it('stays silent when loyalty points are disabled', async () => {
    vi.mocked(getLoyaltyPointsConfig).mockResolvedValue({ ...ENABLED_CONFIG, enabled: false });
    await chat('streamer', '!raffle 100', true);
    expect(SEND).not.toHaveBeenCalled();
  });

  it('ignores other commands and channels without a linked streamer', async () => {
    await chat('streamer', '!points', true);
    await executeRaffleCommandForTwitch({
      channel: 'streamer', streamerId: null, message: '!raffle 100', userLogin: 'streamer', command: '!raffle', isBroadcaster: true,
    });
    expect(SEND).not.toHaveBeenCalled();
  });
});

describe('raffle lifecycle', () => {
  it('posts reminders at 15, 30 and 45 seconds with the entry count', async () => {
    await chat('streamer', '!raffle 100', true);
    await chat('alice', '!join');
    await vi.advanceTimersByTimeAsync(15_000);
    expect(SEND).toHaveBeenLastCalledWith('streamer', expect.stringContaining('45s left'));
    expect(SEND.mock.lastCall![1]).toContain('Entries so far: 1.');
    await vi.advanceTimersByTimeAsync(15_000);
    expect(SEND).toHaveBeenLastCalledWith('streamer', expect.stringContaining('30s left'));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(SEND).toHaveBeenLastCalledWith('streamer', expect.stringContaining('15s left'));
    expect(SEND).toHaveBeenCalledTimes(4);
  });

  it('enters viewers silently and does not count duplicates, the broadcaster or excluded accounts', async () => {
    vi.mocked(isExcludedFromLoyaltyPoints).mockImplementation(async (_id, user) => user === 'nightbot');
    await chat('streamer', '!raffle 100', true);
    SEND.mockClear();
    await chat('Alice', '!join');
    await chat('alice', '!join');
    await chat('streamer', '!join', true);
    await chat('nightbot', '!join');
    expect(SEND).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(SEND.mock.lastCall![1]).toContain('Entries so far: 1.');
  });

  it('ignores !join when no raffle is running', async () => {
    await chat('alice', '!join');
    expect(isExcludedFromLoyaltyPoints).not.toHaveBeenCalled();
  });

  it('draws after 60 seconds and pays the single winner the whole prize', async () => {
    await chat('streamer', '!raffle 1K', true);
    await chat('alice', '!join');
    await chat('bob', '!join');
    vi.spyOn(Math, 'random').mockReturnValue(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(adjustLoyaltyPointsBalance).toHaveBeenCalledExactlyOnceWith(7, 'alice', 1000);
    expect(SEND).toHaveBeenLastCalledWith('streamer', '🎉 Raffle over! 2 entries, 1 winner: @alice wins 1,000 points!');
  });

  it('logs a single entrant as one entry', async () => {
    await chat('streamer', '!raffle 100', true);
    await chat('alice', '!join');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(logInfoSpy).toHaveBeenCalledWith('Raffle in streamer drew 1 winner(s) from 1 entry.');
  });

  it('ignores !raffle and !join in a channel name that cannot be normalised', async () => {
    const message = (text: string) => ({
      channel: 'not a channel!', streamerId: 7, message: text, userLogin: 'streamer', command: text.split(' ')[0]!, isBroadcaster: true,
    });
    await executeRaffleCommandForTwitch(message('!raffle 100'));
    await executeRaffleCommandForTwitch(message('!join'));
    expect(SEND).not.toHaveBeenCalled();
    expect(isExcludedFromLoyaltyPoints).not.toHaveBeenCalled();
  });

  it('splits the prize between several winners', async () => {
    await chat('streamer', '!raffle 100', true);
    for (const user of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) await chat(user, '!join');
    // 7 entrants → up to 3 winners; 0.9999 rolls the max and takes the last entrant each pick.
    vi.spyOn(Math, 'random').mockReturnValue(0.9999);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(adjustLoyaltyPointsBalance).toHaveBeenCalledTimes(3);
    // 100 between 3 winners: 33 each, the leftover point isn't given out.
    expect(vi.mocked(adjustLoyaltyPointsBalance).mock.calls.map((c) => c[2])).toEqual([33, 33, 33]);
    expect(SEND.mock.lastCall![1]).toContain('3 winners');
    expect(SEND.mock.lastCall![1]).toContain('win 33 points each!');
  });

  it('announces when nobody entered and pays nobody', async () => {
    await chat('streamer', '!raffle 100', true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(adjustLoyaltyPointsBalance).not.toHaveBeenCalled();
    expect(SEND).toHaveBeenLastCalledWith('streamer', 'Raffle over. Nobody entered, so no points were given out.');
  });

  it('keeps paying the other winners when one credit fails', async () => {
    await chat('streamer', '!raffle 100', true);
    for (const user of ['a', 'b', 'c', 'd']) await chat(user, '!join');
    vi.spyOn(Math, 'random').mockReturnValue(0.9999);
    vi.mocked(adjustLoyaltyPointsBalance).mockRejectedValueOnce(new Error('db down'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(adjustLoyaltyPointsBalance).toHaveBeenCalledTimes(2);
    expect(logErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to pay raffle winner'), expect.any(Error));
    expect(SEND.mock.lastCall![1]).toContain('2 winners');
  });

  it('ignores !join after the draw and allows a new raffle', async () => {
    await chat('streamer', '!raffle 100', true);
    await vi.advanceTimersByTimeAsync(60_000);
    await chat('alice', '!join');
    expect(isExcludedFromLoyaltyPoints).not.toHaveBeenCalled();
    expect(await startRaffle('streamer', 7, 50)).toBe('ok');
  });

  it('does not count a join whose exclusion lookup finishes after the draw', async () => {
    await chat('streamer', '!raffle 100', true);
    let release: (v: boolean) => void = () => undefined;
    vi.mocked(isExcludedFromLoyaltyPoints).mockReturnValueOnce(new Promise((r) => { release = r; }));
    const join = chat('alice', '!join');
    await vi.advanceTimersByTimeAsync(60_000);
    release(false);
    await join;
    expect(adjustLoyaltyPointsBalance).not.toHaveBeenCalled();
  });

  it('logs, rather than rejecting, when the draw itself fails', async () => {
    await chat('streamer', '!raffle 100', true);
    await chat('alice', '!join');
    vi.spyOn(Math, 'random').mockImplementation(() => { throw new Error('rng broke'); });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(logErrorSpy).toHaveBeenCalledWith('Failed to draw raffle in streamer:', expect.any(Error));
    expect(adjustLoyaltyPointsBalance).not.toHaveBeenCalled();
  });

  it('cancels open raffles on stopAllRaffles', async () => {
    await chat('streamer', '!raffle 100', true);
    stopAllRaffles();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(SEND).toHaveBeenCalledOnce();
  });

  it('logs and carries on when a reminder fails to send', async () => {
    await chat('streamer', '!raffle 100', true);
    SEND.mockRejectedValueOnce(new Error('irc down'));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(logErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to send raffle message'), expect.any(Error));
  });
});

describe('startRaffle', () => {
  it('returns chat_unavailable and cancels the raffle when the announcement fails', async () => {
    SEND.mockRejectedValueOnce(new Error('not connected'));
    expect(await startRaffle('streamer', 7, 100)).toBe('chat_unavailable');
    expect(await startRaffle('streamer', 7, 100)).toBe('ok');
  });

  it('leaves a newer raffle open when an older one\'s announcement fails after being cancelled', async () => {
    let failFirst: (err: Error) => void = () => undefined;
    SEND.mockReturnValueOnce(new Promise((_resolve, reject) => { failFirst = reject; }));
    const first = startRaffle('streamer', 7, 100);
    await vi.advanceTimersByTimeAsync(0);
    stopAllRaffles();
    expect(await startRaffle('streamer', 7, 200)).toBe('ok');
    failFirst(new Error('not connected'));
    expect(await first).toBe('chat_unavailable');
    expect(await startRaffle('streamer', 7, 300)).toBe('already_running');
  });

  it('skips the shared-chat lookup for a channel with no known Twitch user id', async () => {
    expect(await startRaffle('other', 7, 100)).toBe('ok');
    expect(resolveSharedChatSessionId).not.toHaveBeenCalled();
    expect(SEND.mock.calls[0]![1]).not.toMatch(/shared chat/i);
  });

  it('returns chat_unavailable when no Twitch runtime has been registered', async () => {
    vi.resetModules();
    const fresh = await import('./raffleHandler.js');
    expect(await fresh.startRaffle('streamer', 7, 100)).toBe('chat_unavailable');
    expect(logErrorSpy).toHaveBeenCalledWith('[Twitch] Failed to announce raffle in streamer:', expect.any(Error));
    expect(await fresh.startRaffle('streamer', 7, 100)).toBe('chat_unavailable');
  });

  it('returns chat_unavailable for an invalid channel name', async () => {
    expect(await startRaffle('not a channel!', 7, 100)).toBe('chat_unavailable');
  });

  it('returns already_running and points_disabled', async () => {
    expect(await startRaffle('#Streamer', 7, 100)).toBe('ok');
    expect(await startRaffle('streamer', 7, 100)).toBe('already_running');
    vi.mocked(getLoyaltyPointsConfig).mockResolvedValue(null);
    expect(await startRaffle('other', 8, 100)).toBe('points_disabled');
  });
});
