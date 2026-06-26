import type { Response } from 'express';
import type { SessionUser } from '../../types/express';

export function parsePositiveIntId(value: string | string[] | undefined): number | null {
  const str = Array.isArray(value) ? value[0] : value;
  if (typeof str !== 'string' || !/^\d+$/.test(str)) return null;
  const parsed = Number(str);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/** Parse a positive BIGINT id form field directly to `bigint`, avoiding precision loss above `Number.MAX_SAFE_INTEGER`. */
export function parsePositiveBigIntId(value: string | string[] | undefined): bigint | null {
  const str = Array.isArray(value) ? value[0] : value;
  if (typeof str !== 'string' || !/^\d+$/.test(str)) return null;
  const parsed = BigInt(str);
  return parsed > 0n ? parsed : null;
}

export function trimField(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizeRequiredText(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

export function normalizeSingleTokenRequiredText(value: string | undefined): string | null {
  const normalized = normalizeRequiredText(value);
  if (!normalized || /\s/.test(normalized)) return null;
  return normalized.toLowerCase();
}

// Discord snowflake IDs are always 17–20 digits.
export function normalizeDiscordId(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return /^\d{17,20}$/.test(trimmed) ? trimmed : null;
}

export function renderError(
  res: Response,
  status: number,
  message: string,
  sessionUser: SessionUser | undefined,
): void {
  res.status(status).render('error', { message, user: sessionUser ?? null, csrfToken: '' });
}

export function filterQueryParam(value: unknown, allowed: ReadonlySet<string>): string | null {
  return typeof value === 'string' && allowed.has(value) ? value : null;
}
