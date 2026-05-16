/** Converts a MySQL BIT(1) column value (Buffer, number, or boolean) to a boolean. */
export function fromBit(value: unknown): boolean {
  if (Buffer.isBuffer(value)) return value[0] === 1;
  return value == 1;
}
