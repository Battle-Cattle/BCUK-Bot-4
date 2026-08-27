import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../test-utils/loggerMock';

vi.mock('../shared/logger', () => ({ createLogger: mockLogger }));

vi.mock('../db', () => ({
  findOwnerUser: vi.fn(),
}));

vi.mock('../shared/healthStore', () => ({
  getHealthSnapshot: vi.fn(),
}));

import { executeHealthCommandForDiscord } from './healthCommandHandler';
import { findOwnerUser } from '../db';
import { getHealthSnapshot } from '../shared/healthStore';

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

function makeMockMessage(content: string, authorId: string) {
  return {
    content,
    author: { id: authorId },
    reply: vi.fn().mockResolvedValue(undefined),
  };
}

describe('executeHealthCommandForDiscord', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getHealthSnapshot).mockReturnValue(EMPTY_SNAPSHOT as any);
    vi.mocked(findOwnerUser).mockResolvedValue(OWNER_ROW as any);
  });

  it('does not reply for a message that is not !health', async () => {
    const message = makeMockMessage('!other', OWNER_ID);
    await executeHealthCommandForDiscord(message as any);
    expect(message.reply).not.toHaveBeenCalled();
    expect(findOwnerUser).not.toHaveBeenCalled();
  });

  it('does not reply when the author is not the owner', async () => {
    const message = makeMockMessage('!health', 'not-the-owner');
    await executeHealthCommandForDiscord(message as any);
    expect(message.reply).not.toHaveBeenCalled();
  });

  it('does not reply when there is no owner row', async () => {
    vi.mocked(findOwnerUser).mockResolvedValue(null);
    const message = makeMockMessage('!health', OWNER_ID);
    await executeHealthCommandForDiscord(message as any);
    expect(message.reply).not.toHaveBeenCalled();
  });

  it('replies with a health summary for the owner', async () => {
    const message = makeMockMessage('!health', OWNER_ID);
    await executeHealthCommandForDiscord(message as any);
    expect(message.reply).toHaveBeenCalledOnce();
    const replyText = message.reply.mock.calls[0][0] as string;
    expect(replyText).toContain('Bot Health');
    expect(replyText).toContain('Discord');
    expect(replyText).toContain('Twitch chat');
    expect(replyText).toContain('DB');
  });

  it('matches !health only as the first word, not as a substring of another command', async () => {
    const message = makeMockMessage('!healthcheck', OWNER_ID);
    await executeHealthCommandForDiscord(message as any);
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
    const replyText = message.reply.mock.calls[0][0] as string;
    const firstIndex = replyText.indexOf('first');
    const secondIndex = replyText.indexOf('second');
    expect(secondIndex).toBeGreaterThan(-1);
    expect(firstIndex).toBeGreaterThan(secondIndex);
  });

  it('does not throw when findOwnerUser rejects', async () => {
    vi.mocked(findOwnerUser).mockRejectedValue(new Error('db down'));
    const message = makeMockMessage('!health', OWNER_ID);
    await expect(executeHealthCommandForDiscord(message as any)).resolves.toBeUndefined();
    expect(message.reply).not.toHaveBeenCalled();
  });
});
