import { createHash } from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { ensureSessionCsrfToken } from './csrf';
import { AccessLevel, findApprovedKeyByHash, getEffectiveAccessLevel } from '../db';

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
 * belongs to. The effective access level is recomputed for the resolved guild so
 * authorization always reflects the current guild, never a stale login-time value.
 */
export async function requireGuildContext(req: Request, res: Response, next: NextFunction): Promise<void> {
  const user = req.session.user;
  if (!user) {
    res.redirect('/auth/login');
    return;
  }

  // A stored guild must still be one the user can act in (membership may have been
  // revoked since login). Drop it and re-pick if not.
  if (user.currentGuildId && !user.guilds.some((g) => g.guildId === user.currentGuildId)) {
    user.currentGuildId = null;
  }

  if (!user.currentGuildId) {
    if (user.guilds.length === 1) {
      user.currentGuildId = user.guilds[0].guildId;
      user.accessLevel = (await getEffectiveAccessLevel(user.currentGuildId, user.discordId)) as 0 | 1 | 2 | 3;
    } else {
      res.redirect('/guild/select');
      return;
    }
  }

  next();
}

export function requireManager(req: Request, res: Response, next: NextFunction): void {
  if (req.session.user && req.session.user.accessLevel >= AccessLevel.MANAGER) {
    next();
  } else {
    res
      .status(403)
      .render('error', {
        message: 'Access denied — Manager or above required.',
        user: req.session.user ?? null,
        csrfToken: req.session?.user ? ensureSessionCsrfToken(req) : '',
      });
  }
}

export function requireMod(req: Request, res: Response, next: NextFunction): void {
  if (req.session.user && req.session.user.accessLevel >= AccessLevel.MOD) {
    next();
  } else {
    res
      .status(403)
      .render('error', {
        message: 'Access denied — Mod or above required.',
        user: req.session.user ?? null,
        csrfToken: req.session?.user ? ensureSessionCsrfToken(req) : '',
      });
  }
}

export async function requireApiKey(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers['authorization'];
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token) {
    res.status(401).json({ ok: false, error: 'Unauthorized' });
    return;
  }
  const hash = createHash('sha256').update(token).digest('hex');
  try {
    const row = await findApprovedKeyByHash(hash);
    if (!row) {
      res.status(401).json({ ok: false, error: 'Unauthorized' });
      return;
    }
    req.apiKeyOwner = row.discord_id;
    next();
  } catch {
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.session.user && req.session.user.accessLevel >= AccessLevel.ADMIN) {
    next();
  } else {
    res
      .status(403)
      .render('error', {
        message: 'Access denied — Admin required.',
        user: req.session.user ?? null,
        csrfToken: req.session?.user ? ensureSessionCsrfToken(req) : '',
      });
  }
}
