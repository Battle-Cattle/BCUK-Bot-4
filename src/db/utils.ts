import mysql from 'mysql2/promise';
import { timingSafeEqual } from 'node:crypto';
import type { SqlExecutor } from './commandStringUtils';

/** Converts a MySQL BIT(1) column value (Buffer, number, or boolean) to a boolean. */
export function fromBit(value: unknown): boolean {
  if (Buffer.isBuffer(value)) return value[0] === 1;
  return value == 1;
}

/**
 * Checks whether a row exists in `table` where `column` equals `value`.
 * @param executor Pool or transaction connection to query with.
 * @param table Table name — must be a fixed, trusted identifier, never derived from user input.
 * @param column Column name — same trust requirement as `table`.
 * @param value Value to match against `column`.
 * @returns True if a matching row exists.
 */
export async function rowExists(
  executor: SqlExecutor,
  table: string,
  column: string,
  value: string | number,
): Promise<boolean> {
  const [rows] = await executor.execute<mysql.RowDataPacket[]>(
    `SELECT 1 FROM ${table} WHERE ${column} = ? LIMIT 1`,
    [value],
  );
  return rows.length > 0;
}

/**
 * Timing-safe-compares a stored hex-encoded hash against an incoming one, guarding against
 * a case-insensitive column collation matching hashes that differ only by case.
 * @param storedHex Hex-encoded hash value read from the database.
 * @param incomingHex Hex-encoded hash computed from the caller-supplied secret.
 * @returns True if the two hashes match exactly, including case.
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
