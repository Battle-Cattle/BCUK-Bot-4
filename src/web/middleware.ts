import { createHash } from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { ensureSessionCsrfToken } from './csrf';
import {
  AccessLevel,
  findKeyByHash,
  findDiscordIdByTokenHash,
  findUser,
  getAllGuilds,
  getEffectiveAccessLevelForUser,
  getGuildsForMember,
} from '../db';
import { renderView } from './routes/shared';

/**
 * Ensures the request has a logged-in session user, redirecting to login otherwise.
 * @param req - Express request; checked for `req.session.user`.
 * @param res - Express response; used to redirect when no session user is present.
 * @param next - Called when a session user is present.
 * @returns Nothing; either calls `next()` or issues a redirect.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (req.session.user) {
    next();
  } else {
    res.redirect('/auth/login');
  }
}

/**
 * Ensures the session has a current guild selected before a guild-scoped route runs.
 * Assumes `requireAuth` ran first. Auto-selects when the user has exactly one guild
 * (so single-guild deployments never see the picker); redirects to the picker when a
 * choice is required; and re-validates that the stored guild is still one the user
 * belongs to. Membership and owner status are re-read from the database on every call
 * (rather than trusted from the session cache) so a revoked guild membership or owner
 * flag takes effect immediately instead of only at next login. The effective access
 * level is recomputed for the resolved guild so authorization always reflects the
 * current guild, never a stale login-time value.
 *
 * @param req - Express request; reads and mutates `req.session.user`.
 * @param res - Express response; used to redirect when no guild context can be resolved.
 * @param next - Called once a valid `currentGuildId` and `accessLevel` are set on the session user.
 * @returns A promise that resolves once `next()` or a redirect has been issued.
 */
export async function requireGuildContext(req: Request, res: Response, next: NextFunction): Promise<void> {
  const user = req.session.user;
  if (!user) {
    res.redirect('/auth/login');
    return;
  }

  const dbUser = await findUser(user.discordId);
  if (!dbUser) {
    res.redirect('/auth/login');
    return;
  }
  const liveGuilds = dbUser.is_owner ? await getAllGuilds() : await getGuildsForMember(user.discordId);
  user.isOwner = dbUser.is_owner;
  user.guilds = liveGuilds.map((g) => ({ guildId: g.guild_id, name: g.name }));

  // A stored guild must still be one the user can act in (membership may have been
  // revoked since login). Drop it and re-pick if not.
  if (user.currentGuildId && !user.guilds.some((g) => g.guildId === user.currentGuildId)) {
    user.currentGuildId = null;
  }

  if (!user.currentGuildId) {
    if (user.guilds.length === 0) {
      res.redirect('/auth/login');
      return;
    }
    if (user.guilds.length === 1) {
      user.currentGuildId = user.guilds[0].guildId;
    } else {
      res.redirect('/guild/select');
      return;
    }
  }

  user.accessLevel = (await getEffectiveAccessLevelForUser(user.currentGuildId, dbUser)) as (typeof AccessLevel)[keyof typeof AccessLevel];

  next();
}

/**
 * Creates a middleware that ensures the current-guild access level is at least `level`,
 * otherwise renders a 403. Shared factory behind `requireMod`/`requireManager`/`requireAdmin`.
 * @param level - Minimum required `AccessLevel` value.
 * @param label - Requirement described in the 403 message, e.g. `'Manager or above'`.
 * @returns An Express middleware: calls `next()` when the session user meets `level`,
 *   otherwise renders a 403 error page.
 */
function requireAccessLevel(level: number, label: string): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    if (req.session.user && req.session.user.accessLevel >= level) {
      next();
    } else {
      res.status(403);
      renderView(res, 'error', {
        message: `Access denied — ${label} required.`,
        user: req.session.user ?? null,
        csrfToken: req.session?.user ? ensureSessionCsrfToken(req) : '',
      });
    }
  };
}

/** Ensures the current-guild access level is Mod or above, otherwise renders a 403. */
export const requireMod = requireAccessLevel(AccessLevel.MOD, 'Mod or above');

/** Ensures the current-guild access level is Manager or above, otherwise renders a 403. */
export const requireManager = requireAccessLevel(AccessLevel.MANAGER, 'Manager or above');

