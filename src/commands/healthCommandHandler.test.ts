import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../test-utils/loggerMock';

vi.mock('../shared/logger', () => ({ createLogger: mockLogger }));

vi.mock('../db', () => ({
  findOwnerUser: vi.fn(),
}));

vi.mock('../shared/healthStore', () => ({
  getHealthSnapshot: vi.fn(),
}));

vi.mock('../discord/discordUtils', () => ({
  isDiscordNotFoundError: vi.fn().mockReturnValue(false),
}));

import { executeHealthCommandForDiscord } from './healthCommandHandler';
import { findOwnerUser } from '../db';
import { getHealthSnapshot } from '../shared/healthStore';
import { isDiscordNotFoundError } from '../discord/discordUtils';

const OWNER_ID = '111222333444555666';
const OWNER_ROW = {
  discord_id: OWNER_ID,
  discord_name: 'Owner',
  is_twitch_bot_enabled: false,
  twitch_name: null,
  access_level: 3,
  is_owner: true,
};

const EMPTY_SNAPSHOT = {
  discordConnected: true,
  twitchChatConnected: true,
  db: { lastPingOk: true, lastPingAt: new Date('2026-01-01T00:00:00Z'), lastError: null },
  eventsub: {},
  monitor: { lastPollOk: true, lastPollAt: new Date('2026-01-01T00:00:00Z'), lastError: null },
  schedulers: {},
  errors: [],
};

function makeMockMessage(content: string, authorId: string, opts: { guild?: unknown } = {}) {
  return {
    content,
    author: { id: authorId, send: vi.fn().mockResolvedValue(undefined) },
    guild: opts.guild ?? null,
    reply: vi.fn().mockResolvedValue(undefined),
  };
}

