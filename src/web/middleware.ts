import { Request, Response, NextFunction } from 'express';
import { ensureSessionCsrfToken } from './csrf';
import { AccessLevel } from '../db';

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
