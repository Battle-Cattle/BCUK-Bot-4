import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../shared/logger', () => ({ createLogger: () => ({ warn: vi.fn(), error: vi.fn() }) }));
vi.mock('./discordBot', () => ({ getDiscordClient: vi.fn() }));

vi.mock('discord.js', () => {
  class DiscordAPIError extends Error {
    code: number;
    status: number;
    constructor({ code, status }: { code: number; status: number }) {
      super('Discord API Error');
      this.code = code;
      this.status = status;
    }
  }
  return {
    DiscordAPIError,
    RESTJSONErrorCodes: {
      UnknownMessage: 10008,
      UnknownChannel: 10003,
      MissingAccess: 50001,
    },
    ChannelType: { GuildVoice: 2 },
  };
});

const UNKNOWN_MESSAGE = 10008;
const UNKNOWN_CHANNEL = 10003;
const MISSING_ACCESS = 50001;

import {
  isDiscordNotFoundError,
  isPermanentVoiceMisconfigurationError,
  tryDeleteDiscordMessage,
  getAvailableVoiceChannels,
} from './discordUtils';
import { DiscordAPIError } from 'discord.js';
import { getDiscordClient } from './discordBot';

// The mock above replaces DiscordAPIError with a simpler single-arg constructor.
// Cast here so TypeScript accepts the mock's signature without casting at every call site.
const MockedDiscordAPIError = DiscordAPIError as unknown as new (opts: { code: number; status: number }) => DiscordAPIError;

describe('isDiscordNotFoundError', () => {
  it('returns true for UnknownMessage code', () => {
    const err = new MockedDiscordAPIError({ code: UNKNOWN_MESSAGE, status: 200 });
    expect(isDiscordNotFoundError(err)).toBe(true);
  });

  it('returns true for UnknownChannel code', () => {
    const err = new MockedDiscordAPIError({ code: UNKNOWN_CHANNEL, status: 200 });
    expect(isDiscordNotFoundError(err)).toBe(true);
  });

  it('returns true when status is 404 regardless of code', () => {
    const err = new MockedDiscordAPIError({ code: 99999, status: 404 });
    expect(isDiscordNotFoundError(err)).toBe(true);
  });

  it('returns false for unrelated Discord errors', () => {
    const err = new MockedDiscordAPIError({ code: MISSING_ACCESS, status: 403 });
    expect(isDiscordNotFoundError(err)).toBe(false);
  });

  it('returns false for plain Error objects', () => {
    expect(isDiscordNotFoundError(new Error('not found'))).toBe(false);
  });

  it('returns false for null and undefined', () => {
    expect(isDiscordNotFoundError(null)).toBe(false);
    expect(isDiscordNotFoundError(undefined)).toBe(false);
  });
});

describe('isPermanentVoiceMisconfigurationError', () => {
  it('returns true for the legacy missing-config message', () => {
    expect(isPermanentVoiceMisconfigurationError(
      new Error('Missing DISCORD_GUILD_ID or DISCORD_VOICE_CHANNEL_ID'),
    )).toBe(true);
  });

  it('returns true for the current missing-config message', () => {
    expect(isPermanentVoiceMisconfigurationError(
      new Error('Missing guild ID or voice channel ID'),
    )).toBe(true);
  });

  it('returns true for "is not a voice channel" message', () => {
    expect(isPermanentVoiceMisconfigurationError(
      new Error('Target is not a voice channel'),
    )).toBe(true);
  });

  it('returns true for a 403 status error', () => {
    const err = Object.assign(new Error('Forbidden'), { status: 403 });
    expect(isPermanentVoiceMisconfigurationError(err)).toBe(true);
  });

  it('returns true for MissingAccess code', () => {
    const err = Object.assign(new Error('No access'), { code: MISSING_ACCESS });
    expect(isPermanentVoiceMisconfigurationError(err)).toBe(true);
  });

  it('returns true when the inner check is a 404 DiscordAPIError', () => {
    const err = new MockedDiscordAPIError({ code: UNKNOWN_CHANNEL, status: 200 });
    expect(isPermanentVoiceMisconfigurationError(err)).toBe(true);
  });

  it('returns false for a generic unrelated error', () => {
    expect(isPermanentVoiceMisconfigurationError(new Error('network timeout'))).toBe(false);
  });

  it('returns false for non-Error values', () => {
    expect(isPermanentVoiceMisconfigurationError(null)).toBe(false);
    expect(isPermanentVoiceMisconfigurationError('string error')).toBe(false);
  });
});

