export function parsePositiveIntId(value: string | string[] | undefined): number | null {
  const str = Array.isArray(value) ? value[0] : value;
  if (typeof str !== 'string' || !/^\d+$/.test(str)) return null;
  const parsed = Number(str);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
