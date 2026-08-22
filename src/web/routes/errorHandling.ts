import type { Response } from 'express';
import type { Logger } from 'winston';
import {
  ReservedCommandError,
  CommandConflictError,
  isMysqlDuplicateEntryError,
} from '../../db';

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
