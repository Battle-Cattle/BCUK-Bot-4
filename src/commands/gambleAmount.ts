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

/** Parses the `all`/`ALL` keyword as the full balance; null for anything else. */
function parseAllKeyword(trimmed: string, balance: number): number | null {
  return trimmed.toLowerCase() === 'all' ? balance : null;
}

/** Parses a trailing-`%` percentage of balance, floored; null if it doesn't end in `%`, or the
 *  percentage isn't a finite positive number. */
function parsePercentAmount(trimmed: string, balance: number): number | null {
  if (!trimmed.endsWith('%')) return null;
  const percent = Number(trimmed.slice(0, -1));
  return Number.isFinite(percent) && percent > 0 ? Math.floor(balance * (percent / 100)) : null;
}

/** Parses a `k`/`K`-suffixed integer as ×1000; null for anything else. */
function parseThousandsSuffixAmount(trimmed: string): number | null {
  return /^[0-9]+[kK]$/.test(trimmed) ? Number(trimmed.slice(0, -1)) * 1000 : null;
}

/** Parses a plain (optionally thousands-separated) integer; null for anything else. */
function parsePlainIntegerAmount(trimmed: string): number | null {
  const withoutCommas = trimmed.replace(/,/g, '');
  return /^[0-9]+$/.test(withoutCommas) ? Number(withoutCommas) : null;
}

/**
 * Resolves the raw numeric amount a bet token represents, before the min/max range check, by
 * trying each accepted format in turn.
 */
function resolveAmount(trimmed: string, balance: number): number | null {
  const parsers: Array<() => number | null> = [
    () => parseAllKeyword(trimmed, balance),
    () => parsePercentAmount(trimmed, balance),
    () => parseThousandsSuffixAmount(trimmed),
    () => parsePlainIntegerAmount(trimmed),
  ];
  for (const parse of parsers) {
    const result = parse();
    if (result !== null) return result;
  }
  return null;
}
