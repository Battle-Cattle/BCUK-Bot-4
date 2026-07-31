import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('dotenv', () => ({ default: { config: vi.fn() } }));

const REQUIRED_ENV: Record<string, string> = {
  DISCORD_TOKEN: 'discord-token',
  TWITCH_USERNAME: 'bot-user',
  TWITCH_OAUTH_TOKEN: 'oauth:token',
  TWITCH_CLIENT_ID: 'twitch-client-id',
  TWITCH_CLIENT_SECRET: 'twitch-client-secret',
  DB_USER: 'root',
  DB_PASSWORD: 'password',
  DB_NAME: 'testdb',
  SESSION_SECRET: 'a'.repeat(32),
  DISCORD_CLIENT_ID: 'discord-client-id',
  DISCORD_CLIENT_SECRET: 'discord-client-secret',
  DISCORD_CALLBACK_URL: 'http://localhost:3000/auth/discord/callback',
};

const originalEnv = { ...process.env };

/** Replaces process.env with the required baseline plus overrides (omitting keys set to undefined), then imports a fresh copy of config.ts. */
async function loadConfig(overrides: Record<string, string | undefined> = {}) {
  const merged: Record<string, string | undefined> = { ...REQUIRED_ENV, ...overrides };
  const next: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(merged)) {
    if (value !== undefined) next[key] = value;
  }
  process.env = next;
  vi.resetModules();
  return import('./config.js');
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe('config — required env vars', () => {
  it('loads all required values when present', async () => {
    const config = await loadConfig();
    expect(config.DISCORD_TOKEN).toBe('discord-token');
    expect(config.TWITCH_USERNAME).toBe('bot-user');
    expect(config.TWITCH_OAUTH_TOKEN).toBe('oauth:token');
    expect(config.TWITCH_CLIENT_ID).toBe('twitch-client-id');
    expect(config.TWITCH_CLIENT_SECRET).toBe('twitch-client-secret');
    expect(config.DB_USER).toBe('root');
    expect(config.DB_PASSWORD).toBe('password');
    expect(config.DB_NAME).toBe('testdb');
    expect(config.DISCORD_CLIENT_ID).toBe('discord-client-id');
    expect(config.DISCORD_CLIENT_SECRET).toBe('discord-client-secret');
    expect(config.DISCORD_CALLBACK_URL).toBe('http://localhost:3000/auth/discord/callback');
  });

  it.each([
    'DISCORD_TOKEN',
    'TWITCH_USERNAME',
    'TWITCH_OAUTH_TOKEN',
    'TWITCH_CLIENT_ID',
    'TWITCH_CLIENT_SECRET',
    'DB_USER',
    'DB_PASSWORD',
    'DB_NAME',
    'DISCORD_CLIENT_ID',
    'DISCORD_CLIENT_SECRET',
    'DISCORD_CALLBACK_URL',
  ])('throws when %s is missing', async (missingVar) => {
    await expect(loadConfig({ [missingVar]: undefined })).rejects.toThrow(
      `Missing required environment variable: ${missingVar}`,
    );
  });

  it('throws when a required value is an empty string', async () => {
    await expect(loadConfig({ DB_USER: '' })).rejects.toThrow(
      'Missing required environment variable: DB_USER',
    );
  });
});

describe('config — DB_HOST / DB_PORT', () => {
  it('defaults DB_HOST to localhost when unset', async () => {
    const config = await loadConfig({ DB_HOST: undefined });
    expect(config.DB_HOST).toBe('localhost');
  });

  it('defaults DB_PORT to 3306 when unset', async () => {
    const config = await loadConfig({ DB_PORT: undefined });
    expect(config.DB_PORT).toBe(3306);
  });

  it('parses a valid DB_PORT', async () => {
    const config = await loadConfig({ DB_PORT: '3307' });
    expect(config.DB_PORT).toBe(3307);
  });

  it('throws for a non-numeric DB_PORT', async () => {
    await expect(loadConfig({ DB_PORT: 'not-a-number' })).rejects.toThrow(
      'Invalid DB_PORT: must be a number',
    );
  });
});

