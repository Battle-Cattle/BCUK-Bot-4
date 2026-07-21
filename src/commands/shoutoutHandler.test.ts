import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../test-utils/loggerMock';

vi.mock('../shared/logger', () => ({ createLogger: mockLogger }));

vi.mock('../twitch/twitchApi', () => ({
  getUsers: vi.fn(),
  getChannelInfo: vi.fn(),
  getStreams: vi.fn(),
}));

import {
  executeShoutoutForTwitch,
  buildShoutoutMessage,
  registerShoutoutRuntime,
} from './shoutoutHandler';
import { getUsers, getChannelInfo, getStreams } from '../twitch/twitchApi';

const mockRuntime = { send: vi.fn().mockResolvedValue(undefined) };

beforeEach(() => {
  vi.clearAllMocks();
  registerShoutoutRuntime(mockRuntime);
});

describe('executeShoutoutForTwitch', () => {
  it('does nothing when the command is not !so', async () => {
    await executeShoutoutForTwitch('#chan', '!other @user', 'mod', true);
    expect(vi.mocked(getUsers)).not.toHaveBeenCalled();
  });

  it('does nothing when the caller is not a moderator', async () => {
    await executeShoutoutForTwitch('#chan', '!so @target', 'viewer', false);
    expect(vi.mocked(getUsers)).not.toHaveBeenCalled();
  });

  it('does nothing when no target is provided', async () => {
    await executeShoutoutForTwitch('#chan', '!so', 'mod', true);
    expect(vi.mocked(getUsers)).not.toHaveBeenCalled();
  });

  it('does nothing when target is not found on Twitch', async () => {
    vi.mocked(getUsers).mockResolvedValue([]);

    await executeShoutoutForTwitch('#chan', '!so @ghost', 'mod', true);

    expect(mockRuntime.send).not.toHaveBeenCalled();
  });

  it('sends a live shoutout when the target is currently streaming', async () => {
    vi.mocked(getUsers).mockResolvedValue([{ id: 'u1', login: 'streamer' } as any]);
    vi.mocked(getChannelInfo).mockResolvedValue([{ game_name: 'Chess' } as any]);
    vi.mocked(getStreams).mockResolvedValue([{ game_name: 'Chess' } as any]);

    await executeShoutoutForTwitch('#chan', '!so @Streamer', 'mod', true);

    expect(mockRuntime.send).toHaveBeenCalledWith(
      '#chan',
      expect.stringContaining("they're live playing Chess"),
    );
  });

  it('sends an offline shoutout with last-seen game when not live', async () => {
    vi.mocked(getUsers).mockResolvedValue([{ id: 'u1', login: 'streamer' } as any]);
    vi.mocked(getChannelInfo).mockResolvedValue([{ game_name: 'Minecraft' } as any]);
    vi.mocked(getStreams).mockResolvedValue([]);

    await executeShoutoutForTwitch('#chan', '!so streamer', 'mod', true);

    expect(mockRuntime.send).toHaveBeenCalledWith(
      '#chan',
      expect.stringContaining('last seen playing Minecraft'),
    );
  });

  it('sends a follow-only shoutout when no game info is available', async () => {
    vi.mocked(getUsers).mockResolvedValue([{ id: 'u1', login: 'newbie' } as any]);
    vi.mocked(getChannelInfo).mockResolvedValue([{ game_name: null } as any]);
    vi.mocked(getStreams).mockResolvedValue([]);

    await executeShoutoutForTwitch('#chan', '!so newbie', 'mod', true);

    expect(mockRuntime.send).toHaveBeenCalledWith(
      '#chan',
      expect.stringContaining('Go give @newbie a follow'),
    );
    const msg: string = mockRuntime.send.mock.calls[0][1];
    expect(msg).not.toContain('last seen playing');
  });

  it('strips the @ prefix from the target username before lookup', async () => {
    vi.mocked(getUsers).mockResolvedValue([]);

    await executeShoutoutForTwitch('#chan', '!so @MyFriend', 'mod', true);

    expect(vi.mocked(getUsers)).toHaveBeenCalledWith(['myfriend']);
  });

  it('does not throw when runtime.send fails', async () => {
    vi.mocked(getUsers).mockResolvedValue([{ id: 'u1', login: 'streamer' } as any]);
    vi.mocked(getChannelInfo).mockResolvedValue([]);
    vi.mocked(getStreams).mockResolvedValue([]);
    mockRuntime.send.mockRejectedValueOnce(new Error('Network error'));

    await expect(executeShoutoutForTwitch('#chan', '!so streamer', 'mod', true)).resolves.toBeUndefined();
  });

  it('still resolves when getStreams rejects (independent failure)', async () => {
    vi.mocked(getUsers).mockResolvedValue([{ id: 'u1', login: 'streamer' } as any]);
    vi.mocked(getChannelInfo).mockResolvedValue([{ game_name: 'Valorant' } as any]);
    vi.mocked(getStreams).mockRejectedValue(new Error('Stream API error'));

    await executeShoutoutForTwitch('#chan', '!so streamer', 'mod', true);

    // Falls back to channel info game name, sends offline-style message
    expect(mockRuntime.send).toHaveBeenCalledWith(
      '#chan',
      expect.stringContaining('Valorant'),
    );
  });
});

describe('buildShoutoutMessage', () => {
  it('returns null when the target is not found on Twitch', async () => {
    vi.mocked(getUsers).mockResolvedValue([]);

    const result = await buildShoutoutMessage('ghost');

    expect(result).toBeNull();
  });

  it('returns a live shoutout message when the target is currently streaming', async () => {
    vi.mocked(getUsers).mockResolvedValue([{ id: 'u1', login: 'streamer' } as any]);
    vi.mocked(getChannelInfo).mockResolvedValue([{ game_name: 'Chess' } as any]);
    vi.mocked(getStreams).mockResolvedValue([{ game_name: 'Chess' } as any]);

    const result = await buildShoutoutMessage('streamer');

    expect(result).toContain("they're live playing Chess");
  });

  it('returns an offline shoutout message with last-seen game when not live', async () => {
    vi.mocked(getUsers).mockResolvedValue([{ id: 'u1', login: 'streamer' } as any]);
    vi.mocked(getChannelInfo).mockResolvedValue([{ game_name: 'Minecraft' } as any]);
    vi.mocked(getStreams).mockResolvedValue([]);

    const result = await buildShoutoutMessage('streamer');

    expect(result).toContain('last seen playing Minecraft');
  });
});
