import dotenv from 'dotenv';
dotenv.config({ override: true });

function require_env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export const DISCORD_TOKEN = require_env('DISCORD_TOKEN');
export const DISCORD_GUILD_ID = require_env('DISCORD_GUILD_ID');
export const DISCORD_VOICE_CHANNEL_ID = require_env('DISCORD_VOICE_CHANNEL_ID');

export const TWITCH_USERNAME = require_env('TWITCH_USERNAME');
export const TWITCH_OAUTH_TOKEN = require_env('TWITCH_OAUTH_TOKEN');

// Twitch stream monitor (stream announcements — separate from chat bot)
// Client credentials for Twitch API / EventSub
export const TWITCH_CLIENT_ID     = require_env('TWITCH_CLIENT_ID');
export const TWITCH_CLIENT_SECRET = require_env('TWITCH_CLIENT_SECRET');

// TikTok LIVE monitoring
// Comma-separated list of TikTok usernames whose LIVE streams to monitor
export const TIKTOK_CHANNELS: string[] = (process.env.TIKTOK_CHANNELS ?? '')
  .split(',')
  .map((c) => c.trim().replace(/^@/, ''))
  .filter(Boolean);
// Optional sign API key from https://www.eulerstream.com (improves connection reliability)
export const TIKTOK_SIGN_API_KEY: string | undefined = process.env.TIKTOK_SIGN_API_KEY || undefined;

export const DB_HOST = process.env.DB_HOST ?? 'localhost';
const _DB_PORT = parseInt(process.env.DB_PORT ?? '3306', 10);
if (Number.isNaN(_DB_PORT)) throw new Error('Invalid DB_PORT: must be a number');
export const DB_PORT = _DB_PORT;
export const DB_USER = require_env('DB_USER');
export const DB_PASSWORD = require_env('DB_PASSWORD');
export const DB_NAME = require_env('DB_NAME');

export const SFX_FOLDER = process.env.SFX_FOLDER ?? './sfx';
const _COOLDOWN = parseInt(process.env.GLOBAL_COOLDOWN_MS ?? '3000', 10);
if (Number.isNaN(_COOLDOWN)) throw new Error('Invalid GLOBAL_COOLDOWN_MS: must be a number');
export const GLOBAL_COOLDOWN_MS = _COOLDOWN;

// Web panel
const _WEB_PORT = parseInt(process.env.WEB_PORT ?? '3000', 10);
if (Number.isNaN(_WEB_PORT)) throw new Error('Invalid WEB_PORT: must be a number');
export const WEB_PORT = _WEB_PORT;
export const SESSION_SECRET = require_env('SESSION_SECRET');
if (SESSION_SECRET === '__REQUIRED_GENERATE_LONG_RANDOM_SECRET__') {
  throw new Error('SESSION_SECRET has not been set — replace the placeholder in .env with a long random string');
}
export const DISCORD_CLIENT_ID = require_env('DISCORD_CLIENT_ID');
export const DISCORD_CLIENT_SECRET = require_env('DISCORD_CLIENT_SECRET');
export const DISCORD_CALLBACK_URL = require_env('DISCORD_CALLBACK_URL');