describe('tryDeleteDiscordMessage', () => {
  beforeEach(() => {
    vi.mocked(getDiscordClient).mockReset();
  });

  it('returns without fetching anything when there is no client', async () => {
    vi.mocked(getDiscordClient).mockReturnValue(null);
    await expect(tryDeleteDiscordMessage('chan1', 'msg1')).resolves.toBeUndefined();
  });

  it('returns early when the channel is not text-based', async () => {
    const fetchMessages = vi.fn();
    const channelsFetch = vi.fn().mockResolvedValue({ isTextBased: () => false, messages: { fetch: fetchMessages } });
    vi.mocked(getDiscordClient).mockReturnValue({ channels: { fetch: channelsFetch } } as any);

    await tryDeleteDiscordMessage('chan1', 'msg1');
    expect(fetchMessages).not.toHaveBeenCalled();
  });

  it('returns early when the channel fetch resolves to null', async () => {
    const channelsFetch = vi.fn().mockResolvedValue(null);
    vi.mocked(getDiscordClient).mockReturnValue({ channels: { fetch: channelsFetch } } as any);

    await expect(tryDeleteDiscordMessage('chan1', 'msg1')).resolves.toBeUndefined();
  });

  it('fetches and deletes the message when the channel is text-based', async () => {
    const deleteMessage = vi.fn().mockResolvedValue(undefined);
    const fetchMessage = vi.fn().mockResolvedValue({ delete: deleteMessage });
    const channelsFetch = vi.fn().mockResolvedValue({ isTextBased: () => true, messages: { fetch: fetchMessage } });
    vi.mocked(getDiscordClient).mockReturnValue({ channels: { fetch: channelsFetch } } as any);

    await tryDeleteDiscordMessage('chan1', 'msg1');
    expect(channelsFetch).toHaveBeenCalledWith('chan1');
    expect(fetchMessage).toHaveBeenCalledWith('msg1');
    expect(deleteMessage).toHaveBeenCalledOnce();
  });

  it('swallows a not-found error without throwing', async () => {
    const notFoundErr = new MockedDiscordAPIError({ code: UNKNOWN_MESSAGE, status: 200 });
    const channelsFetch = vi.fn().mockRejectedValue(notFoundErr);
    vi.mocked(getDiscordClient).mockReturnValue({ channels: { fetch: channelsFetch } } as any);

    await expect(tryDeleteDiscordMessage('chan1', 'msg1')).resolves.toBeUndefined();
  });

  it('rethrows an unrelated error', async () => {
    const otherErr = new Error('network blip');
    const channelsFetch = vi.fn().mockRejectedValue(otherErr);
    vi.mocked(getDiscordClient).mockReturnValue({ channels: { fetch: channelsFetch } } as any);

    await expect(tryDeleteDiscordMessage('chan1', 'msg1')).rejects.toThrow('network blip');
  });
});

describe('getAvailableVoiceChannels', () => {
  beforeEach(() => {
    vi.mocked(getDiscordClient).mockReset();
  });

  it('returns an empty array when there is no client', async () => {
    vi.mocked(getDiscordClient).mockReturnValue(null);
    await expect(getAvailableVoiceChannels('guild1')).resolves.toEqual([]);
  });

  it('returns voice channels sorted alphabetically, filtering out non-voice/null entries', async () => {
    // discord.js Collection#fetch() resolves to a Collection, which (like the array used
    // here) exposes filter/map/sort — the code under test only relies on those methods.
    const channels = [
      { id: '1', name: 'Zeta', type: 2 },
      { id: '2', name: 'General Text', type: 0 },
      { id: '3', name: 'Alpha', type: 2 },
      null,
    ];
    const guildsFetch = vi.fn().mockResolvedValue({ channels: { fetch: vi.fn().mockResolvedValue(channels) } });
    vi.mocked(getDiscordClient).mockReturnValue({ guilds: { fetch: guildsFetch } } as any);

    const result = await getAvailableVoiceChannels('guild1');
    expect(guildsFetch).toHaveBeenCalledWith('guild1');
    expect(result).toEqual([
      { id: '3', name: 'Alpha' },
      { id: '1', name: 'Zeta' },
    ]);
  });

  it('rethrows a not-found error (logged as warn instead of error)', async () => {
    const notFoundErr = new MockedDiscordAPIError({ code: UNKNOWN_CHANNEL, status: 200 });
    const guildsFetch = vi.fn().mockRejectedValue(notFoundErr);
    vi.mocked(getDiscordClient).mockReturnValue({ guilds: { fetch: guildsFetch } } as any);

    await expect(getAvailableVoiceChannels('missing-guild')).rejects.toBe(notFoundErr);
  });

  it('rethrows an unrelated error', async () => {
    const otherErr = new Error('api down');
    const guildsFetch = vi.fn().mockRejectedValue(otherErr);
    vi.mocked(getDiscordClient).mockReturnValue({ guilds: { fetch: guildsFetch } } as any);

    await expect(getAvailableVoiceChannels('guild1')).rejects.toThrow('api down');
  });
});
