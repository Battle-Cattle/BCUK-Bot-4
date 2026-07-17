import mysql from 'mysql2/promise';
import { timingSafeEqual } from 'node:crypto';
import type { SqlExecutor } from './commandStringUtils';
import { getPool } from './pool';

/** Converts a MySQL BIT(1) column value (Buffer, number, or boolean) to a boolean. */
export function fromBit(value: unknown): boolean {
  if (Buffer.isBuffer(value)) return value[0] === 1;
  return value == 1;
}

const IDENTIFIER_PATTERN = /^[a-zA-Z0-9_]+$/;

/**
 * Checks whether a row exists in `table` where `column` equals `value`.
 * @param executor Pool or transaction connection to query with.
 * @param table Table name — must be a fixed, trusted identifier, never derived from user input.
 *   Validated against an allowlist pattern as defence-in-depth before being interpolated into SQL.
 * @param column Column name — same trust requirement and validation as `table`.
 * @param value Value to match against `column`.
 * @returns True if a matching row exists.
 * @throws If `table` or `column` isn't a plain alphanumeric/underscore identifier.
 */
export async function rowExists(
  executor: SqlExecutor,
  table: string,
  column: string,
  value: string | number,
): Promise<boolean> {
  if (!IDENTIFIER_PATTERN.test(table) || !IDENTIFIER_PATTERN.test(column)) {
    throw new Error('Invalid input');
  }
  const [rows] = await executor.execute<mysql.RowDataPacket[]>(
    `SELECT 1 FROM ${table} WHERE ${column} = ? LIMIT 1`,
    [value],
  );
  return rows.length > 0;
}

/**
 * Returns the total row count for `table`, for simple usage-stat summaries.
 * @param table Table name — must be a fixed, trusted identifier, never derived from user input.
 *   Validated against an allowlist pattern as defence-in-depth before being interpolated into SQL.
 * @returns The row count. `COUNT(*)` is protocol-typed BIGINT, so `bigNumberStrings` stringifies
 *   it like any other BIGINT column — but unlike a Discord snowflake (the case the "never coerce
 *   BIGINT to Number" rule exists for), this value is bounded by how many rows a human configures
 *   in an admin table (SFX triggers, commands, counters). It will never approach
 *   `Number.MAX_SAFE_INTEGER`, so parsing it back to a number here is safe and deliberate, not the
 *   blind coercion that rule warns against.
 * @throws If `table` isn't a plain alphanumeric/underscore identifier.
 */
export async function getRowCount(table: string): Promise<number> {
  if (!IDENTIFIER_PATTERN.test(table)) throw new Error('Invalid input');
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(`SELECT COUNT(*) AS count FROM ${table}`);
  return Number.parseInt(rows[0].count, 10);
}

/**
 * Timing-safe-compares a stored hex-encoded hash against an incoming one by decoding both to
 * bytes first. Byte-decoding (rather than a plain string compare) means a lookup row matched
 * loosely by the hash column's case-insensitive collation is still validated correctly — the
 * hex casing doesn't affect the underlying bytes — while anything that only matched due to
 * some other collation quirk, but decodes to genuinely different bytes, is still rejected.
 * @param storedHex Hex-encoded hash value read from the database.
 * @param incomingHex Hex-encoded hash computed from the caller-supplied secret.
 * @returns True if the two hashes decode to the same bytes.
 */
export function hashesMatch(storedHex: string, incomingHex: string): boolean {
  const stored = Buffer.from(storedHex, 'hex');
  const incoming = Buffer.from(incomingHex, 'hex');
  return stored.length === incoming.length && timingSafeEqual(stored, incoming);
}

/**
 * Distinguishes a no-op `UPDATE` (0 affected rows because every value was
 * already equal) from one that matched nothing because the row doesn't exist.
 * @param affectedRows `affectedRows` from the `UPDATE`'s `ResultSetHeader`.
 * @param existsCheck Callback that checks whether the target row still exists; only called when `affectedRows` is 0.
 * @returns True if the update affected a row or the target row still exists; false only if it doesn't exist.
 */
export async function affectedOrExists(affectedRows: number, existsCheck: () => Promise<boolean>): Promise<boolean> {
  if (affectedRows > 0) return true;
  return existsCheck();
}