/**
 * Creates a middleware that authenticates a request via a `Bearer` token: hashes it with
 * SHA-256, resolves the hash to an identity via `lookup`, and stores it on `req` via `assign`
 * on success. Responds 401 when the header is missing/empty or `lookup` finds no match, and
 * 500 on any other lookup failure. Shared factory behind `requireApiKey`/`requireCompanionKey`.
 * @param lookup - Resolves a SHA-256 hex hash to the authenticated identity, or null if no match.
 * @param assign - Stores the resolved identity on `req` for downstream handlers.
 * @returns An Express middleware.
 */
function authenticateBearerToken<T>(
  lookup: (hash: string) => Promise<T | null>,
  assign: (req: Request, value: T) => void,
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  return async (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!token) {
      res.status(401).json({ ok: false, error: 'Unauthorized' });
      return;
    }
    const hash = createHash('sha256').update(token).digest('hex');
    try {
      const value = await lookup(hash);
      if (value === null) {
        res.status(401).json({ ok: false, error: 'Unauthorized' });
        return;
      }
      assign(req, value);
      next();
    } catch {
      res.status(500).json({ ok: false, error: 'Internal server error' });
    }
  };
}

/**
 * Authenticates a Streamdeck API request via a `Bearer` token, hashing it and looking it
 * up by identity only. On success, attaches the key owner's Discord ID to the request —
 * the same key may be approved for more than one guild (or none yet), so each route must
 * resolve its own target guild and check {@link isKeyApprovedForGuild} before acting.
 */
export const requireApiKey = authenticateBearerToken(
  async (hash) => (await findKeyByHash(hash))?.discordId ?? null,
  (req, discordId: string) => { req.apiKeyOwner = discordId; },
);

/**
 * Authenticates a companion app request via a `Bearer` token, hashing it and looking it
 * up against active (non-revoked) companion tokens. On success, attaches the token
 * owner's Discord ID to the request.
 */
export const requireCompanionKey = authenticateBearerToken(
  findDiscordIdByTokenHash,
  (req, discordId: string) => { req.companionDiscordId = discordId; },
);

/** Ensures the current-guild access level is Admin, otherwise renders a 403. */
export const requireAdmin = requireAccessLevel(AccessLevel.ADMIN, 'Admin');

/**
 * Ensures the session user is the bot owner (`user.is_owner`), otherwise renders a
 * 403. Distinct from {@link requireAdmin}: `isOwner` is a global super-admin flag set
 * manually in the DB (see `user.is_owner` in schema.sql), not a per-guild `AccessLevel`
 * — an Admin in a given guild is not necessarily the owner. Used to gate features
 * still being trialled to the single most-trusted account before a wider rollout.
 * @param req - Express request; checked for `req.session.user?.isOwner`.
 * @param res - Express response; used to render a 403 error page when denied.
 * @param next - Called when the session user is the owner.
 * @returns Nothing; either calls `next()` or renders the error view with a 403 status.
 */
export function requireOwner(req: Request, res: Response, next: NextFunction): void {
  if (req.session.user?.isOwner) {
    next();
  } else {
    res.status(403);
    renderView(res, 'error', {
      message: 'Access denied — Owner required.',
      user: req.session.user ?? null,
      csrfToken: req.session?.user ? ensureSessionCsrfToken(req) : '',
    });
  }
}

/**
 * Same check as {@link requireOwner}, for JSON-only routes: responds
 * `403 { error: 'forbidden' }` instead of rendering an HTML error page, so a
 * denied `fetch` call gets a real error payload instead of falling back to a
 * generic parse-failure message. See issue #451 — this is intentionally a
 * one-off next to `requireOwner` rather than a generic render-vs-json option
 * on `requireAccessLevel`; extract a shared factory once a second JSON-over-session
 * guard is needed.
 * @param req - Express request; checked for `req.session.user?.isOwner`.
 * @param res - Express response; used to send a 403 JSON body when denied.
 * @param next - Called when the session user is the owner.
 * @returns Nothing; either calls `next()` or sends a 403 JSON response.
 */
export function requireOwnerJson(req: Request, res: Response, next: NextFunction): void {
  if (req.session.user?.isOwner) {
    next();
  } else {
    res.status(403).json({ error: 'forbidden' });
  }
}
