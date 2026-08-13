import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../test-utils/loggerMock';

vi.mock('../shared/logger', () => ({ createLogger: mockLogger }));

vi.mock('../shared/config', () => ({ GLOBAL_COOLDOWN_MS: 3_000 }));

vi.mock('../db', () => ({
  findCounterByCommand: vi.fn(),
  incrementCounter: vi.fn(),
}));

vi.mock('../discord/discordUtils', () => ({
  isDiscordNotFoundError: vi.fn().mockReturnValue(false),
  NO_MENTIONS: { parse: [] },
}));

import {
  executeCounterCommandForDiscord,
  executeCounterCommandForTwitch,
  registerCounterTwitchRuntime,
  forgetGuildCounterCooldown,
} from './counterHandler';
import { findCounterByCommand, incrementCounter } from '../db';

type MockCounter = {
  id: number;
  matchType: 'trigger' | 'check';
  current_value: number;
  increment_message: string;
  message: string;
};

const TRIGGER_COUNTER: MockCounter = {
  id: 1,
  matchType: 'trigger',
  current_value: 4,
  increment_message: 'Count is now %d!',
  message: 'Current count: %d',
};

const CHECK_COUNTER: MockCounter = {
  id: 2,
  matchType: 'check',
  current_value: 7,
  increment_message: 'Count is now %d!',
  message: 'Current count: %d',
};

