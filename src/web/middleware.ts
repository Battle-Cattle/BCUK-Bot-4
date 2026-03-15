import { Request, Response, NextFunction } from 'express';

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (req.session.user) {
    next();
  } else {
    res.redirect('/auth/login');
  }
}

export function requireManager(req: Request, res: Response, next: NextFunction): void {
  if (req.session.user && req.session.user.accessLevel >= 2) {
    next();
  } else {
    res
      .status(403)
      .render('error', { message: 'Access denied — Manager or above required.', user: req.session.user ?? null });
  }
}

export function requireMod(req: Request, res: Response, next: NextFunction): void {
  if (req.session.user && req.session.user.accessLevel >= 1) {
    next();
  } else {
    res
      .status(403)
      .render('error', { message: 'Access denied — Mod or above required.', user: req.session.user ?? null });
  }
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.session.user && req.session.user.accessLevel >= 3) {
    next();
  } else {
    res
      .status(403)
      .render('error', { message: 'Access denied — Admin required.', user: req.session.user ?? null });
  }
}
