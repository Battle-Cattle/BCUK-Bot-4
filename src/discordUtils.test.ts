import { describe, it, expect, vi } from 'vitest';

vi.mock('./logger', () => ({ createLogger: () => ({ warn: vi.fn(), error: vi.fn() }) }));
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

import { isDiscordNotFoundError, isPermanentVoiceMisconfigurationError } from './discordUtils';
import { DiscordAPIError } from 'discord.js';

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
  it('returns true for a missing-config message', () => {
    expect(isPermanentVoiceMisconfigurationError(
      new Error('Missing DISCORD_GUILD_ID or DISCORD_VOICE_CHANNEL_ID'),
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
