import fs from 'fs';
import path from 'path';
import multer from 'multer';
import type { Request, Response } from 'express';
import type { Logger } from 'winston';
import type { SessionUser } from '../../types/express';
import {
  getStreamerByDiscordId,
  ReservedCommandError,
  CommandConflictError,
  isMysqlDuplicateEntryError,
} from '../../db';
import type { DbStreamerEventSub } from '../../db';

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
 * Loads the requesting user's streamer record, redirecting to `notAStreamerRedirectPath`
 * if they aren't one. Shared by every streamer-scoped admin page (channel points, overlay
 * settings), each of which passes its own not-a-streamer error redirect so the pages stay
 * decoupled from one another.
 * @param req - Express request; reads `session.user.discordId`.
 * @param res - Express response, used to redirect on failure.
 * @param notAStreamerRedirectPath - Full redirect target (path + query string) to use when
 *   the requester has no streamer record.
 * @returns The streamer record, or `null` if the response has already been redirected.
 */
export async function requireStreamer(
  req: Request,
  res: Response,
  notAStreamerRedirectPath: string,
): Promise<DbStreamerEventSub | null> {
  const streamer = await getStreamerByDiscordId(req.session.user!.discordId);
  if (!streamer) {
    res.redirect(notAStreamerRedirectPath);
    return null;
  }
  return streamer;
}

/**
 * Parse a weight form field into a positive integer ≥ 1 (floored), or null when
 * the value is missing, non-numeric, not positive, or an array (repeated field).
 * Rejecting arrays is consistent with `parsePositiveIntId` — a duplicated weight
 * field can't slip through silently.
 * @param raw - Raw value from a form field.
 * @returns A positive integer weight, or null when invalid.
 */
