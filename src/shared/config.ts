import dotenv from 'dotenv';
dotenv.config();

function require_env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export const DISCORD_TOKEN = require_env('DISCORD_TOKEN');

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
// Use Number (not parseInt) so malformed values like `1024MB` or `1.5` fall back
// to the safe default instead of being silently truncated to a valid-looking cap.
const _SFX_MAX_FILE_MB = Number(process.env.SFX_MAX_FILE_MB ?? '10');
export const SFX_MAX_FILE_MB =
  Number.isInteger(_SFX_MAX_FILE_MB) && _SFX_MAX_FILE_MB > 0 ? _SFX_MAX_FILE_MB : 10;
export const OVERLAY_FOLDER = process.env.OVERLAY_FOLDER ?? './overlay-videos';
const _OVERLAY_MAX_FILE_MB = Number(process.env.OVERLAY_MAX_FILE_MB ?? '100');
export const OVERLAY_MAX_FILE_MB =
  Number.isInteger(_OVERLAY_MAX_FILE_MB) && _OVERLAY_MAX_FILE_MB > 0 ? _OVERLAY_MAX_FILE_MB : 100;
const _COMPANION_MAX_SSE = Number(process.env.COMPANION_MAX_SSE_PER_TOKEN ?? '3');
export const COMPANION_MAX_SSE_PER_TOKEN =
  Number.isInteger(_COMPANION_MAX_SSE) && _COMPANION_MAX_SSE > 0 ? _COMPANION_MAX_SSE : 3;
const _OVERLAY_MAX_SSE = Number(process.env.OVERLAY_MAX_SSE_PER_CHANNEL ?? '10');
export const OVERLAY_MAX_SSE_PER_CHANNEL =
  Number.isInteger(_OVERLAY_MAX_SSE) && _OVERLAY_MAX_SSE > 0 ? _OVERLAY_MAX_SSE : 10;
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
if (SESSION_SECRET.length < 32) {
  throw new Error('SESSION_SECRET must be at least 32 characters long');
}
export const DISCORD_CLIENT_ID = require_env('DISCORD_CLIENT_ID');
export const DISCORD_CLIENT_SECRET = require_env('DISCORD_CLIENT_SECRET');
export const DISCORD_CALLBACK_URL = require_env('DISCORD_CALLBACK_URL');
export const PUBLIC_URL = new URL(DISCORD_CALLBACK_URL).origin;

// Twitch EventSub OAuth callback URL — required when any channel enables follow/sub notifications.
// Must be registered in the Twitch developer console for the same app as TWITCH_CLIENT_ID.
export const TWITCH_EVENTSUB_REDIRECT_URI = process.env.TWITCH_EVENTSUB_REDIRECT_URI ?? '';

// AES-256-GCM key for encrypting broadcaster OAuth tokens at rest.
// Must be exactly 64 hex characters (32 bytes). Generate with: openssl rand -hex 32
// Required to use the Twitch OAuth connect flow for follow/sub notifications.
export const EVENTSUB_TOKEN_SECRET = process.env.EVENTSUB_TOKEN_SECRET ?? '';
