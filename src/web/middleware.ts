import { createHash } from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { ensureSessionCsrfToken } from './csrf';
import { AccessLevel, findApprovedKeyByHash } from '../db';

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (req.session.user) {
    next();
  } else {
    res.redirect('/auth/login');
  }
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
