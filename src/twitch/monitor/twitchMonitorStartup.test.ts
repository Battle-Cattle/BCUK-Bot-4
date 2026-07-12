import { describe, it, expect, vi, beforeEach } from 'vitest';

// Shared with the discordUtils mock factory below so tests can still drive
// isDiscordNotFoundError's return value directly, even though production code
// now only calls it indirectly (from inside the mocked tryEditDiscordMessage).
const { isDiscordNotFoundErrorMock } = vi.hoisted(() => ({
  isDiscordNotFoundErrorMock: vi.fn().mockReturnValue(false),
}));

vi.mock('../../shared/logger', () => ({ createLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }) }));
vi.mock('../../discord/discordBot', () => ({ getDiscordClient: vi.fn() }));
vi.mock('../../discord/discordUtils', () => ({
  isDiscordNotFoundError: isDiscordNotFoundErrorMock,
  tryDeleteDiscordMessage: vi.fn().mockResolvedValue(undefined),
  // Minimal re-implementations driven by the same mock Discord client/channel
  // objects the tests already construct, so call-chain assertions keep working.
  getTextChannel: vi.fn(async (client: any, channelId: string) => {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) return null;
    return channel;
  }),
  tryEditDiscordMessage: vi.fn(async (client: any, channelId: string, messageId: string, payload: any) => {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) return false;
    try {
      const message = await channel.messages.fetch(messageId);
      await message.edit(payload);
      return true;
    } catch (err) {
      if (isDiscordNotFoundErrorMock(err)) return false;
      throw err;
    }
  }),
}));
vi.mock('../../db', () => ({
  setStreamerLive: vi.fn().mockResolvedValue(undefined),
  clearStreamerLive: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../twitchApi', () => ({
  getStreams: vi.fn().mockResolvedValue([]),
}));
vi.mock('./twitchMonitorEmbed', () => ({
  buildEmbed: vi.fn().mockReturnValue({}),
  templateVars: vi.fn().mockReturnValue({}),
}));
vi.mock('../../shared/textTemplate', () => ({
  fillTemplate: vi.fn().mockReturnValue('message'),
}));
vi.mock('./twitchMonitorMultitwitch', () => ({
  updateMultitwitch: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./twitchMonitorAnnouncements', () => ({
  postAnnouncement: vi.fn().mockResolvedValue(undefined),
}));

import {
  tryEditStartupMessage,
  handleLiveStreamerOnStartup,
  handleOfflineStreamerOnStartup,
  performStartupLiveCheck,
} from './twitchMonitorStartup';
import { getDiscordClient } from '../../discord/discordBot';
import { isDiscordNotFoundError, tryDeleteDiscordMessage } from '../../discord/discordUtils';
import { setStreamerLive, clearStreamerLive } from '../../db';
import { getStreams } from '../twitchApi';
import { updateMultitwitch } from './twitchMonitorMultitwitch';
import { postAnnouncement } from './twitchMonitorAnnouncements';
import type { DbStreamGroup, DbStreamerFull } from '../../db';
import type { TwitchStream } from '../twitchApi';
import type { LiveState } from './twitchMonitorTypes';

function makeGroup(overrides: Partial<DbStreamGroup> = {}): DbStreamGroup {
  return { id: 1, guild_id: 'guild-1', name: 'G1', discord_channel: 'ch1', live_message: 'Live!', new_game_message: 'New!', multi_twitch: false, delete_old_posts: false, ...overrides };
}

function makeStreamer(overrides: Partial<DbStreamerFull> = {}): DbStreamerFull {
  return { id: 10, discord_id: 'discord1', twitch_name: 'alice', group: makeGroup(), discord_message_id: null, discord_channel_id: null, live_game: null, ...overrides };
}

function makeStream(overrides: Partial<TwitchStream> = {}): TwitchStream {
  return { user_id: 'u1', user_login: 'alice', game_name: 'Chess', type: 'live', title: 'Playing', thumbnail_url: '', ...overrides };
}

function makeChannel(msgOverrides: Partial<{ edit: ReturnType<typeof vi.fn> }> = {}) {
  const message = { edit: vi.fn().mockResolvedValue(undefined), ...msgOverrides };
  return {
    isTextBased: () => true,
    messages: { fetch: vi.fn().mockResolvedValue(message) },
    _message: message,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isDiscordNotFoundError).mockReturnValue(false);
});

// ─── tryEditStartupMessage ────────────────────────────────────────────────────

