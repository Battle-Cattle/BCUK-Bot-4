import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../test-utils/loggerMock';

/** Mocks the shared logger so this module's log calls don't produce real output during tests. */
vi.mock('../shared/logger', () => ({ createLogger: mockLogger }));
vi.mock('./discordClientStore', () => ({ getDiscordClient: vi.fn() }));

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
  /** Minimal mock of `@discordjs/rest`'s HTTPError, carrying just the `status` this module reads. */
  class HTTPError extends Error {
    status: number;
    /** Builds a mock HTTPError with the given HTTP status. */
    constructor(status: number) {
      super('Service Unavailable');
      this.status = status;
    }
  }
  return {
    DiscordAPIError,
    HTTPError,
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
  getTextChannel,
  tryEditDiscordMessage,
} from './discordUtils';
import { DiscordAPIError, HTTPError } from 'discord.js';
import { getDiscordClient } from './discordClientStore';

// The mock above replaces DiscordAPIError with a simpler single-arg constructor.
// Cast here so TypeScript accepts the mock's signature without casting at every call site.
const MockedDiscordAPIError = DiscordAPIError as unknown as new (opts: { code: number; status: number }) => DiscordAPIError;
// Same story for HTTPError, mocked with a single-arg (status) constructor.
const MockedHTTPError = HTTPError as unknown as new (status: number) => HTTPError;

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

  it('retries a transient 5xx error and succeeds once the channel fetch recovers', async () => {
    vi.useFakeTimers();
    try {
      const deleteMessage = vi.fn().mockResolvedValue(undefined);
      const fetchMessage = vi.fn().mockResolvedValue({ delete: deleteMessage });
      const channelsFetch = vi.fn()
        .mockRejectedValueOnce(new MockedHTTPError(503))
        .mockResolvedValueOnce({ isTextBased: () => true, messages: { fetch: fetchMessage } });
      vi.mocked(getDiscordClient).mockReturnValue({ channels: { fetch: channelsFetch } } as any);

      const promise = tryDeleteDiscordMessage('chan1', 'msg1');
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(promise).resolves.toBeUndefined();
      expect(channelsFetch).toHaveBeenCalledTimes(2);
      expect(deleteMessage).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rethrows a transient 5xx error once retries are exhausted', async () => {
    vi.useFakeTimers();
    try {
      const err = new MockedHTTPError(503);
      const channelsFetch = vi.fn().mockRejectedValue(err);
      vi.mocked(getDiscordClient).mockReturnValue({ channels: { fetch: channelsFetch } } as any);

      const promise = tryDeleteDiscordMessage('chan1', 'msg1');
      const assertion = expect(promise).rejects.toBe(err);
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.advanceTimersByTimeAsync(15_000);
      await assertion;
      expect(channelsFetch).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('getTextChannel', () => {
  it('returns the channel when it is text-based', async () => {
    const channel = { isTextBased: () => true };
    const channelsFetch = vi.fn().mockResolvedValue(channel);
    const client = { channels: { fetch: channelsFetch } } as any;

    await expect(getTextChannel(client, 'chan1')).resolves.toBe(channel);
    expect(channelsFetch).toHaveBeenCalledWith('chan1');
  });

  it('returns null when the channel is not text-based', async () => {
    const channelsFetch = vi.fn().mockResolvedValue({ isTextBased: () => false });
    const client = { channels: { fetch: channelsFetch } } as any;

    await expect(getTextChannel(client, 'chan1')).resolves.toBeNull();
  });

  it('returns null when the channel fetch resolves to null', async () => {
    const channelsFetch = vi.fn().mockResolvedValue(null);
    const client = { channels: { fetch: channelsFetch } } as any;

    await expect(getTextChannel(client, 'chan1')).resolves.toBeNull();
  });
});

describe('tryEditDiscordMessage', () => {
  it('returns false without fetching a message when the channel is not text-based', async () => {
    const fetchMessage = vi.fn();
    const channelsFetch = vi.fn().mockResolvedValue({ isTextBased: () => false, messages: { fetch: fetchMessage } });
    const client = { channels: { fetch: channelsFetch } } as any;

    await expect(tryEditDiscordMessage(client, 'chan1', 'msg1', { content: 'hi' })).resolves.toBe(false);
    expect(fetchMessage).not.toHaveBeenCalled();
  });

  it('returns false when the channel fetch resolves to null', async () => {
    const channelsFetch = vi.fn().mockResolvedValue(null);
    const client = { channels: { fetch: channelsFetch } } as any;

    await expect(tryEditDiscordMessage(client, 'chan1', 'msg1', { content: 'hi' })).resolves.toBe(false);
  });

  it('fetches and edits the message when the channel is text-based', async () => {
    const editMessage = vi.fn().mockResolvedValue(undefined);
    const fetchMessage = vi.fn().mockResolvedValue({ edit: editMessage });
    const channelsFetch = vi.fn().mockResolvedValue({ isTextBased: () => true, messages: { fetch: fetchMessage } });
    const client = { channels: { fetch: channelsFetch } } as any;

    await expect(tryEditDiscordMessage(client, 'chan1', 'msg1', { content: 'hi' })).resolves.toBe(true);
    expect(channelsFetch).toHaveBeenCalledWith('chan1');
    expect(fetchMessage).toHaveBeenCalledWith('msg1');
    expect(editMessage).toHaveBeenCalledWith({ content: 'hi' });
  });

  it('returns false without throwing on a not-found error', async () => {
    const notFoundErr = new MockedDiscordAPIError({ code: UNKNOWN_MESSAGE, status: 200 });
    const fetchMessage = vi.fn().mockRejectedValue(notFoundErr);
    const channelsFetch = vi.fn().mockResolvedValue({ isTextBased: () => true, messages: { fetch: fetchMessage } });
    const client = { channels: { fetch: channelsFetch } } as any;

    await expect(tryEditDiscordMessage(client, 'chan1', 'msg1', { content: 'hi' })).resolves.toBe(false);
  });

  it('rethrows an unrelated error', async () => {
    const otherErr = new Error('network blip');
    const fetchMessage = vi.fn().mockRejectedValue(otherErr);
    const channelsFetch = vi.fn().mockResolvedValue({ isTextBased: () => true, messages: { fetch: fetchMessage } });
    const client = { channels: { fetch: channelsFetch } } as any;

    await expect(tryEditDiscordMessage(client, 'chan1', 'msg1', { content: 'hi' })).rejects.toThrow('network blip');
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

  it('returns voice channels sorted alphabetically, filtering out non-voice entries, reading from the cache (no REST fetch)', async () => {
    const channels = [
      { id: '1', name: 'Zeta', type: 2 },
      { id: '2', name: 'General Text', type: 0 },
      { id: '3', name: 'Alpha', type: 2 },
    ];
    const channelsFetch = vi.fn();
    const cache = new Map(channels.map((ch) => [ch.id, ch]));
    const guildsFetch = vi.fn().mockResolvedValue({ channels: { cache, fetch: channelsFetch } });
    vi.mocked(getDiscordClient).mockReturnValue({ guilds: { fetch: guildsFetch } } as any);

    const result = await getAvailableVoiceChannels('guild1');
    expect(guildsFetch).toHaveBeenCalledWith('guild1');
    expect(channelsFetch).not.toHaveBeenCalled();
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
