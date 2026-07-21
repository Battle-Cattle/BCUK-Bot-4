import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../shared/statusStore', () => ({
  getStatus: vi.fn(),
}));

vi.mock('../db', () => ({
  getGuildById: vi.fn(),
  getGuildMemberUsers: vi.fn(),
}));

vi.mock('../twitch/twitchChannelName', () => ({
  normalizeTwitchChannelName: vi.fn((s: string) => (s ? s.toLowerCase() : null)),
}));

import { getGuildScopedStatus } from './guildScopedStatus';
import { getStatus } from '../shared/statusStore';
import { getGuildById, getGuildMemberUsers } from '../db';

const BASE_STATUS = {
  discord: { ready: true, tag: 'Bot#1234' },
  voice: { connected: false, channelName: null, playing: false, currentFile: null, lastCommand: null, lastSource: null, lastPlayedAt: null },
  twitch: {
    ourstreamer: { connected: true, lastConnectedAt: null, lastDisconnectedAt: null, isLive: false },
    otherguildstreamer: { connected: true, lastConnectedAt: null, lastDisconnectedAt: null, isLive: true },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getStatus).mockReturnValue(BASE_STATUS as any);
  vi.mocked(getGuildById).mockResolvedValue({ guild_id: 'guild-A', name: 'Our Guild', voice_channel_id: null });
  vi.mocked(getGuildMemberUsers).mockResolvedValue([
    { discord_id: '1', discord_name: 'Streamer', is_twitch_bot_enabled: true, twitch_name: 'ourstreamer', access_level: 2, is_owner: false },
  ]);
});

describe('getGuildScopedStatus — null guildId', () => {
  it('returns an empty-scoped snapshot without any DB lookup', async () => {
    const result = await getGuildScopedStatus(null);
    expect(result.discord.guildName).toBeNull();
    expect(result.twitch).toEqual({});
    expect(getGuildById).not.toHaveBeenCalled();
    expect(getGuildMemberUsers).not.toHaveBeenCalled();
  });

  it('still passes null through to the underlying statusStore lookup', async () => {
    await getGuildScopedStatus(null);
    expect(getStatus).toHaveBeenCalledWith(null);
  });
});

describe('getGuildScopedStatus — discord.guildName', () => {
  it('resolves to the requested guild\'s own name, not a joined list of every guild', async () => {
    const result = await getGuildScopedStatus('guild-A');
    expect(result.discord.guildName).toBe('Our Guild');
    expect(getGuildById).toHaveBeenCalledWith('guild-A');
  });

  it('is null when the guild is not found in the DB, without throwing', async () => {
    vi.mocked(getGuildById).mockResolvedValue(null);
    const result = await getGuildScopedStatus('guild-A');
    expect(result.discord.guildName).toBeNull();
  });
});

describe('getGuildScopedStatus — twitch scoping', () => {
  it('includes only channels owned by this guild\'s twitch-bot-enabled members', async () => {
    const result = await getGuildScopedStatus('guild-A');
    expect(Object.keys(result.twitch)).toEqual(['ourstreamer']);
    expect(result.twitch.otherguildstreamer).toBeUndefined();
  });

  it('excludes a member\'s twitch channel when is_twitch_bot_enabled is false', async () => {
    vi.mocked(getGuildMemberUsers).mockResolvedValue([
      { discord_id: '1', discord_name: 'Streamer', is_twitch_bot_enabled: false, twitch_name: 'ourstreamer', access_level: 2, is_owner: false },
    ]);
    const result = await getGuildScopedStatus('guild-A');
    expect(result.twitch).toEqual({});
  });

  it('excludes a member with no twitch_name set', async () => {
    vi.mocked(getGuildMemberUsers).mockResolvedValue([
      { discord_id: '1', discord_name: 'Streamer', is_twitch_bot_enabled: true, twitch_name: null, access_level: 2, is_owner: false },
    ]);
    const result = await getGuildScopedStatus('guild-A');
    expect(result.twitch).toEqual({});
  });

  it('returns no twitch channels when the guild has no members', async () => {
    vi.mocked(getGuildMemberUsers).mockResolvedValue([]);
    const result = await getGuildScopedStatus('guild-A');
    expect(result.twitch).toEqual({});
  });
});

describe('getGuildScopedStatus — voice', () => {
  it('passes through the already guild-scoped voice status unchanged', async () => {
    const result = await getGuildScopedStatus('guild-A');
    expect(result.voice).toEqual(BASE_STATUS.voice);
  });
});