describe('config — parsePositiveIntEnv-backed values', () => {
  it('uses the default SFX_MAX_FILE_MB (10) when unset', async () => {
    const config = await loadConfig({ SFX_MAX_FILE_MB: undefined });
    expect(config.SFX_MAX_FILE_MB).toBe(10);
  });

  it('parses a valid positive integer for SFX_MAX_FILE_MB', async () => {
    const config = await loadConfig({ SFX_MAX_FILE_MB: '25' });
    expect(config.SFX_MAX_FILE_MB).toBe(25);
  });

  it('falls back to the default for a malformed value like "1024MB"', async () => {
    const config = await loadConfig({ SFX_MAX_FILE_MB: '1024MB' });
    expect(config.SFX_MAX_FILE_MB).toBe(10);
  });

  it('falls back to the default for a non-integer like "1.5"', async () => {
    const config = await loadConfig({ SFX_MAX_FILE_MB: '1.5' });
    expect(config.SFX_MAX_FILE_MB).toBe(10);
  });

  it('falls back to the default for zero', async () => {
    const config = await loadConfig({ SFX_MAX_FILE_MB: '0' });
    expect(config.SFX_MAX_FILE_MB).toBe(10);
  });

  it('falls back to the default for a negative value', async () => {
    const config = await loadConfig({ SFX_MAX_FILE_MB: '-5' });
    expect(config.SFX_MAX_FILE_MB).toBe(10);
  });

  it('defaults OVERLAY_MAX_FILE_MB to 100 when unset', async () => {
    const config = await loadConfig({ OVERLAY_MAX_FILE_MB: undefined });
    expect(config.OVERLAY_MAX_FILE_MB).toBe(100);
  });

  it('defaults COMPANION_MAX_SSE_PER_TOKEN to 3 when unset', async () => {
    const config = await loadConfig({ COMPANION_MAX_SSE_PER_TOKEN: undefined });
    expect(config.COMPANION_MAX_SSE_PER_TOKEN).toBe(3);
  });

  it('defaults OVERLAY_MAX_SSE_PER_CHANNEL to 10 when unset', async () => {
    const config = await loadConfig({ OVERLAY_MAX_SSE_PER_CHANNEL: undefined });
    expect(config.OVERLAY_MAX_SSE_PER_CHANNEL).toBe(10);
  });

  it('defaults CHANNEL_POINTS_MAX_SSE_PER_STREAMER to 5 when unset', async () => {
    const config = await loadConfig({ CHANNEL_POINTS_MAX_SSE_PER_STREAMER: undefined });
    expect(config.CHANNEL_POINTS_MAX_SSE_PER_STREAMER).toBe(5);
  });

  it('defaults ALERT_MAX_IMAGE_MB to 10 when unset', async () => {
    const config = await loadConfig({ ALERT_MAX_IMAGE_MB: undefined });
    expect(config.ALERT_MAX_IMAGE_MB).toBe(10);
  });

  it('defaults ALERT_MAX_SOUND_MB to 5 when unset', async () => {
    const config = await loadConfig({ ALERT_MAX_SOUND_MB: undefined });
    expect(config.ALERT_MAX_SOUND_MB).toBe(5);
  });

  it('defaults ALERT_MAX_SSE_PER_CHANNEL to 10 when unset', async () => {
    const config = await loadConfig({ ALERT_MAX_SSE_PER_CHANNEL: undefined });
    expect(config.ALERT_MAX_SSE_PER_CHANNEL).toBe(10);
  });

  it('defaults SSE_MAX_TOTAL_CONNECTIONS to 500 when unset', async () => {
    const config = await loadConfig({ SSE_MAX_TOTAL_CONNECTIONS: undefined });
    expect(config.SSE_MAX_TOTAL_CONNECTIONS).toBe(500);
  });

  it('defaults DASHBOARD_EVENTS_MAX_SSE_PER_STREAMER to 5 when unset', async () => {
    const config = await loadConfig({ DASHBOARD_EVENTS_MAX_SSE_PER_STREAMER: undefined });
    expect(config.DASHBOARD_EVENTS_MAX_SSE_PER_STREAMER).toBe(5);
  });

  it('defaults DASHBOARD_STATUS_MAX_SSE_PER_GUILD to 10 when unset', async () => {
    const config = await loadConfig({ DASHBOARD_STATUS_MAX_SSE_PER_GUILD: undefined });
    expect(config.DASHBOARD_STATUS_MAX_SSE_PER_GUILD).toBe(10);
  });
});

describe('config — GLOBAL_COOLDOWN_MS', () => {
  it('defaults to 3000 when unset', async () => {
    const config = await loadConfig({ GLOBAL_COOLDOWN_MS: undefined });
    expect(config.GLOBAL_COOLDOWN_MS).toBe(3000);
  });

  it('parses a valid value', async () => {
    const config = await loadConfig({ GLOBAL_COOLDOWN_MS: '5000' });
    expect(config.GLOBAL_COOLDOWN_MS).toBe(5000);
  });

  it('throws for a non-numeric value', async () => {
    await expect(loadConfig({ GLOBAL_COOLDOWN_MS: 'soon' })).rejects.toThrow(
      'Invalid GLOBAL_COOLDOWN_MS: must be a number',
    );
  });
});