describe('tryEditStartupMessage', () => {
  it('returns false when no discord client', async () => {
    vi.mocked(getDiscordClient).mockReturnValue(null);
    const result = await tryEditStartupMessage(new Map(), makeStreamer({ discord_message_id: 'msg1', discord_channel_id: 'ch1' }), makeStream());
    expect(result).toBe(false);
  });

  it('returns false when streamer has no stored discord_message_id', async () => {
    vi.mocked(getDiscordClient).mockReturnValue({} as any);
    const result = await tryEditStartupMessage(new Map(), makeStreamer({ discord_message_id: null, discord_channel_id: null }), makeStream());
    expect(result).toBe(false);
  });

  it('returns false when channel is not text-based', async () => {
    vi.mocked(getDiscordClient).mockReturnValue({ channels: { fetch: vi.fn().mockResolvedValue({ isTextBased: () => false }) } } as any);
    const result = await tryEditStartupMessage(new Map(), makeStreamer({ discord_message_id: 'msg1', discord_channel_id: 'ch1' }), makeStream());
    expect(result).toBe(false);
  });

  it('edits the message, updates liveStates, calls setStreamerLive, and returns true', async () => {
    const channel = makeChannel();
    vi.mocked(getDiscordClient).mockReturnValue({ channels: { fetch: vi.fn().mockResolvedValue(channel) } } as any);
    const liveStates = new Map<string, LiveState>();
    const streamer = makeStreamer({ id: 10, discord_message_id: 'msg1', discord_channel_id: 'ch1' });
    const result = await tryEditStartupMessage(liveStates, streamer, makeStream());
    expect(result).toBe(true);
    expect(channel._message.edit).toHaveBeenCalled();
    expect(liveStates.has('10')).toBe(true);
    expect(setStreamerLive).toHaveBeenCalledWith(10, 'msg1', 'ch1', 'Chess');
  });

  it('returns false when message fetch throws DiscordNotFoundError', async () => {
    const channel = { isTextBased: () => true, messages: { fetch: vi.fn().mockRejectedValue(new Error('Unknown')) } };
    vi.mocked(getDiscordClient).mockReturnValue({ channels: { fetch: vi.fn().mockResolvedValue(channel) } } as any);
    vi.mocked(isDiscordNotFoundError).mockReturnValue(true);
    const result = await tryEditStartupMessage(new Map(), makeStreamer({ discord_message_id: 'msg1', discord_channel_id: 'ch1' }), makeStream());
    expect(result).toBe(false);
  });

  it('rethrows non-DiscordNotFoundError', async () => {
    const channel = { isTextBased: () => true, messages: { fetch: vi.fn().mockRejectedValue(new Error('network')) } };
    vi.mocked(getDiscordClient).mockReturnValue({ channels: { fetch: vi.fn().mockResolvedValue(channel) } } as any);
    vi.mocked(isDiscordNotFoundError).mockReturnValue(false);
    await expect(tryEditStartupMessage(new Map(), makeStreamer({ discord_message_id: 'msg1', discord_channel_id: 'ch1' }), makeStream())).rejects.toThrow('network');
  });
});

// ─── handleLiveStreamerOnStartup ──────────────────────────────────────────────

describe('handleLiveStreamerOnStartup', () => {
  it('sets live state without Discord call when no client and streamer has stored message', async () => {
    vi.mocked(getDiscordClient).mockReturnValue(null);
    const liveStates = new Map<string, LiveState>();
    const streamer = makeStreamer({ id: 10, discord_message_id: 'msg1', discord_channel_id: 'ch1' });
    await handleLiveStreamerOnStartup(liveStates, streamer, makeStream(), new Set());
    expect(liveStates.has('10')).toBe(true);
    expect(postAnnouncement).not.toHaveBeenCalled();
  });

  it('calls postAnnouncement when streamer has no stored message', async () => {
    await handleLiveStreamerOnStartup(new Map(), makeStreamer({ discord_message_id: null }), makeStream(), new Set());
    expect(postAnnouncement).toHaveBeenCalled();
  });

  it('adds groupId to groupsWithChanges when edit succeeds', async () => {
    const channel = makeChannel();
    vi.mocked(getDiscordClient).mockReturnValue({ channels: { fetch: vi.fn().mockResolvedValue(channel) } } as any);
    const groupsWithChanges = new Set<number>();
    await handleLiveStreamerOnStartup(new Map(), makeStreamer({ discord_message_id: 'msg1', discord_channel_id: 'ch1', group: makeGroup({ id: 99 }) }), makeStream(), groupsWithChanges);
    expect(groupsWithChanges.has(99)).toBe(true);
  });

  it('skips postAnnouncement when tryEditStartupMessage throws', async () => {
    const channel = { isTextBased: () => true, messages: { fetch: vi.fn().mockRejectedValue(new Error('network')) } };
    vi.mocked(getDiscordClient).mockReturnValue({ channels: { fetch: vi.fn().mockResolvedValue(channel) } } as any);
    vi.mocked(isDiscordNotFoundError).mockReturnValue(false);
    await handleLiveStreamerOnStartup(new Map(), makeStreamer({ discord_message_id: 'msg1', discord_channel_id: 'ch1' }), makeStream(), new Set());
    expect(postAnnouncement).not.toHaveBeenCalled();
  });
});

