import fs from 'fs';
import path from 'path';
import type { Response } from 'express';
import type { Logger } from 'winston';
import type { SessionUser } from '../../types/express';

const VIEWS_DIR = path.join(__dirname, '../../../views');
let knownViews: Set<string> | undefined;

/** Lazily reads and caches the set of view names from the `.ejs` files under `views/`. */
function getKnownViews(): Set<string> {
  if (!knownViews) {
    knownViews = new Set(
      fs.readdirSync(VIEWS_DIR)
        .filter((f) => f.endsWith('.ejs'))
        .map((f) => f.slice(0, -'.ejs'.length)),
    );
  }
  return knownViews;
}

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

/**
 * Returns `value` trimmed if it is a string, or an empty string otherwise.
 * @param value - Any value from a form or request body.
 * @returns Trimmed string, or `''` for non-string inputs.
 */
export function trimField(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Trims `value` and returns it if non-empty, or `null` if blank/missing.
 * @param value - Raw string from a form field.
 * @returns Non-empty trimmed string, or `null`.
 */
export function normalizeRequiredText(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

/**
 * Allowlist regex for valid trigger strings (e.g. `!clap`, `!my-cmd_1`).
 * Permits an optional single-char prefix (`!`, `?`, `#`, `@`), then one alphanumeric
 * character, followed by zero or more alphanumeric, underscore, or hyphen characters.
 * Rejects HTML-special characters such as `<`, `>`, `&`, and `"`.
 */
const TRIGGER_RE = /^[!?#@]?[a-z0-9][a-z0-9_-]*$/;

/**
 * Normalizes a required single-word (no whitespace) text field to lowercase and
 * validates it against the trigger-name allowlist (`TRIGGER_RE`).
 * Returns `null` if the value is blank, contains whitespace, or contains characters
 * outside the safe allowlist (e.g. HTML-special chars like `<`, `>`, `&`, `"`).
 * @param value - Raw string from a form field.
 * @returns Lowercased, allowlist-validated single-token string, or `null`.
 */
export function normalizeSingleTokenRequiredText(value: string | undefined): string | null {
  const normalized = normalizeRequiredText(value);
  if (!normalized || /\s/.test(normalized)) return null;
  const lower = normalized.toLowerCase();
  return TRIGGER_RE.test(lower) ? lower : null;
}

/**
 * Validates and returns a Discord snowflake ID (17–20 digits), or `null` if invalid.
 * @param value - Raw string from a form field.
 * @returns The trimmed snowflake string, or `null`.
 */
export function normalizeDiscordId(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return /^\d{17,20}$/.test(trimmed) ? trimmed : null;
}

/**
 * Renders an EJS view after checking `view` against the actual `.ejs` files present
 * under `views/`. Throws if `view` isn't a real template, so a template name can never
 * be attacker-controlled or silently mistyped.
 * @param res - Express response object.
 * @param view - Name of the view to render (without the `.ejs` extension).
 * @param data - Template data, forwarded to `res.render` unchanged.
 */
export function renderView(res: Response, view: string, data?: Record<string, unknown>): void {
  if (!getKnownViews().has(view)) {
    throw new Error(`renderView: unknown view "${view}"`);
  }
  res.render(view, data);
}

/**
 * Renders the `error` EJS view with the given HTTP status and message.
 * @param res - Express response object.
 * @param status - HTTP status code to set.
 * @param message - Human-readable error message shown to the user.
 * @param sessionUser - Current session user, or `undefined` if unauthenticated.
 */
export function renderError(
  res: Response,
  status: number,
  message: string,
  sessionUser: SessionUser | undefined,
): void {
  res.status(status);
  renderView(res, 'error', { message, user: sessionUser ?? null, csrfToken: '' });
}

/**
 * Returns `value` if it is a string present in `allowed`, otherwise `null`.
 * Used to sanitize query parameters against an explicit allowlist.
 * @param value - Raw query parameter value.
 * @param allowed - Set of permitted string values.
 * @returns The matched string, or `null`.
 */
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

/**
 * Logs a caught error and redirects to `basePath` with `?error=<errorCode>`.
 * Standardizes the generic `catch (err) { log.error(...); return res.redirect(...); }` tail
 * repeated across POST route handlers.
 * @param res - Express response object.
 * @param log - Logger to record the error on (module-scoped `createLogger` instance).
 * @param logLabel - Message prefix passed to `log.error`, matching the handler's existing wording.
 * @param err - The caught error value, forwarded to `log.error` unchanged.
 * @param basePath - Path to redirect to, without query string (e.g. `/sfx`).
 * @param errorCode - Value for the `error` query parameter (e.g. `add_failed`).
 */
export function logAndRedirectError(
  res: Response,
  log: Logger,
  logLabel: string,
  err: unknown,
  basePath: string,
  errorCode: string,
): void {
  log.error(logLabel, err);
  res.redirect(`${basePath}?error=${errorCode}`);
}