describe('config — WEB_PORT', () => {
  it('defaults to 3000 when unset', async () => {
    const config = await loadConfig({ WEB_PORT: undefined });
    expect(config.WEB_PORT).toBe(3000);
  });

  it('parses a valid value', async () => {
    const config = await loadConfig({ WEB_PORT: '8080' });
    expect(config.WEB_PORT).toBe(8080);
  });

  it('throws for a non-numeric value', async () => {
    await expect(loadConfig({ WEB_PORT: 'nope' })).rejects.toThrow(
      'Invalid WEB_PORT: must be a number',
    );
  });
});

describe('config — SESSION_SECRET', () => {
  it('throws when left as the placeholder value', async () => {
    await expect(loadConfig({ SESSION_SECRET: '__REQUIRED_GENERATE_LONG_RANDOM_SECRET__' })).rejects.toThrow(
      'SESSION_SECRET has not been set',
    );
  });

  it('throws when shorter than 32 characters', async () => {
    await expect(loadConfig({ SESSION_SECRET: 'short-secret' })).rejects.toThrow(
      'SESSION_SECRET must be at least 32 characters long',
    );
  });

  it('accepts a secret exactly 32 characters long', async () => {
    const config = await loadConfig({ SESSION_SECRET: 'b'.repeat(32) });
    expect(config.SESSION_SECRET).toBe('b'.repeat(32));
  });
});

describe('config — PUBLIC_URL', () => {
  it('derives the origin from DISCORD_CALLBACK_URL, dropping path/query', async () => {
    const config = await loadConfig({
      DISCORD_CALLBACK_URL: 'https://example.com:8443/auth/discord/callback?foo=bar',
    });
    expect(config.PUBLIC_URL).toBe('https://example.com:8443');
  });
});

describe('config — Twitch EventSub / encryption settings', () => {
  it('defaults TWITCH_EVENTSUB_REDIRECT_URI to an empty string when unset', async () => {
    const config = await loadConfig({ TWITCH_EVENTSUB_REDIRECT_URI: undefined });
    expect(config.TWITCH_EVENTSUB_REDIRECT_URI).toBe('');
  });

  it('passes through TWITCH_EVENTSUB_REDIRECT_URI when set', async () => {
    const config = await loadConfig({ TWITCH_EVENTSUB_REDIRECT_URI: 'https://example.com/callback' });
    expect(config.TWITCH_EVENTSUB_REDIRECT_URI).toBe('https://example.com/callback');
  });

  it('defaults EVENTSUB_TOKEN_SECRET to an empty string when unset', async () => {
    const config = await loadConfig({ EVENTSUB_TOKEN_SECRET: undefined });
    expect(config.EVENTSUB_TOKEN_SECRET).toBe('');
  });

  it('passes through EVENTSUB_TOKEN_SECRET when set', async () => {
    const config = await loadConfig({ EVENTSUB_TOKEN_SECRET: 'f'.repeat(64) });
    expect(config.EVENTSUB_TOKEN_SECRET).toBe('f'.repeat(64));
  });

  it('throws at startup when EVENTSUB_TOKEN_SECRET is the wrong length', async () => {
    await expect(loadConfig({ EVENTSUB_TOKEN_SECRET: 'f'.repeat(63) })).rejects.toThrow(
      'EVENTSUB_TOKEN_SECRET must be exactly 64 hex characters (32 bytes)',
    );
  });

  it('throws at startup when EVENTSUB_TOKEN_SECRET contains non-hex characters', async () => {
    await expect(loadConfig({ EVENTSUB_TOKEN_SECRET: 'z'.repeat(64) })).rejects.toThrow(
      'EVENTSUB_TOKEN_SECRET must be exactly 64 hex characters (32 bytes)',
    );
  });
});

describe('config — SFX/OVERLAY folder defaults', () => {
  it('defaults SFX_FOLDER and OVERLAY_FOLDER when unset', async () => {
    const config = await loadConfig({ SFX_FOLDER: undefined, OVERLAY_FOLDER: undefined });
    expect(config.SFX_FOLDER).toBe('./sfx');
    expect(config.OVERLAY_FOLDER).toBe('./overlay-videos');
  });

  it('passes through SFX_FOLDER and OVERLAY_FOLDER when set', async () => {
    const config = await loadConfig({ SFX_FOLDER: '/custom/sfx', OVERLAY_FOLDER: '/custom/overlay' });
    expect(config.SFX_FOLDER).toBe('/custom/sfx');
    expect(config.OVERLAY_FOLDER).toBe('/custom/overlay');
  });

  it('defaults ALERT_ASSETS_FOLDER when unset', async () => {
    const config = await loadConfig({ ALERT_ASSETS_FOLDER: undefined });
    expect(config.ALERT_ASSETS_FOLDER).toBe('./alert-assets');
  });

  it('passes through ALERT_ASSETS_FOLDER when set', async () => {
    const config = await loadConfig({ ALERT_ASSETS_FOLDER: '/custom/alerts' });
    expect(config.ALERT_ASSETS_FOLDER).toBe('/custom/alerts');
  });
});
