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

export const DB_HOST = process.env.DB_HOST ?? 'localhost';
const _DB_PORT = parseInt(process.env.DB_PORT ?? '3306', 10);
if (Number.isNaN(_DB_PORT)) throw new Error('Invalid DB_PORT: must be a number');
export const DB_PORT = _DB_PORT;
export const DB_USER = require_env('DB_USER');
export const DB_PASSWORD = require_env('DB_PASSWORD');
export const DB_NAME = require_env('DB_NAME');

// Use Number (not parseInt) so malformed values like `1024MB` or `1.5` fall back
// to the safe default instead of being silently truncated to a valid-looking cap.
function parsePositiveIntEnv(envVar: string | undefined, fallback: number): number {
  const parsed = Number(envVar);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export const SFX_FOLDER = process.env.SFX_FOLDER ?? './sfx';
export const SFX_MAX_FILE_MB = parsePositiveIntEnv(process.env.SFX_MAX_FILE_MB, 10);
export const OVERLAY_FOLDER = process.env.OVERLAY_FOLDER ?? './overlay-videos';
export const OVERLAY_MAX_FILE_MB = parsePositiveIntEnv(process.env.OVERLAY_MAX_FILE_MB, 100);
export const COMPANION_MAX_SSE_PER_TOKEN = parsePositiveIntEnv(process.env.COMPANION_MAX_SSE_PER_TOKEN, 3);
export const OVERLAY_MAX_SSE_PER_CHANNEL = parsePositiveIntEnv(process.env.OVERLAY_MAX_SSE_PER_CHANNEL, 10);
export const ALERT_ASSETS_FOLDER = process.env.ALERT_ASSETS_FOLDER ?? './alert-assets';
export const ALERT_MAX_IMAGE_MB = parsePositiveIntEnv(process.env.ALERT_MAX_IMAGE_MB, 10);
export const ALERT_MAX_SOUND_MB = parsePositiveIntEnv(process.env.ALERT_MAX_SOUND_MB, 5);
export const ALERT_MAX_SSE_PER_CHANNEL = parsePositiveIntEnv(process.env.ALERT_MAX_SSE_PER_CHANNEL, 10);
export const CHANNEL_POINTS_MAX_SSE_PER_STREAMER = parsePositiveIntEnv(process.env.CHANNEL_POINTS_MAX_SSE_PER_STREAMER, 5);
export const DASHBOARD_EVENTS_MAX_SSE_PER_STREAMER = parsePositiveIntEnv(process.env.DASHBOARD_EVENTS_MAX_SSE_PER_STREAMER, 5);
export const DASHBOARD_STATUS_MAX_SSE_PER_GUILD = parsePositiveIntEnv(process.env.DASHBOARD_STATUS_MAX_SSE_PER_GUILD, 10);
export const OVERLAY_STATUS_MAX_SSE_PER_STREAMER = parsePositiveIntEnv(process.env.OVERLAY_STATUS_MAX_SSE_PER_STREAMER, 3);
export const ALERT_STATUS_MAX_SSE_PER_STREAMER = parsePositiveIntEnv(process.env.ALERT_STATUS_MAX_SSE_PER_STREAMER, 3);
export const SSE_MAX_TOTAL_CONNECTIONS = parsePositiveIntEnv(process.env.SSE_MAX_TOTAL_CONNECTIONS, 500);
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
// Validated eagerly (like SESSION_SECRET above) instead of leaving it to the first
// encryptToken/decryptToken call — otherwise a malformed value boots cleanly and only
// surfaces as a generic error the first time a streamer connects EventSub.
if (EVENTSUB_TOKEN_SECRET !== '' && !/^[0-9a-fA-F]{64}$/.test(EVENTSUB_TOKEN_SECRET)) {
  throw new Error('EVENTSUB_TOKEN_SECRET must be exactly 64 hex characters (32 bytes)');
}

// OpenAI API key, used only for the owner-only "Suggest description" SFX feature.
// Leave unset to keep that feature disabled — everything else works without it.
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? '';
