import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../shared/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('../shared/config', () => ({
  DISCORD_GUILD_ID: 'defaultGuild',
  DISCORD_VOICE_CHANNEL_ID: 'defaultChannel',
}));

vi.mock('../db', () => ({
  findUserByTwitchName: vi.fn(),
  findUserByDiscordGuildId: vi.fn(),
}));

import { findUserByTwitchName, findUserByDiscordGuildId } from '../db';
import type { DbUser } from '../db';
import {
  resolveCurrentVoiceChannel,
  resolveContextForTwitchChannel,
  resolveContextForDiscordGuild,
} from './voiceResolver';

function makeClient(voiceChannelId: string | null = 'vc1', shouldThrow = false): any {
  return {
    guilds: {
      fetch: vi.fn().mockResolvedValue({
        members: {
          fetch: shouldThrow
            ? vi.fn().mockRejectedValue(new Error('Not found'))
            : vi.fn().mockResolvedValue({ voice: { channelId: voiceChannelId } }),
        },
      }),
    },
  };
}

function makeUser(overrides: Partial<DbUser> = {}): DbUser {
  return {
    discord_id: 'user1',
    discord_name: 'Alice',
    is_twitch_bot_enabled: true,
    twitch_name: 'alice',
    access_level: 2,
    discord_guild_id: 'guild1',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveCurrentVoiceChannel', () => {
  it('returns the voice channel ID when user is in voice', async () => {
    const client = makeClient('vc1');
    const result = await resolveCurrentVoiceChannel(client, 'guild1', 'user1');
    expect(result).toBe('vc1');
  });

  it('returns null when user is not in a voice channel', async () => {
    const client = makeClient(null);
    const result = await resolveCurrentVoiceChannel(client, 'guild1', 'user1');
    expect(result).toBeNull();
  });

  it('returns null and logs a warning when member fetch throws', async () => {
    const client = makeClient(null, true);
    const result = await resolveCurrentVoiceChannel(client, 'guild1', 'user1');
    expect(result).toBeNull();
  });
});

describe('resolveContextForTwitchChannel', () => {
  it('returns ctx with user guild and current voice channel', async () => {
    vi.mocked(findUserByTwitchName).mockResolvedValue(makeUser());
    const client = makeClient('vc42');
    const ctx = await resolveContextForTwitchChannel(client, 'alice');
    expect(ctx).toEqual({ guildId: 'guild1', voiceChannelId: 'vc42' });
  });

  it('returns null when user not in voice', async () => {
    vi.mocked(findUserByTwitchName).mockResolvedValue(makeUser());
    const client = makeClient(null);
    const ctx = await resolveContextForTwitchChannel(client, 'alice');
    expect(ctx).toBeNull();
  });

  it('returns fallback context when no user found', async () => {
    vi.mocked(findUserByTwitchName).mockResolvedValue(null);
    const client = makeClient('vc1');
    const ctx = await resolveContextForTwitchChannel(client, 'unknown');
    expect(ctx).toEqual({ guildId: 'defaultGuild', voiceChannelId: 'defaultChannel' });
  });

  it('returns fallback context when user has no guild configured', async () => {
    vi.mocked(findUserByTwitchName).mockResolvedValue(makeUser({ discord_guild_id: null }));
    const client = makeClient('vc1');
    const ctx = await resolveContextForTwitchChannel(client, 'alice');
    expect(ctx).toEqual({ guildId: 'defaultGuild', voiceChannelId: 'defaultChannel' });
  });
});

describe('resolveContextForDiscordGuild', () => {
  it('returns ctx with configured user guild and current voice channel', async () => {
    vi.mocked(findUserByDiscordGuildId).mockResolvedValue(makeUser());
    const client = makeClient('vc7');
    const ctx = await resolveContextForDiscordGuild(client, 'guild1');
    expect(ctx).toEqual({ guildId: 'guild1', voiceChannelId: 'vc7' });
  });

  it('returns null when user not in voice', async () => {
    vi.mocked(findUserByDiscordGuildId).mockResolvedValue(makeUser());
    const client = makeClient(null);
    const ctx = await resolveContextForDiscordGuild(client, 'guild1');
    expect(ctx).toBeNull();
  });

  it('returns null when guild is unknown and not the default guild', async () => {
    vi.mocked(findUserByDiscordGuildId).mockResolvedValue(null);
    const client = makeClient('vc1');
    const ctx = await resolveContextForDiscordGuild(client, 'unknownGuild');
    expect(ctx).toBeNull();
  });

  it('returns fallback context when guild matches default and no user configured', async () => {
    vi.mocked(findUserByDiscordGuildId).mockResolvedValue(null);
    const client = makeClient('vc1');
    const ctx = await resolveContextForDiscordGuild(client, 'defaultGuild');
    expect(ctx).toEqual({ guildId: 'defaultGuild', voiceChannelId: 'defaultChannel' });
  });
});
