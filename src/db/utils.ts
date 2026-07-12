/** Converts a MySQL BIT(1) column value (Buffer, number, or boolean) to a boolean. */
export function fromBit(value: unknown): boolean {
  if (Buffer.isBuffer(value)) return value[0] === 1;
  return value == 1;
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
