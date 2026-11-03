import mysql from 'mysql2/promise';
import { getPool } from './pool';
import { EVENTSUB_TOKEN_SECRET, EVENTSUB_TOKEN_SECRET_PREVIOUS } from '../shared/config';
import { decryptToken, encryptToken } from '../shared/crypto';
import { createLogger } from '../shared/logger';

const log = createLogger('TokenKeys');

/**
 * Per-query timeout. This runs during startup, ahead of the bot and the panel, so a database that
 * stops answering on a live connection must not hang startup: the query fails, startup logs it and
 * carries on, and the next start retries.
 */
const QUERY_TIMEOUT_MS = 10_000;

/** A table holding an encrypted OAuth access/refresh token pair, keyed by `id`. */
interface TokenTable {
  table: string;
  access: string;
  refresh: string;
}

/**
 * Every encrypted token column. Fixed identifiers, never user input, so interpolating them into
 * the SQL below is safe. A new encrypted column belongs here too, or a key rotation would strand it.
 */
const TOKEN_TABLES: readonly TokenTable[] = [
  { table: 'streamer', access: 'eventsub_access_token', refresh: 'eventsub_refresh_token' },
  { table: 'twitch_bot_chat_token', access: 'access_token', refresh: 'refresh_token' },
];

/** What a re-encryption pass did. */
export interface TokenReencryptionResult {
  /** Rows rewritten under the active key. */
  reencrypted: number;
  /** Token values no configured key could decrypt (including damaged ones); left as they were. */
  unreadable: number;
  /** Rows changed by something else between the read and the write; retried on the next start. */
  pending: number;
}

/** A stored token's value after a re-encryption attempt. */
type Rewritten = { value: string | null; changed: boolean; unreadable: boolean };

/**
 * Decrypts a token with exactly one key.
 * @param stored - The column's value.
 * @param secret - 64-character hex AES-256 key.
 * @returns The plaintext, or undefined when this key doesn't decrypt it.
 */
function tryDecrypt(stored: string, secret: string): string | undefined {
  try {
    return decryptToken(stored, secret);
  } catch {
    return undefined;
  }
}

/**
 * Re-encrypts one stored token under the active key when only the previous key can decrypt it,
 * leaving it untouched when it's null, already readable with the active key, or readable with
 * neither (a damaged token, or one from a key that is no longer configured).
 * @param stored - The column's current value.
 * @returns The value to store, and whether it changed or was unreadable.
 */
function rewriteToken(stored: string | null): Rewritten {
  if (stored === null || tryDecrypt(stored, EVENTSUB_TOKEN_SECRET) !== undefined) {
    return { value: stored, changed: false, unreadable: false };
  }
  const plaintext = EVENTSUB_TOKEN_SECRET_PREVIOUS ? tryDecrypt(stored, EVENTSUB_TOKEN_SECRET_PREVIOUS) : undefined;
  if (plaintext === undefined) return { value: stored, changed: false, unreadable: true };
  return { value: encryptToken(plaintext, EVENTSUB_TOKEN_SECRET), changed: true, unreadable: false };
}

/**
 * Re-encrypts every token pair in one table. Each update is a compare-and-swap on the values just
 * read, so a token saved in the meantime (a refresh or reconnect) is never overwritten with a stale one.
 * @param spec - The table and its token columns.
 * @returns How many rows were rewritten or missed, and how many values were unreadable.
 */
async function reencryptTable(spec: TokenTable): Promise<TokenReencryptionResult> {
  const { table, access, refresh } = spec;
  const [rows] = await getPool().query<mysql.RowDataPacket[]>({
    sql: `SELECT id, ${access} AS access, ${refresh} AS refresh FROM ${table} WHERE ${access} IS NOT NULL OR ${refresh} IS NOT NULL`,
    timeout: QUERY_TIMEOUT_MS,
  });
  const result: TokenReencryptionResult = { reencrypted: 0, unreadable: 0, pending: 0 };
  for (const row of rows) {
    const newAccess = rewriteToken(row.access as string | null);
    const newRefresh = rewriteToken(row.refresh as string | null);
    result.unreadable += Number(newAccess.unreadable) + Number(newRefresh.unreadable);
    if (!newAccess.changed && !newRefresh.changed) continue;
    const [update] = await getPool().execute<mysql.ResultSetHeader>(
      {
        sql: `UPDATE ${table} SET ${access} = ?, ${refresh} = ? WHERE id = ? AND ${access} <=> ? AND ${refresh} <=> ?`,
        timeout: QUERY_TIMEOUT_MS,
      },
      [newAccess.value, newRefresh.value, row.id, row.access, row.refresh],
    );
    if (update.affectedRows > 0) result.reencrypted += 1;
    else result.pending += 1;
  }
  return result;
}

/**
 * Rewrites every stored OAuth token that only `EVENTSUB_TOKEN_SECRET_PREVIOUS` can decrypt under
 * the active `EVENTSUB_TOKEN_SECRET`, so the previous key can be removed afterwards. Outside a key
 * rotation it changes nothing, so a deploy stays safe to roll back. Run once at
 * startup, before anything else reads the tokens. Logs what it did, never a key or a token.
 * A no-op when no `EVENTSUB_TOKEN_SECRET` is configured.
 * @returns How many rows were rewritten, how many changed underneath the pass (left for the next
 *   start), and how many token values no configured key could decrypt.
 */
export async function reencryptStoredTokens(): Promise<TokenReencryptionResult> {
  const total: TokenReencryptionResult = { reencrypted: 0, unreadable: 0, pending: 0 };
  if (!EVENTSUB_TOKEN_SECRET) return total;
  for (const spec of TOKEN_TABLES) {
    const { reencrypted, unreadable, pending } = await reencryptTable(spec);
    total.reencrypted += reencrypted;
    total.unreadable += unreadable;
    total.pending += pending;
  }
  logResult(total);
  return total;
}

/**
 * Logs what a re-encryption pass did. Says the previous key can go only when nothing is left
 * unreadable or pending, so an operator never removes a key some row still needs.
 * @param total - The pass's counts.
 */
function logResult(total: TokenReencryptionResult): void {
  if (total.reencrypted > 0) log.info(`Re-encrypted ${total.reencrypted} stored token row(s) under the active key`);
  if (total.pending > 0) {
    log.warn(`${total.pending} token row(s) changed during re-encryption; they will be re-checked on the next start`);
  }
  if (total.unreadable > 0) {
    log.warn(`${total.unreadable} stored token(s) can't be decrypted with any configured key; those accounts must reconnect`);
  }
  if (total.pending === 0 && total.unreadable === 0 && EVENTSUB_TOKEN_SECRET_PREVIOUS) {
    log.info('Every stored token is under the active key; EVENTSUB_TOKEN_SECRET_PREVIOUS can now be removed');
  }
}
