import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../test-utils/loggerMock';

vi.mock('../shared/logger', () => ({ createLogger: mockLogger }));

vi.mock('../db', () => ({
  findCounterByCommand: vi.fn(),
  incrementCounter: vi.fn(),
}));

vi.mock('./commandMonitorStore', () => ({
  recordCommandTestEntry: vi.fn(),
}));

vi.mock('../discord/discordUtils', () => ({
  isDiscordNotFoundError: vi.fn().mockReturnValue(false),
}));

import {
  executeCounterCommandForDiscord,
  executeCounterCommandForTwitch,
  registerCounterTwitchRuntime,
} from './counterHandler';
import { findCounterByCommand, incrementCounter } from '../db';
import { recordCommandTestEntry } from './commandMonitorStore';

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

function makeMockMessage(content: string) {
  return {
    id: 'msg-1',
    content,
    reply: vi.fn().mockResolvedValue(undefined),
  };
}

const mockTwitchRuntime = { send: vi.fn().mockResolvedValue(undefined) };

beforeEach(() => {
  vi.clearAllMocks();
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

  it('replies with formatted increment message and records entry for a trigger counter', async () => {
    vi.mocked(findCounterByCommand).mockResolvedValue(TRIGGER_COUNTER as any);
    vi.mocked(incrementCounter).mockResolvedValue(5);
    const msg = makeMockMessage('!hits');

    await executeCounterCommandForDiscord(msg as any, 'viewer1');

    expect(msg.reply).toHaveBeenCalledWith('Count is now 5!');
    expect(vi.mocked(recordCommandTestEntry)).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'discord', command: '!hits', user: 'viewer1' }),
    );
  });

  it('replies with check message (no increment) for a check counter', async () => {
    vi.mocked(findCounterByCommand).mockResolvedValue(CHECK_COUNTER as any);
    const msg = makeMockMessage('!count');

    await executeCounterCommandForDiscord(msg as any);

    expect(vi.mocked(incrementCounter)).not.toHaveBeenCalled();
    expect(msg.reply).toHaveBeenCalledWith('Current count: 7');
  });

  it('records the entry but does NOT reply when incrementCounter fails', async () => {
    vi.mocked(findCounterByCommand).mockResolvedValue(TRIGGER_COUNTER as any);
    vi.mocked(incrementCounter).mockRejectedValue(new Error('DB down'));
    const msg = makeMockMessage('!hits');

    await executeCounterCommandForDiscord(msg as any);

    expect(vi.mocked(recordCommandTestEntry)).toHaveBeenCalled();
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
    expect(vi.mocked(recordCommandTestEntry)).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'twitch', channel: '#mychan', user: 'viewer1' }),
    );
  });

  it('does not send when incrementCounter fails (canReply=false)', async () => {
    vi.mocked(findCounterByCommand).mockResolvedValue(TRIGGER_COUNTER as any);
    vi.mocked(incrementCounter).mockRejectedValue(new Error('DB down'));

    await executeCounterCommandForTwitch('#chan', '!hits', null);

    expect(mockTwitchRuntime.send).not.toHaveBeenCalled();
    expect(vi.mocked(recordCommandTestEntry)).toHaveBeenCalled();
  });
});
