import type { Request } from 'express';
import type { SessionUser } from '../types/express';

/**
 * Reads the current session user, throwing if absent. Safe to call unconditionally in any
 * route handler mounted behind `requireAuth` (directly, or transitively via
 * `requireGuildContext`/`requireMod`/`requireManager`/`requireAdmin`, all of which require
 * a session user first) — replaces the `req.session.user!` non-null assertion previously
 * repeated at every call site with a single, compiler-checked invariant point.
 * @param req - Express request.
 * @returns The current session user.
 * @throws If `req.session.user` is not set, i.e. this was called from a route handler
 *   that is missing its auth-guarding middleware.
 */
export function getSessionUser(req: Request): SessionUser {
  const user = req.session.user;
  if (!user) {
    throw new Error('getSessionUser called without an authenticated session — route is missing requireAuth');
  }
  return user;
}

/**
 * Reads the current session user's selected guild id, throwing if absent. Safe to call
 * unconditionally in any route handler mounted behind `requireGuildContext` (which derives
 * and sets `currentGuildId` on every request) — replaces the `getSessionUser(req).currentGuildId!`
 * non-null assertion previously repeated at every call site with a single, compiler-checked
 * invariant point.
 * @param req - Express request.
 * @returns The current session user's selected guild id.
 * @throws If `currentGuildId` is not set, i.e. this was called from a route handler
 *   that is missing its `requireGuildContext` middleware.
 */
export function getCurrentGuildId(req: Request): string {
  const guildId = getSessionUser(req).currentGuildId;
  if (!guildId) {
    throw new Error('getCurrentGuildId called without a selected guild — route is missing requireGuildContext');
  }
  return guildId;
}
