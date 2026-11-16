import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { createLogger } from '../shared/logger';
import { getCurrentGuildId } from './session';

// Guild-scoped mutation forms key their rows by something that isn't unique to one guild (such as
// a member's `discord_id`), while the route takes the guild from the session. A guild switch in
// another tab changes the session's guild, so a form left open on guild A would otherwise act on
// guild B. These forms carry the guild they were rendered for in a hidden `guild_id` field, and
// `requireFormGuild` rejects a submission whose guild is no longer the session's.

const log = createLogger('Web');

/** The hidden form field that carries the guild a form was rendered for. */
export const FORM_GUILD_FIELD = 'guild_id';

/** The `?error=` code a page shows when a form was submitted for a guild the session has left. */
export const GUILD_CHANGED_ERROR = 'guild_changed';

/**
 * Builds middleware that lets a guild-scoped form submission through only when its `guild_id`
 * field names the session's current guild, redirecting to `redirectPath?error=guild_changed`
 * otherwise (including when the field is missing). Mount it after `requireGuildContext` (which
 * sets the session's guild) and the body parser.
 * @param redirectPath - The page to send a rejected submission back to, e.g. `/admin/users`.
 * @returns Express middleware enforcing the match.
 */
export function requireFormGuild(redirectPath: string): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const body = req.body as Record<string, unknown> | undefined;
    const submitted = body?.[FORM_GUILD_FIELD];
    const current = getCurrentGuildId(req);
    if (typeof submitted === 'string' && submitted.trim() === current) {
      next();
      return;
    }
    // The submitted value is user input, so it isn't logged (no log injection).
    log.info(`Rejected a ${redirectPath} form submission: it was for a different guild than the session's ${current}`);
    res.redirect(`${redirectPath}?error=${GUILD_CHANGED_ERROR}`);
  };
}
