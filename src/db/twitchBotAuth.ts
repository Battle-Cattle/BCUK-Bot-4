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
  const row = rows[0];
  if (!row) return null;
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
 * Encrypt and persist the bot's own Twitch chat OAuth token, upserting the singleton row — but
 * only if `attemptId` is at least as recent as the currently stored one (or no row exists yet).
 * This is a *second*, independent compare-and-swap from {@link saveBotChatTokenIfOwnedBy}'s: that
 * one orders a stale in-process token refresh against a reconnect; this one orders two separate,
 * independently-authorized `/admin/bot-auth/connect` attempts against *each other* when their
 * callbacks complete out of order (e.g. the owner using two tabs or devices) — without it,
 * whichever callback's Twitch round trip happens to finish last would silently win, even if the
 * owner started it first. `attemptId` is minted once per attempt at connect-initiation time
 * (`botAuth.ts`'s `mintBotConnectAttemptId`), not at save time, so ordering reflects when the owner
 * acted, not network timing — and is a strictly increasing identifier, not a bare `Date.now()|`
 * timestamp, so two attempts started in the same millisecond can't tie and both "win" the `>=`
 * comparison. Bumps `connection_id` only when the save actually takes effect, for the same reason
 * {@link saveBotChatToken} always did — see that function's superseding doc for details. Throws if
 * `EVENTSUB_TOKEN_SECRET` is not configured, to prevent storing plaintext credentials.
 *
 * @param attemptId - This connect attempt's identifier (see `mintBotConnectAttemptId`).
 * @param twitchUserId - Twitch user ID of the connected bot account.
 * @param accessToken - OAuth access token (encrypted before storage).
 * @param refreshToken - OAuth refresh token (encrypted before storage).
 * @param expiryMs - Token expiry as Unix epoch milliseconds, or null if unknown.
 * @returns The row's new `connection_id` if this attempt won, or null if a more recently *started*
 *   attempt already holds it. The caller can use the returned `connection_id` later to CAS a
 *   rollback (see {@link restoreBotChatTokenIfOwnedByConnection}) without that rollback itself
 *   having to participate in attempt ordering.
 */
export async function saveBotChatTokenIfLatestAttempt(
  attemptId: number,
  twitchUserId: string,
  accessToken: string,
  refreshToken: string,
  expiryMs: number | null,
): Promise<number | null> {
  if (!EVENTSUB_TOKEN_SECRET) throw new Error('EVENTSUB_TOKEN_SECRET is not configured — refusing to persist plaintext OAuth tokens');
  const storedAccess = encryptToken(accessToken, EVENTSUB_TOKEN_SECRET);
  const storedRefresh = encryptToken(refreshToken, EVENTSUB_TOKEN_SECRET);
  // Existing-row columns must be qualified with the table name: with the `AS new_row` alias, a bare
  // column name is ambiguous between the existing row and `new_row`, and MySQL rejects it.
  // attempt_started_at is assigned last so every earlier IF() still compares against the old value.
  const wins = 'twitch_bot_chat_token.attempt_started_at IS NULL OR new_row.attempt_started_at >= twitch_bot_chat_token.attempt_started_at';
  await getPool().execute(
    `INSERT INTO twitch_bot_chat_token (id, twitch_user_id, access_token, refresh_token, token_expiry, connection_id, attempt_started_at)
     VALUES (1, ?, ?, ?, ?, 1, ?) AS new_row
     ON DUPLICATE KEY UPDATE
       twitch_user_id = IF(${wins}, new_row.twitch_user_id, twitch_bot_chat_token.twitch_user_id),
       access_token   = IF(${wins}, new_row.access_token, twitch_bot_chat_token.access_token),
       refresh_token  = IF(${wins}, new_row.refresh_token, twitch_bot_chat_token.refresh_token),
       token_expiry   = IF(${wins}, new_row.token_expiry, twitch_bot_chat_token.token_expiry),
       connection_id  = IF(${wins}, twitch_bot_chat_token.connection_id + 1, twitch_bot_chat_token.connection_id),
       attempt_started_at = IF(${wins}, new_row.attempt_started_at, twitch_bot_chat_token.attempt_started_at)`,
    [twitchUserId, storedAccess, storedRefresh, expiryMs, attemptId],
  );
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    'SELECT connection_id, attempt_started_at FROM twitch_bot_chat_token WHERE id = 1',
  );
  const row = rows[0];
  if (!row || Number(row.attempt_started_at) !== attemptId) return null;
  return Number(row.connection_id);
}

