import type { Response } from 'express';
import type { SessionUser } from '../../types/express';

export function parsePositiveIntId(value: string | string[] | undefined): number | null {
  const str = Array.isArray(value) ? value[0] : value;
  if (typeof str !== 'string' || !/^\d+$/.test(str)) return null;
  const parsed = Number(str);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function trimField(value: string | undefined): string {
  return (value ?? '').trim();
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
