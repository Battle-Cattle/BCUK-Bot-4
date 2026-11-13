import type { Request } from 'express';
import { getLiveAccessForRequest, hasPanelAccess } from './guildAccess';

// The live checks behind `requireAuth`/`requireAuthJson` and `requireOwner` (middleware.ts): each
// re-reads the session user from the database, once per request, rather than trusting the session.

/**
 * Whether the request's session belongs to a user who may still use the panel. A session whose
 * user has been deleted, or removed from their last guild (and isn't the bot owner), is destroyed
 * here, so removing a member ends their access at once instead of when the session expires.
 * The DB lookup is shared with any later middleware on the same request
 * ({@link getLiveAccessForRequest}).
 * @param req - Express request; reads `req.session.user`, and destroys the session when access has ended.
 * @returns True when the session user exists and still has panel access.
 */
export async function hasLiveSession(req: Request): Promise<boolean> {
  const user = req.session.user;
  if (!user) return false;
  if (hasPanelAccess(await getLiveAccessForRequest(req, user.discordId))) return true;
  await new Promise<void>((resolve) => { req.session.destroy(() => { resolve(); }); });
  return false;
}

/**
 * Re-reads the session user's owner flag from the database (rather than trusting the
 * session's login-time `isOwner` cache) and refreshes the cached flag to match, so a
 * revoked `user.is_owner` takes effect on the very next request instead of only at next
 * login — the same freshness `requireGuildContext` gives guild access. Needed because the
 * owner-gated routes (`/admin/health`, `/admin/bot-auth`) aren't behind `requireGuildContext`.
 * Reuses the lookup `requireAuth` made for this request ({@link getLiveAccessForRequest}).
 * @param req - Express request; reads and mutates `req.session.user.isOwner`.
 * @returns True only when a session user exists and their DB row still has `is_owner` set;
 *   false when there's no session user or the user row no longer exists.
 */
export async function isLiveOwner(req: Request): Promise<boolean> {
  const user = req.session.user;
  if (!user) return false;
  const access = await getLiveAccessForRequest(req, user.discordId);
  user.isOwner = access?.dbUser.is_owner ?? false;
  return user.isOwner;
}
