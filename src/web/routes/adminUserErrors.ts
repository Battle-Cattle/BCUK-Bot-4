import type { Response } from 'express';
import { createLogger } from '../../shared/logger';
import { isLockWaitTimeoutDbError } from './adminUserMutations';

const log = createLogger('Web');

/**
 * Redirects on a DB error from a mutation route: `?error=db_busy` for lock-wait timeouts
 * (logged at warn), or `?error=${failCode}` for anything else (logged at error).
 *
 * @param err The caught error.
 * @param res The response, used to redirect.
 * @param failCode The error code to use for non-lock-timeout failures.
 * @param context Short label identifying the calling route, used in the log line.
 */
export function handleDbError(err: unknown, res: Response, failCode: string, context: string): void {
  if (isLockWaitTimeoutDbError(err)) {
    log.warn(`${context} DB lock timeout`, err);
    res.redirect('/admin/users?error=db_busy');
  } else {
    log.error(`${context} error:`, err);
    res.redirect(`/admin/users?error=${failCode}`);
  }
}
