/**
 * Parses a `!gamble` bet amount against the caller's current balance. Accepts a plain integer
 * (`100`), thousands-separated (`1,000`), a `k`/`K` suffix meaning ×1000 (`5k`), a percentage of
 * balance (`40%`, floored), or `all`/`ALL` (the whole balance). Returns null for anything that
 * doesn't parse, or that resolves to less than 1 or more than the caller's balance — the min/max
 * bet rules are enforced here, not as separate config values.
 * @param input - The raw amount token from the chat message (e.g. the text after `!gamble`).
 * @param balance - The caller's current points balance.
 * @returns The validated bet amount, or null if `input` is invalid or out of range.
 */
export function parseGambleAmount(input: string, balance: number): number | null {
  const trimmed = input.trim();
  if (trimmed === '') return null;

  const amount = resolveAmount(trimmed, balance);
  if (amount === null || !Number.isFinite(amount)) return null;

  const rounded = Math.floor(amount);
  if (rounded < 1 || rounded > balance) return null;
  return rounded;
}

/** Resolves the raw numeric amount a bet token represents, before the min/max range check. */
function resolveAmount(trimmed: string, balance: number): number | null {
  if (trimmed.toLowerCase() === 'all') return balance;

  if (trimmed.endsWith('%')) {
    const percent = Number(trimmed.slice(0, -1));
    if (!Number.isFinite(percent) || percent <= 0) return null;
    return Math.floor(balance * (percent / 100));
  }

  if (/^[0-9]+[kK]$/.test(trimmed)) {
    return Number(trimmed.slice(0, -1)) * 1000;
  }

  const withoutCommas = trimmed.replace(/,/g, '');
  if (!/^[0-9]+$/.test(withoutCommas)) return null;
  return Number(withoutCommas);
}
