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
 * Ensures the current-guild access level is Manager or above, otherwise renders a 403.
 * @param req - Express request; reads `req.session.user.accessLevel`.
 * @param res - Express response; used to render the 403 error page on denial.
 * @param next - Called when the access level check passes.
 * @returns Nothing; either calls `next()` or renders an error response.
 */
export function requireManager(req: Request, res: Response, next: NextFunction): void {
  if (req.session.user && req.session.user.accessLevel >= AccessLevel.MANAGER) {
    next();
  } else {
    res.status(403);
    renderView(res, 'error', {
      message: 'Access denied — Manager or above required.',
      user: req.session.user ?? null,
      csrfToken: req.session?.user ? ensureSessionCsrfToken(req) : '',
    });
  }
}

/**
 * Ensures the current-guild access level is Mod or above, otherwise renders a 403.
 * @param req - Express request; reads `req.session.user.accessLevel`.
 * @param res - Express response; used to render the 403 error page on denial.
 * @param next - Called when the access level check passes.
 * @returns Nothing; either calls `next()` or renders an error response.
 */
export function requireMod(req: Request, res: Response, next: NextFunction): void {
  if (req.session.user && req.session.user.accessLevel >= AccessLevel.MOD) {
    next();
  } else {
    res.status(403);
    renderView(res, 'error', {
      message: 'Access denied — Mod or above required.',
      user: req.session.user ?? null,
      csrfToken: req.session?.user ? ensureSessionCsrfToken(req) : '',
    });
  }
}

/**
 * Authenticates a Streamdeck API request via a `Bearer` token, hashing it and looking it
 * up by identity only. On success, attaches the key owner's Discord ID to the request —
 * the same key may be approved for more than one guild (or none yet), so each route must
 * resolve its own target guild and check {@link isKeyApprovedForGuild} before acting.
 * @param req - Express request; reads the `Authorization` header.
 * @param res - Express response; used to respond 401/500 on failure.
 * @param next - Called once `req.apiKeyOwner` has been set.
 * @returns A promise that resolves once `next()` or an error response has been issued.
 */
export async function requireApiKey(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers['authorization'];
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token) {
    res.status(401).json({ ok: false, error: 'Unauthorized' });
    return;
  }
  const hash = createHash('sha256').update(token).digest('hex');
  try {
    const row = await findKeyByHash(hash);
    if (!row) {
      res.status(401).json({ ok: false, error: 'Unauthorized' });
      return;
    }
    req.apiKeyOwner = row.discordId;
    next();
  } catch {
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
}

/**
 * Authenticates a companion app request via a `Bearer` token, hashing it and looking it
 * up against active (non-revoked) companion tokens. On success, attaches the token
 * owner's Discord ID to the request.
 * @param req - Express request; reads the `Authorization` header.
 * @param res - Express response; used to respond 401/500 on failure.
 * @param next - Called once `req.companionDiscordId` has been set.
 * @returns A promise that resolves once `next()` or an error response has been issued.
 */
export async function requireCompanionKey(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers['authorization'];
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token) {
    res.status(401).json({ ok: false, error: 'Unauthorized' });
    return;
  }
  const hash = createHash('sha256').update(token).digest('hex');
  try {
    const discordId = await findDiscordIdByTokenHash(hash);
    if (!discordId) {
      res.status(401).json({ ok: false, error: 'Unauthorized' });
      return;
    }
    req.companionDiscordId = discordId;
    next();
  } catch {
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
}

/**
 * Ensures the current-guild access level is Admin, otherwise renders a 403.
 * @param req - Express request; reads `req.session.user.accessLevel`.
 * @param res - Express response; used to render the 403 error page on denial.
 * @param next - Called when the access level check passes.
 * @returns Nothing; either calls `next()` or renders an error response.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.session.user && req.session.user.accessLevel >= AccessLevel.ADMIN) {
    next();
  } else {
    res.status(403);
    renderView(res, 'error', {
      message: 'Access denied — Admin required.',
      user: req.session.user ?? null,
      csrfToken: req.session?.user ? ensureSessionCsrfToken(req) : '',
    });
  }
}