/**
 * Restores `twitchUserId`/`accessToken`/`refreshToken`/`expiryMs` as the singleton row's contents,
 * but only if the row's `connection_id` still matches `expectedConnectionId` — i.e. nothing has
 * taken over the connection since the caller installed it. Used by `botAuthCallback.ts`'s
 * failed-restart rollback to get back to a previous, known-working connection: unlike
 * {@link saveBotChatTokenIfLatestAttempt}, a rollback isn't itself a competing, owner-initiated
 * connect attempt, so it must not participate in `attempt_started_at` ordering — doing so would let
 * it wrongly clobber a legitimately newer, still-in-flight connect attempt, or cause that attempt's
 * own eventual save to be rejected as superseded by a rollback that was never a real attempt at
 * all. `connection_id` ownership is the correct check instead, mirroring
 * {@link saveBotChatTokenIfOwnedBy}/{@link clearBotChatTokenIfOwnedBy} — bumps `connection_id` on
 * success, since a restored connection is still a new connection event.
 * @param expectedConnectionId - The `connection_id` the caller's own (now-failed) connection
 *   installed; the restore is dropped if the row has since moved past it.
 * @param twitchUserId - Twitch user ID of the account being restored.
 * @param accessToken - OAuth access token (encrypted before storage).
 * @param refreshToken - OAuth refresh token (encrypted before storage).
 * @param expiryMs - Token expiry as Unix epoch milliseconds, or null if unknown.
 * @returns Whether the restore actually took effect.
 */
export async function restoreBotChatTokenIfOwnedByConnection(
  expectedConnectionId: number,
  twitchUserId: string,
  accessToken: string,
  refreshToken: string,
  expiryMs: number | null,
): Promise<boolean> {
  if (!EVENTSUB_TOKEN_SECRET) throw new Error('EVENTSUB_TOKEN_SECRET is not configured — refusing to persist plaintext OAuth tokens');
  const storedAccess = encryptToken(accessToken, EVENTSUB_TOKEN_SECRET);
  const storedRefresh = encryptToken(refreshToken, EVENTSUB_TOKEN_SECRET);
  const [result] = await getPool().execute<mysql.ResultSetHeader>(
    `UPDATE twitch_bot_chat_token
     SET twitch_user_id=?, access_token=?, refresh_token=?, token_expiry=?, connection_id=connection_id + 1
     WHERE id=1 AND connection_id=?`,
    [twitchUserId, storedAccess, storedRefresh, expiryMs, expectedConnectionId],
  );
  return result.affectedRows > 0;
}

/**
 * Null out the bot's own Twitch chat OAuth token (used when a refresh fails and the token must
 * be considered revoked, forcing a fresh `/admin/bot-auth` connect). Also bumps `connection_id`,
 * for the same reason {@link saveBotChatTokenIfLatestAttempt} does, and clears
 * `attempt_started_at` so any future connect attempt is guaranteed to win
 * {@link saveBotChatTokenIfLatestAttempt}'s comparison rather than being compared against a stale
 * timestamp from before the clear.
 */
export async function clearBotChatToken(): Promise<void> {
  await getPool().execute(
    `UPDATE twitch_bot_chat_token
     SET twitch_user_id=NULL, access_token=NULL, refresh_token=NULL, token_expiry=NULL,
         connection_id=connection_id + 1, attempt_started_at=NULL
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
 * newer connection's token, because by the time it reaches the database
 * `saveBotChatTokenIfLatestAttempt` has already bumped `connection_id` past what this refresh was
 * captured for. Keyed on `connection_id`
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
 * connection's freshly connected token. Also bumps `connection_id` on success, so a stale *success*
 * callback from the same now-cleared provider (`onRefresh`, calling {@link saveBotChatTokenIfOwnedBy}
 * with this same `expectedConnectionId`) can no longer pass its own CAS check afterwards — without
 * this, such a callback could restore `access_token`/`refresh_token` onto the just-cleared row
 * without `twitch_user_id`, leaving it in an identity-less state.
 * @param expectedConnectionId - The `connection_id` this refresh failure was for.
 * @returns Whether a row was actually cleared (false means a reconnect superseded it first).
 */
export async function clearBotChatTokenIfOwnedBy(expectedConnectionId: number): Promise<boolean> {
  const [result] = await getPool().execute<mysql.ResultSetHeader>(
    `UPDATE twitch_bot_chat_token
     SET twitch_user_id=NULL, access_token=NULL, refresh_token=NULL, token_expiry=NULL,
         connection_id=connection_id + 1
     WHERE id=1 AND connection_id=?`,
    [expectedConnectionId],
  );
  return result.affectedRows > 0;
}