function makeMockMessage(content: string, overrides: Partial<{ guildId: string | null; channelId: string }> = {}) {
  return {
    id: 'msg-1',
    content,
    guildId: 'guild-1',
    channelId: 'channel-1',
    reply: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const mockTwitchRuntime = { send: vi.fn().mockResolvedValue(undefined) };

// Base time far in the future so `Date.now() - 0` always exceeds GLOBAL_COOLDOWN_MS
// at the start of each test. Each beforeEach adds enough to expire any previous claim,
// matching the pattern in commandRouter.test.ts.
const COOLDOWN_MS = 3_000;
let mockNow = 1_000_000_000_000;

beforeEach(() => {
  mockNow += COOLDOWN_MS + 1_000;
  vi.clearAllMocks();
  vi.spyOn(Date, 'now').mockReturnValue(mockNow);
  registerCounterTwitchRuntime(mockTwitchRuntime);
});

describe('executeCounterCommandForDiscord', () => {
  it('does nothing when the message has no command', async () => {
    const msg = makeMockMessage('');
    await executeCounterCommandForDiscord(msg as any);
    expect(vi.mocked(findCounterByCommand)).not.toHaveBeenCalled();
  });

  it('does nothing when the command is not a counter', async () => {
    vi.mocked(findCounterByCommand).mockResolvedValue(null);
    const msg = makeMockMessage('!unknown');
    await executeCounterCommandForDiscord(msg as any);
    expect(msg.reply).not.toHaveBeenCalled();
  });

  it('replies with formatted increment message for a trigger counter', async () => {
    vi.mocked(findCounterByCommand).mockResolvedValue(TRIGGER_COUNTER as any);
    vi.mocked(incrementCounter).mockResolvedValue(5);
    const msg = makeMockMessage('!hits');

    await executeCounterCommandForDiscord(msg as any, 'viewer1');

    expect(msg.reply).toHaveBeenCalledWith({ content: 'Count is now 5!', allowedMentions: { parse: [] } });
  });

  it('replies with check message (no increment) for a check counter', async () => {
    vi.mocked(findCounterByCommand).mockResolvedValue(CHECK_COUNTER as any);
    const msg = makeMockMessage('!count');

    await executeCounterCommandForDiscord(msg as any);

    expect(vi.mocked(incrementCounter)).not.toHaveBeenCalled();
    expect(msg.reply).toHaveBeenCalledWith({ content: 'Current count: 7', allowedMentions: { parse: [] } });
  });

  it('sets allowedMentions to suppress parsing, so @everyone/@here text in an admin-authored template cannot ping', async () => {
    vi.mocked(findCounterByCommand).mockResolvedValue({ ...CHECK_COUNTER, message: '@everyone current count: %d' } as any);
    const msg = makeMockMessage('!count');

    await executeCounterCommandForDiscord(msg as any);

    expect(msg.reply).toHaveBeenCalledWith(expect.objectContaining({ allowedMentions: { parse: [] } }));
  });

  it('does NOT reply when incrementCounter fails', async () => {
    vi.mocked(findCounterByCommand).mockResolvedValue(TRIGGER_COUNTER as any);
    vi.mocked(incrementCounter).mockRejectedValue(new Error('DB down'));
    const msg = makeMockMessage('!hits');

    await executeCounterCommandForDiscord(msg as any);

    expect(msg.reply).not.toHaveBeenCalled();
  });

  it('swallows Discord not-found errors on reply failure', async () => {
    const { isDiscordNotFoundError } = await import('../discord/discordUtils.js');
    vi.mocked(isDiscordNotFoundError).mockReturnValue(true);
    vi.mocked(findCounterByCommand).mockResolvedValue(CHECK_COUNTER as any);
    const msg = makeMockMessage('!count');
    msg.reply.mockRejectedValue(new Error('Unknown message'));

    await expect(executeCounterCommandForDiscord(msg as any)).resolves.toBeUndefined();
  });
});

describe('executeCounterCommandForTwitch', () => {
  it('does nothing when the message has no command', async () => {
    await executeCounterCommandForTwitch('#chan', '', null);
    expect(vi.mocked(findCounterByCommand)).not.toHaveBeenCalled();
  });

  it('does nothing when the command is not a counter', async () => {
    vi.mocked(findCounterByCommand).mockResolvedValue(null);
    await executeCounterCommandForTwitch('#chan', '!other', null);
    expect(mockTwitchRuntime.send).not.toHaveBeenCalled();
  });

  it('sends the formatted message via runtime for a trigger counter', async () => {
    vi.mocked(findCounterByCommand).mockResolvedValue(TRIGGER_COUNTER as any);
    vi.mocked(incrementCounter).mockResolvedValue(10);

    await executeCounterCommandForTwitch('#mychan', '!hits', 'viewer1');

    expect(mockTwitchRuntime.send).toHaveBeenCalledWith('#mychan', 'Count is now 10!');
  });

  it('does not send when incrementCounter fails (canReply=false)', async () => {
    vi.mocked(findCounterByCommand).mockResolvedValue(TRIGGER_COUNTER as any);
    vi.mocked(incrementCounter).mockRejectedValue(new Error('DB down'));

    await executeCounterCommandForTwitch('#chan', '!hits', null);

    expect(mockTwitchRuntime.send).not.toHaveBeenCalled();
  });
});

describe('counter cooldown', () => {
  it('blocks a second Discord counter command in the same guild within the cooldown window, without incrementing again', async () => {
    vi.mocked(findCounterByCommand).mockResolvedValue(TRIGGER_COUNTER as any);
    vi.mocked(incrementCounter).mockResolvedValue(5);

    const msg1 = makeMockMessage('!hits');
    await executeCounterCommandForDiscord(msg1 as any);
    expect(msg1.reply).toHaveBeenCalledTimes(1);
    expect(vi.mocked(incrementCounter)).toHaveBeenCalledTimes(1);

    // Same timestamp — cooldown has not elapsed
    const msg2 = makeMockMessage('!hits');
    await executeCounterCommandForDiscord(msg2 as any);
    expect(msg2.reply).not.toHaveBeenCalled();
    expect(vi.mocked(incrementCounter)).toHaveBeenCalledTimes(1);
  });

  it("does not apply one Discord guild's cooldown to another guild", async () => {
    vi.mocked(findCounterByCommand).mockResolvedValue(CHECK_COUNTER as any);

    const msg1 = makeMockMessage('!count');
    await executeCounterCommandForDiscord(msg1 as any);
    expect(msg1.reply).toHaveBeenCalledTimes(1);

    const msg2 = makeMockMessage('!count', { guildId: 'guild-2' });
    await executeCounterCommandForDiscord(msg2 as any);
    expect(msg2.reply).toHaveBeenCalledTimes(1);
  });

  it("forgetGuildCounterCooldown resets a guild's cooldown so a subsequent command fires immediately", async () => {
    vi.mocked(findCounterByCommand).mockResolvedValue(CHECK_COUNTER as any);

    const msg1 = makeMockMessage('!count');
    await executeCounterCommandForDiscord(msg1 as any);
    expect(msg1.reply).toHaveBeenCalledTimes(1);

    forgetGuildCounterCooldown('guild-1');

    const msg2 = makeMockMessage('!count');
    await executeCounterCommandForDiscord(msg2 as any);
    expect(msg2.reply).toHaveBeenCalledTimes(1);
  });

  it('forgetGuildCounterCooldown is a no-op for a guild with no state', () => {
    expect(() => forgetGuildCounterCooldown('never-seen')).not.toThrow();
  });

  it('blocks a second Twitch counter command in the same channel within the cooldown window, without incrementing again', async () => {
    vi.mocked(findCounterByCommand).mockResolvedValue(TRIGGER_COUNTER as any);
    vi.mocked(incrementCounter).mockResolvedValue(5);

    await executeCounterCommandForTwitch('#chan', '!hits', null);
    expect(mockTwitchRuntime.send).toHaveBeenCalledTimes(1);
    expect(vi.mocked(incrementCounter)).toHaveBeenCalledTimes(1);

    await executeCounterCommandForTwitch('#chan', '!hits', null);
    expect(mockTwitchRuntime.send).toHaveBeenCalledTimes(1);
    expect(vi.mocked(incrementCounter)).toHaveBeenCalledTimes(1);
  });

  it("does not apply one Twitch channel's cooldown to another channel", async () => {
    vi.mocked(findCounterByCommand).mockResolvedValue(CHECK_COUNTER as any);

    await executeCounterCommandForTwitch('#chan-a', '!count', null);
    expect(mockTwitchRuntime.send).toHaveBeenCalledTimes(1);

    await executeCounterCommandForTwitch('#chan-b', '!count', null);
    expect(mockTwitchRuntime.send).toHaveBeenCalledTimes(2);
  });
});