export function parseWeight(raw: string | string[] | undefined): number | null {
  if (Array.isArray(raw)) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.floor(n);
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
 * Keys that must never appear in `renderView`'s `data` argument. Express's EJS integration
 * uses the same object as both template locals and `ejs.compile` options, so an
 * attacker-controlled key here (e.g. `outputFunctionName`) could alter template compilation —
 * a known EJS option-injection class of SSTI. `__proto__`/`constructor`/`prototype` are
 * blocked for the same reason (prototype pollution of the render options object).
 */
const RESERVED_RENDER_DATA_KEYS = new Set([
  '__proto__',
  'constructor',
  'prototype',
  'cache',
  'filename',
  'views',
  'root',
  'client',
  'escape',
  'compileDebug',
  'debug',
  'delimiter',
  'openDelimiter',
  'closeDelimiter',
  'strict',
  '_with',
  'localsName',
  'rmWhitespace',
  'outputFunctionName',
  'async',
  'destructuredLocals',
  'context',
  'scope',
  'beautify',
  'includer',
  // EJS's `renderFile` special-cases a `settings` key on the data object (for Express 2/3
  // compat): `settings.views`/`settings['view cache']` set compile options directly, and
  // `settings['view options']` is shallow-copied into the real options *without* being
  // filtered by any key list at all. Blocking `settings` outright closes that whole nested
  // bypass rather than trying to enumerate every option it could smuggle through.
  'settings',
]);

/**
 * Renders an EJS view after checking `view` against the actual `.ejs` files present
 * under `views/`. Throws if `view` isn't a real template, so a template name can never
 * be attacker-controlled or silently mistyped. Also validates `data`: it must be a plain
 * object and must not contain any key in {@link RESERVED_RENDER_DATA_KEYS}, preventing a
 * caller from ever smuggling EJS compile-option or prototype-pollution keys into the
 * render call.
 * @param res - Express response object.
 * @param view - Name of the view to render (without the `.ejs` extension).
 * @param data - Template data, forwarded to `res.render` unchanged once validated.
 */
export function renderView(res: Response, view: string, data?: Record<string, unknown>): void {
  if (!getKnownViews().has(view)) {
    throw new Error(`renderView: unknown view "${view}"`);
  }
  if (data !== undefined) {
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      throw new Error('renderView: data must be a plain object');
    }
    for (const key of Object.keys(data)) {
      if (RESERVED_RENDER_DATA_KEYS.has(key)) {
        throw new Error(`renderView: data contains reserved key "${key}"`);
      }
    }
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

/** Arguments for {@link logAndRedirectError}. */
export interface LogAndRedirectErrorOptions {
  /** Express response object. */
  res: Response;
  /** Logger to record the error on (module-scoped `createLogger` instance). */
  log: Logger;
  /** Message prefix passed to `log.error`, matching the handler's existing wording. */
  logLabel: string;
  /** The caught error value, forwarded to `log.error` unchanged. */
  err: unknown;
  /** Path to redirect to, without query string (e.g. `/sfx`). */
  basePath: string;
  /** Value for the `error` query parameter (e.g. `add_failed`). */
  errorCode: string;
}

/**
 * Logs a caught error and redirects to `basePath` with `?error=<errorCode>`.
 * Standardizes the generic `catch (err) { log.error(...); return res.redirect(...); }` tail
 * repeated across POST route handlers.
 * @param options - See {@link LogAndRedirectErrorOptions}.
 */
export function logAndRedirectError({
  res,
  log,
  logLabel,
  err,
  basePath,
  errorCode,
}: LogAndRedirectErrorOptions): void {
  log.error(logLabel, err);
  res.redirect(`${basePath}?error=${errorCode}`);
}

/**
 * Regex for a Twitch custom reward's UUID (v1–v5, RFC 4122 variant), used to validate
 * `:twitchRewardId` route params and reward-id form fields.
 */
const REWARD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Extracts and validates a Twitch reward UUID.
 * @param value - The `:twitchRewardId` route param or form field value.
 * @returns The validated UUID, or null if malformed or repeated (an array value).
 */
export function parseRewardIdParam(value: string | string[]): string | null {
  if (Array.isArray(value)) return null;
  return REWARD_ID_RE.test(value) ? value : null;
}

/** Arguments for {@link handleReservedOrConflictCommandError}. */
export interface ReservedOrConflictCommandErrorOptions {
  /** Path to redirect to, without query string (e.g. `/commands`). */
  basePath: string;
  /** Value for the `error` query parameter used when the trigger is already taken
   *  (e.g. `command_taken`, `duplicate_command`). */
  conflictErrorCode: string;
}

/**
 * Handles the two "expected" write errors shared by commands and counters — a reserved
 * trigger name, or a trigger already taken by another command/counter (either a thrown
 * `CommandConflictError` or a raw MySQL duplicate-entry error) — redirecting to
 * `basePath?error=reserved_command` or `basePath?error=<conflictErrorCode>` respectively.
 * @param err - The caught error.
 * @param res - Express response, used to redirect when `err` is one of the handled cases.
 * @param options - See {@link ReservedOrConflictCommandErrorOptions}.
 * @returns true when `err` was handled and a redirect was sent (caller should stop);
 *   false when `err` is some other error the caller should still handle itself.
 */
export function handleReservedOrConflictCommandError(
  err: unknown,
  res: Response,
  { basePath, conflictErrorCode }: ReservedOrConflictCommandErrorOptions,
): boolean {
  if (err instanceof ReservedCommandError) {
    res.redirect(`${basePath}?error=reserved_command`);
    return true;
  }
  if (err instanceof CommandConflictError || isMysqlDuplicateEntryError(err)) {
    res.redirect(`${basePath}?error=${conflictErrorCode}`);
    return true;
  }
  return false;
}

/**
 * Builds a Multer error-handling callback that translates an oversized-file error
 * (`LIMIT_FILE_SIZE`) into a `file_too_large` redirect, and any other Multer/middleware
 * error into a logged `upload_failed` redirect — instead of letting either reach the
 * centralised 500 handler. Shared by every file-upload route (SFX sounds, overlay videos).
 * @param basePath - Path to redirect to, without query string (e.g. `/sfx`).
 * @param log - Logger to record non-size-limit errors on.
 * @param logLabel - Message prefix passed to `log.error`.
 * @returns A handler: true when `err` was an error and a redirect was sent (caller should
 *   stop); false when there was no error (caller should continue).
 */
export function createMulterErrorRedirectHandler(
  basePath: string,
  log: Logger,
  logLabel: string,
): (err: unknown, res: Response) => boolean {
  return (err: unknown, res: Response): boolean => {
    if (!err) return false;
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      res.redirect(`${basePath}?error=file_too_large`);
      return true;
    }
    log.error(logLabel, err);
    res.redirect(`${basePath}?error=upload_failed`);
    return true;
  };
}