// ─── handleOfflineStreamerOnStartup ───────────────────────────────────────────

describe('handleOfflineStreamerOnStartup', () => {
  it('calls clearStreamerLive and adds group to groupsWithChanges', async () => {
    const groupsWithChanges = new Set<number>();
    await handleOfflineStreamerOnStartup(makeStreamer({ id: 10, discord_message_id: null, discord_channel_id: null, group: makeGroup({ id: 5 }) }), groupsWithChanges);
    expect(clearStreamerLive).toHaveBeenCalledWith(10);
    expect(groupsWithChanges.has(5)).toBe(true);
  });

  it('calls tryDeleteDiscordMessage when stored message exists', async () => {
    await handleOfflineStreamerOnStartup(makeStreamer({ discord_message_id: 'msg1', discord_channel_id: 'ch1' }), new Set());
    expect(tryDeleteDiscordMessage).toHaveBeenCalledWith('ch1', 'msg1');
  });

  it('skips clearStreamerLive when tryDeleteDiscordMessage throws', async () => {
    vi.mocked(tryDeleteDiscordMessage).mockRejectedValueOnce(new Error('delete failed'));
    await handleOfflineStreamerOnStartup(makeStreamer({ discord_message_id: 'msg1', discord_channel_id: 'ch1' }), new Set());
    expect(clearStreamerLive).not.toHaveBeenCalled();
  });
});

// ─── performStartupLiveCheck ──────────────────────────────────────────────────

describe('performStartupLiveCheck', () => {
  it('returns immediately when no user IDs', async () => {
    await performStartupLiveCheck(new Map(), new Map(), []);
    expect(getStreams).not.toHaveBeenCalled();
  });

  it('returns and logs when getStreams throws', async () => {
    vi.mocked(getStreams).mockRejectedValueOnce(new Error('API down'));
    await expect(performStartupLiveCheck(new Map(), new Map([['alice', 'u1']]), [])).resolves.not.toThrow();
    expect(setStreamerLive).not.toHaveBeenCalled();
  });

  it('handles a live streamer — calls postAnnouncement when no existing message', async () => {
    const stream = makeStream({ user_id: 'u1', type: 'live' });
    vi.mocked(getStreams).mockResolvedValue([stream]);
    const streamer = makeStreamer({ twitch_name: 'alice', discord_message_id: null });
    await performStartupLiveCheck(new Map(), new Map([['alice', 'u1']]), [streamer]);
    expect(postAnnouncement).toHaveBeenCalled();
  });

  it('handles an offline streamer with stored message — calls clearStreamerLive', async () => {
    vi.mocked(getStreams).mockResolvedValue([]);
    const streamer = makeStreamer({ twitch_name: 'alice', discord_message_id: 'msg1', discord_channel_id: 'ch1' });
    await performStartupLiveCheck(new Map(), new Map([['alice', 'u1']]), [streamer]);
    expect(clearStreamerLive).toHaveBeenCalledWith(10);
  });

  it('skips streamers with no matching loginToUserId entry', async () => {
    vi.mocked(getStreams).mockResolvedValue([]);
    const streamer = makeStreamer({ twitch_name: 'unknown', discord_message_id: 'msg1' });
    await performStartupLiveCheck(new Map(), new Map([['alice', 'u1']]), [streamer]);
    expect(clearStreamerLive).not.toHaveBeenCalled();
  });

  it('calls updateMultitwitch for each group with changes', async () => {
    const stream = makeStream({ user_id: 'u1', type: 'live' });
    vi.mocked(getStreams).mockResolvedValue([stream]);
    const channel = makeChannel();
    vi.mocked(getDiscordClient).mockReturnValue({ channels: { fetch: vi.fn().mockResolvedValue(channel) } } as any);
    const streamer = makeStreamer({ twitch_name: 'alice', discord_message_id: 'msg1', discord_channel_id: 'ch1', group: makeGroup({ id: 7 }) });
    await performStartupLiveCheck(new Map(), new Map([['alice', 'u1']]), [streamer]);
    expect(updateMultitwitch).toHaveBeenCalledWith(7, expect.any(Map));
  });
});
