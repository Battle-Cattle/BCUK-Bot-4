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
  /**
   * Increments on every save (initial connect or reconnect, whether or not the Twitch account
   * changed). `twitchBot.ts` captures this when building its `RefreshingAuthProvider` and uses it
   * as the compare-and-swap key for {@link saveBotChatTokenIfOwnedBy}/{@link clearBotChatTokenIfOwnedBy}
   * instead of `twitchUserId` — `twitchUserId` alone can't distinguish a reconnect to the *same*
   * account from the still-current connection, which `connection_id` can.
   */
  connectionId: number;
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
    `SELECT twitch_user_id, access_token, refresh_token, token_expiry, connection_id
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
    // Also bounded well within Number.MAX_SAFE_INTEGER: a simple per-save increment counter.
    connectionId: Number(row.connection_id),
  };
}

/**
 * Encrypt and persist the bot's own Twitch chat OAuth token, upserting the singleton row.
 * Bumps `connection_id` on every call (insert or update) — including a reconnect to the *same*
 * Twitch account — so any in-process `RefreshingAuthProvider` built from a previous connection is
 * provably superseded, closing the compare-and-swap race described on
 * {@link saveBotChatTokenIfOwnedBy}. Throws if `EVENTSUB_TOKEN_SECRET` is not configured, to
 * prevent storing plaintext credentials.
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
    `INSERT INTO twitch_bot_chat_token (id, twitch_user_id, access_token, refresh_token, token_expiry, connection_id)
     VALUES (1, ?, ?, ?, ?, 1) AS new_row
     ON DUPLICATE KEY UPDATE
       twitch_user_id=new_row.twitch_user_id, access_token=new_row.access_token,
       refresh_token=new_row.refresh_token, token_expiry=new_row.token_expiry,
       connection_id=twitch_bot_chat_token.connection_id + 1`,
    [twitchUserId, storedAccess, storedRefresh, expiryMs],
  );
}

/**
 * Null out the bot's own Twitch chat OAuth token (used when a refresh fails and the token must
 * be considered revoked, forcing a fresh `/admin/bot-auth` connect). Also bumps `connection_id`,
 * for the same reason {@link saveBotChatToken} does.
 */
export async function clearBotChatToken(): Promise<void> {
  await getPool().execute(
    `UPDATE twitch_bot_chat_token
     SET twitch_user_id=NULL, access_token=NULL, refresh_token=NULL, token_expiry=NULL,
         connection_id=connection_id + 1
     WHERE id=1`,
  );
}

/**
 * Encrypt and persist a refreshed token, but only if the singleton row's `connection_id` still
 * matches `expectedConnectionId` — a conditional (compare-and-swap) write, enforced atomically by
 * the database rather than any in-process check. `twitchBot.ts`'s `RefreshingAuthProvider.onRefresh`
 * handler is the only caller: an in-flight refresh from a since-superseded provider (the owner
 * reconnected — to a *different* account, or even the *same* one — while this refresh was still in
 * flight; see the discussion on PR #666) has its write silently dropped instead of overwriting the
 * newer connection's token, because by the time it reaches the database `saveBotChatToken` has
 * already bumped `connection_id` past what this refresh was captured for. Keyed on `connection_id`
 * rather than `twitch_user_id` specifically because the latter can't distinguish a reconnect to the
 * same account from the still-current connection.
 * @param expectedConnectionId - The `connection_id` this refresh was performed under (captured
 *   from {@link getBotChatToken} when the provider was built); the write is dropped if the stored
 *   row has since moved past it.
 * @param accessToken - Refreshed OAuth access token (encrypted before storage).
 * @param refreshToken - Refreshed OAuth refresh token (encrypted before storage).
 * @param expiryMs - Token expiry as Unix epoch milliseconds, or null if unknown.
 * @returns Whether the row was actually updated (false means a reconnect superseded it first).
 */
export async function saveBotChatTokenIfOwnedBy(
  expectedConnectionId: number,
  accessToken: string,
  refreshToken: string,
  expiryMs: number | null,
): Promise<boolean> {
  if (!EVENTSUB_TOKEN_SECRET) throw new Error('EVENTSUB_TOKEN_SECRET is not configured — refusing to persist plaintext OAuth tokens');
  const storedAccess = encryptToken(accessToken, EVENTSUB_TOKEN_SECRET);
  const storedRefresh = encryptToken(refreshToken, EVENTSUB_TOKEN_SECRET);
  const [result] = await getPool().execute<mysql.ResultSetHeader>(
    `UPDATE twitch_bot_chat_token
     SET access_token=?, refresh_token=?, token_expiry=?
     WHERE id=1 AND connection_id=?`,
    [storedAccess, storedRefresh, expiryMs, expectedConnectionId],
  );
  return result.affectedRows > 0;
}

/**
 * Null out the bot's own Twitch chat OAuth token, but only if the singleton row's `connection_id`
 * still matches `expectedConnectionId` — the `onRefreshFailure` counterpart to
 * {@link saveBotChatTokenIfOwnedBy}, for the same reason: a stale failure from a superseded
 * provider (including one superseded by a reconnect to the *same* account) must not clear a newer
 * connection's freshly connected token.
 * @param expectedConnectionId - The `connection_id` this refresh failure was for.
 * @returns Whether a row was actually cleared (false means a reconnect superseded it first).
 */
export async function clearBotChatTokenIfOwnedBy(expectedConnectionId: number): Promise<boolean> {
  const [result] = await getPool().execute<mysql.ResultSetHeader>(
    `UPDATE twitch_bot_chat_token
     SET twitch_user_id=NULL, access_token=NULL, refresh_token=NULL, token_expiry=NULL
     WHERE id=1 AND connection_id=?`,
    [expectedConnectionId],
  );
  return result.affectedRows > 0;
}
