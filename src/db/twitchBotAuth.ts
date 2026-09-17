import mysql from 'mysql2/promise';
import { getPool } from './pool';
import { EVENTSUB_TOKEN_SECRET } from '../shared/config';
import { encryptToken, decryptToken } from '../shared/crypto';

/** The bot's own Twitch chat account OAuth token, decrypted. */
export interface BotChatToken {
  twitchUserId: string;
  accessToken: string;
  refreshToken: string;
  /** Unix epoch milliseconds, or null if unknown. */
  tokenExpiry: number | null;
}

/**
 * Decrypts a stored token value, treating a missing secret or a decryption failure (corrupted
 * data or wrong key) as an absent token rather than throwing. Mirrors `maybeDecrypt` in
 * `src/db/eventSub.ts`.
 * @param value - Encrypted token value, or null.
 * @returns The decrypted token, or null if `value` is null, the secret is unset, or decryption fails.
 */
function maybeDecrypt(value: string | null): string | null {
  if (!value) return null;
  if (!EVENTSUB_TOKEN_SECRET) return null;
  try {
    return decryptToken(value, EVENTSUB_TOKEN_SECRET);
  } catch {
    return null;
  }
}

/**
 * Reads the bot's own Twitch chat OAuth token from the singleton `twitch_bot_chat_token` row.
 * @returns The decrypted token, or null if no row exists, the row has no token yet, the secret
 *   is unset, or decryption fails.
 */
export async function getBotChatToken(): Promise<BotChatToken | null> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT twitch_user_id, access_token, refresh_token, token_expiry
     FROM twitch_bot_chat_token WHERE id = 1`,
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  const accessToken = maybeDecrypt(row.access_token ?? null);
  const refreshToken = maybeDecrypt(row.refresh_token ?? null);
  if (!row.twitch_user_id || !accessToken || !refreshToken) return null;
  return {
    twitchUserId: String(row.twitch_user_id),
    accessToken,
    refreshToken,
    // Coerced to Number (unlike a Discord-snowflake-shaped BIGINT): this is a Unix-epoch-ms
    // timestamp, bounded well within Number.MAX_SAFE_INTEGER for centuries to come.
    tokenExpiry: row.token_expiry != null ? Number(row.token_expiry) : null,
  };
}

/**
 * Encrypt and persist the bot's own Twitch chat OAuth token, upserting the singleton row.
 * Throws if `EVENTSUB_TOKEN_SECRET` is not configured, to prevent storing plaintext credentials.
 *
 * @param twitchUserId - Twitch user ID of the connected bot account.
 * @param accessToken - OAuth access token (encrypted before storage).
 * @param refreshToken - OAuth refresh token (encrypted before storage).
 * @param expiryMs - Token expiry as Unix epoch milliseconds, or null if unknown.
 */
export async function saveBotChatToken(
  twitchUserId: string,
  accessToken: string,
  refreshToken: string,
  expiryMs: number | null,
): Promise<void> {
  if (!EVENTSUB_TOKEN_SECRET) throw new Error('EVENTSUB_TOKEN_SECRET is not configured — refusing to persist plaintext OAuth tokens');
  const storedAccess = encryptToken(accessToken, EVENTSUB_TOKEN_SECRET);
  const storedRefresh = encryptToken(refreshToken, EVENTSUB_TOKEN_SECRET);
  await getPool().execute(
    `INSERT INTO twitch_bot_chat_token (id, twitch_user_id, access_token, refresh_token, token_expiry)
     VALUES (1, ?, ?, ?, ?) AS new_row
     ON DUPLICATE KEY UPDATE
       twitch_user_id=new_row.twitch_user_id, access_token=new_row.access_token,
       refresh_token=new_row.refresh_token, token_expiry=new_row.token_expiry`,
    [twitchUserId, storedAccess, storedRefresh, expiryMs],
  );
}

/**
 * Null out the bot's own Twitch chat OAuth token (used when a refresh fails and the token must
 * be considered revoked, forcing a fresh `/admin/bot-auth` connect).
 */
export async function clearBotChatToken(): Promise<void> {
  await getPool().execute(
    `UPDATE twitch_bot_chat_token
     SET twitch_user_id=NULL, access_token=NULL, refresh_token=NULL, token_expiry=NULL
     WHERE id=1`,
  );
}