describe('executeHealthCommandForDiscord', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getHealthSnapshot).mockReturnValue(EMPTY_SNAPSHOT as any);
    vi.mocked(findOwnerUser).mockResolvedValue(OWNER_ROW as any);
  });

  it('does not DM for a message that is not !health', async () => {
    const message = makeMockMessage('!other', OWNER_ID);
    await executeHealthCommandForDiscord(message as any);
    expect(message.author.send).not.toHaveBeenCalled();
    expect(message.reply).not.toHaveBeenCalled();
    expect(findOwnerUser).not.toHaveBeenCalled();
  });

  it('does not DM when the author is not the owner', async () => {
    const message = makeMockMessage('!health', 'not-the-owner');
    await executeHealthCommandForDiscord(message as any);
    expect(message.author.send).not.toHaveBeenCalled();
    expect(message.reply).not.toHaveBeenCalled();
  });

  it('does not DM when there is no owner row', async () => {
    vi.mocked(findOwnerUser).mockResolvedValue(null);
    const message = makeMockMessage('!health', OWNER_ID);
    await executeHealthCommandForDiscord(message as any);
    expect(message.author.send).not.toHaveBeenCalled();
    expect(message.reply).not.toHaveBeenCalled();
  });

  it('DMs the owner a health summary, and does not reply in-channel outside a guild', async () => {
    const message = makeMockMessage('!health', OWNER_ID);
    await executeHealthCommandForDiscord(message as any);
    expect(message.author.send).toHaveBeenCalledOnce();
    const dmText = message.author.send.mock.calls[0][0] as string;
    expect(dmText).toContain('Bot Health');
    expect(dmText).toContain('Discord');
    expect(dmText).toContain('Twitch chat');
    expect(dmText).toContain('DB');
    expect(message.reply).not.toHaveBeenCalled();
  });

  it('DMs the owner and posts a non-sensitive channel ack when triggered from a guild', async () => {
    const message = makeMockMessage('!health', OWNER_ID, { guild: { id: 'guild-1' } });
    await executeHealthCommandForDiscord(message as any);
    expect(message.author.send).toHaveBeenCalledOnce();
    const dmText = message.author.send.mock.calls[0][0] as string;
    expect(dmText).toContain('Bot Health');
    expect(message.reply).toHaveBeenCalledOnce();
    const replyText = message.reply.mock.calls[0][0] as string;
    expect(replyText).not.toContain('Bot Health');
    expect(replyText).not.toContain('DB');
  });

  it('swallows a Discord not-found error on the channel ack without throwing', async () => {
    vi.mocked(isDiscordNotFoundError).mockReturnValue(true);
    const message = makeMockMessage('!health', OWNER_ID, { guild: { id: 'guild-1' } });
    message.reply.mockRejectedValue(new Error('Unknown message'));

    await expect(executeHealthCommandForDiscord(message as any)).resolves.toBeUndefined();
    expect(message.author.send).toHaveBeenCalledOnce();
  });

  it('logs and swallows a failed DM (e.g. DMs closed) instead of throwing, without posting a channel ack', async () => {
    const message = makeMockMessage('!health', OWNER_ID, { guild: { id: 'guild-1' } });
    message.author.send.mockRejectedValue(new Error('Cannot send messages to this user'));
    await expect(executeHealthCommandForDiscord(message as any)).resolves.toBeUndefined();
    expect(message.reply).not.toHaveBeenCalled();
  });

  it('matches !health only as the first word, not as a substring of another command', async () => {
    const message = makeMockMessage('!healthcheck', OWNER_ID);
    await executeHealthCommandForDiscord(message as any);
    expect(message.author.send).not.toHaveBeenCalled();
    expect(message.reply).not.toHaveBeenCalled();
  });

  it('includes recent errors, newest first', async () => {
    vi.mocked(getHealthSnapshot).mockReturnValue({
      ...EMPTY_SNAPSHOT,
      errors: [
        { timestamp: new Date('2026-01-01T00:00:00Z'), module: 'Discord', message: 'first' },
        { timestamp: new Date('2026-01-01T00:01:00Z'), module: 'Twitch', message: 'second' },
      ],
    } as any);
    const message = makeMockMessage('!health', OWNER_ID);
    await executeHealthCommandForDiscord(message as any);
    const dmText = message.author.send.mock.calls[0][0] as string;
    const firstIndex = dmText.indexOf('first');
    const secondIndex = dmText.indexOf('second');
    expect(secondIndex).toBeGreaterThan(-1);
    expect(firstIndex).toBeGreaterThan(secondIndex);
  });

  it('includes an EventSub section and a Schedulers section when either is populated', async () => {
    vi.mocked(getHealthSnapshot).mockReturnValue({
      ...EMPTY_SNAPSHOT,
      eventsub: {
        streamerA: { connected: true, lastConnectedAt: null, lastDisconnectedAt: null, reconnectAttempts: 0, lastError: null },
      },
      schedulers: {
        counter: { lastRunAt: new Date('2026-01-01T00:00:00Z'), lastRunOk: true, lastError: null },
        timer: { lastRunAt: new Date('2026-01-01T00:00:00Z'), lastRunOk: false, lastError: 'boom' },
      },
    } as any);
    const message = makeMockMessage('!health', OWNER_ID);
    await executeHealthCommandForDiscord(message as any);
    const dmText = message.author.send.mock.calls[0][0] as string;
    expect(dmText).toContain('EventSub:');
    expect(dmText).toContain('streamerA');
    expect(dmText).toContain('Schedulers:');
    expect(dmText).toContain('counter: 🟢 ok');
    expect(dmText).toContain('timer: 🔴 failing');
  });

  it('truncates a summary that would otherwise exceed the Discord message limit', async () => {
    const manyEventSubEntries = Object.fromEntries(
      Array.from({ length: 100 }, (_, i) => [
        `streamer-with-a-fairly-long-name-${i}`,
        { connected: true, lastConnectedAt: null, lastDisconnectedAt: null, reconnectAttempts: 0, lastError: null },
      ]),
    );
    vi.mocked(getHealthSnapshot).mockReturnValue({ ...EMPTY_SNAPSHOT, eventsub: manyEventSubEntries } as any);
    const message = makeMockMessage('!health', OWNER_ID);
    await executeHealthCommandForDiscord(message as any);
    const dmText = message.author.send.mock.calls[0][0] as string;
    expect(dmText.length).toBeLessThanOrEqual(2000);
    expect(dmText.endsWith('\n… (truncated)')).toBe(true);
  });

  it('does not throw when findOwnerUser rejects', async () => {
    vi.mocked(findOwnerUser).mockRejectedValue(new Error('db down'));
    const message = makeMockMessage('!health', OWNER_ID);
    await expect(executeHealthCommandForDiscord(message as any)).resolves.toBeUndefined();
    expect(message.reply).not.toHaveBeenCalled();
  });
});
