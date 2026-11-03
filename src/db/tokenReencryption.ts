import mysql from 'mysql2/promise';
import { getPool } from './pool';
import { EVENTSUB_TOKEN_SECRET, EVENTSUB_TOKEN_SECRET_PREVIOUS } from '../shared/config';
import { decryptToken, encryptToken, needsReencryption } from '../shared/crypto';
import { createLogger } from '../shared/logger';

const log = createLogger('TokenKeys');

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
  /** Token values no configured key could decrypt; left as they were. */
  unreadable: number;
}

/** A stored token's value after a re-encryption attempt. */
type Rewritten = { value: string | null; changed: boolean; unreadable: boolean };

/**
 * Re-encrypts one stored token under the active key when it isn't already, leaving it untouched
 * when it's null, already current, or can't be decrypted with any configured key.
 * @param stored - The column's current value.
 * @returns The value to store, and whether it changed or was unreadable.
 */
function rewriteToken(stored: string | null): Rewritten {
  if (stored === null || !needsReencryption(stored, EVENTSUB_TOKEN_SECRET)) {
    return { value: stored, changed: false, unreadable: false };
  }
  try {
    const plaintext = decryptToken(stored, EVENTSUB_TOKEN_SECRET, EVENTSUB_TOKEN_SECRET_PREVIOUS);
    return { value: encryptToken(plaintext, EVENTSUB_TOKEN_SECRET), changed: true, unreadable: false };
  } catch {
    return { value: stored, changed: false, unreadable: true };
  }
}

/**
 * Re-encrypts every token pair in one table. Each update is a compare-and-swap on the values just
 * read, so a token saved in the meantime (a refresh or reconnect) is never overwritten with a stale one.
 * @param spec - The table and its token columns.
 * @returns How many rows were rewritten and how many values were unreadable.
 */
async function reencryptTable(spec: TokenTable): Promise<TokenReencryptionResult> {
  const { table, access, refresh } = spec;
  const [rows] = await getPool().query<mysql.RowDataPacket[]>(
    `SELECT id, ${access} AS access, ${refresh} AS refresh FROM ${table} WHERE ${access} IS NOT NULL OR ${refresh} IS NOT NULL`,
  );
  const result: TokenReencryptionResult = { reencrypted: 0, unreadable: 0 };
  for (const row of rows) {
    const newAccess = rewriteToken(row.access as string | null);
    const newRefresh = rewriteToken(row.refresh as string | null);
    result.unreadable += Number(newAccess.unreadable) + Number(newRefresh.unreadable);
    if (!newAccess.changed && !newRefresh.changed) continue;
    const [update] = await getPool().execute<mysql.ResultSetHeader>(
      `UPDATE ${table} SET ${access} = ?, ${refresh} = ? WHERE id = ? AND ${access} <=> ? AND ${refresh} <=> ?`,
      [newAccess.value, newRefresh.value, row.id, row.access, row.refresh],
    );
    result.reencrypted += update.affectedRows;
  }
  return result;
}

/**
 * Rewrites every stored OAuth token that isn't already encrypted under the active
 * `EVENTSUB_TOKEN_SECRET` — legacy `enc:` tokens and tokens written under
 * `EVENTSUB_TOKEN_SECRET_PREVIOUS` — so the previous key can be removed afterwards. Run once at
 * startup, before anything else reads the tokens. Logs what it did, never a key or a token.
 * A no-op when no `EVENTSUB_TOKEN_SECRET` is configured.
 * @returns How many rows were rewritten and how many token values no configured key could decrypt.
 */
export async function reencryptStoredTokens(): Promise<TokenReencryptionResult> {
  const total: TokenReencryptionResult = { reencrypted: 0, unreadable: 0 };
  if (!EVENTSUB_TOKEN_SECRET) return total;
  for (const spec of TOKEN_TABLES) {
    const { reencrypted, unreadable } = await reencryptTable(spec);
    total.reencrypted += reencrypted;
    total.unreadable += unreadable;
  }
  if (total.reencrypted > 0) log.info(`Re-encrypted ${total.reencrypted} stored token row(s) under the active key`);
  if (total.unreadable > 0) {
    log.warn(`${total.unreadable} stored token(s) can't be decrypted with any configured key; those accounts must reconnect`);
  } else if (EVENTSUB_TOKEN_SECRET_PREVIOUS) {
    log.info('Every stored token is under the active key; EVENTSUB_TOKEN_SECRET_PREVIOUS can now be removed');
  }
  return total;
}
