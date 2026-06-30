import type { Response } from 'express';
import type { SessionUser } from '../../types/express';

/**
 * Parse a positive integer id form field. A repeated field (arriving as an array) is
 * rejected rather than silently taking the first value, so a duplicated/tampered id
 * can't slip past validation — mirrors `parsePositiveBigIntId`.
 */
export function parsePositiveIntId(value: string | string[] | undefined): number | null {
  if (Array.isArray(value)) return null;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Parse a positive BIGINT id form field directly to `bigint`, avoiding precision loss above
 * `Number.MAX_SAFE_INTEGER`. A repeated field (arriving as an array) is rejected rather than
 * silently taking the first value, so a duplicated/tampered id can't slip past validation.
 */
export function parsePositiveBigIntId(value: string | string[] | undefined): bigint | null {
  if (Array.isArray(value)) return null;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const parsed = BigInt(value);
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

/**
 * Returns true if `redirectUri` is a loopback HTTP URL (127.0.0.1 or localhost,
 * any port). Per RFC 8252 §7.3, only loopback redirects are accepted for the
 * companion app's OAuth flow — anything else risks leaking the authorization
 * code to an attacker-controlled host.
 * @param redirectUri - The redirect URI string to validate.
 * @returns Whether the URI is a permitted loopback redirect target.
 */
export function isLoopbackRedirectUri(redirectUri: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(redirectUri);
  } catch {
    return false;
  }
  return parsed.protocol === 'http:' && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost');
}
