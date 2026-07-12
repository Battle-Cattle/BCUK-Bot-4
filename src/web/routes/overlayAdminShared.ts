/**
 * Normalizes a form field that may arrive as a single string or an array of strings
 * (Express's behaviour for repeated field names) into a string array.
 * @param value - Raw value from a form field.
 * @returns The value as a string array; empty when `value` is missing/blank.
 */
export function toStringArray(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}
