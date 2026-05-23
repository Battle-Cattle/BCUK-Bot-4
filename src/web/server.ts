import { createLogger } from '../logger';
import express from 'express';
import type { ErrorRequestHandler } from 'express';
import session from 'express-session';
import MySQLStore from 'express-mysql-session';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { WEB_PORT, SESSION_SECRET, DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME } from '../config';

const log = createLogger('Web');

const isProduction = process.env.NODE_ENV === 'production';
import authRouter from './routes/auth';
import eventsubCallbackRouter from './routes/eventsubCallback';
import eventsubAdminRouter from './routes/eventsubAdmin';
import dashboardRouter from './routes/dashboard';
import adminRouter from './routes/admin';
import apiRouter from './routes/api';
import sfxRouter from './routes/sfx';
import sfxPublicRouter from './routes/sfxPublic';
import streamsRouter from './routes/streams';
import commandsRouter from './routes/commands';
import countersRouter from './routes/counters';
import commandMonitorRouter from './routes/commandMonitor';
import streamdeckRouter from './routes/streamdeck';
import streamdeckKeysRouter from './routes/streamdeckKeys';
import userSettingsRouter from './routes/userSettings';
import { requireAuth } from './middleware';
import { ensureSessionCsrfToken } from './csrf';

const app = express();

app.use(
  helmet({
    hsts: isProduction
      ? { maxAge: 31536000, includeSubDomains: true }
      : false,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        scriptSrcAttr: ["'none'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https://cdn.discordapp.com', 'https://static-cdn.jtvnw.net'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: isProduction ? [] : null,
      },
    },
    referrerPolicy: { policy: 'no-referrer' },
  }),
);

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '../../views'));

// Static assets
app.use(express.static(path.join(__dirname, '../../public')));

// Rate limiting — applied after static assets so file downloads aren't counted
const ipKey = (req: express.Request) => req.ip ?? req.socket?.remoteAddress ?? 'unknown';

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: ipKey,
  // Skip authenticated users (session already proves identity) and the Streamdeck API
  // which has its own limiter. This prevents panel pollers from exhausting the budget.
  skip: (req) => req.path.startsWith('/api/streamdeck') || !!req.session?.user,
});
// Tighter limit for auth endpoints to protect against OAuth quota exhaustion
const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: ipKey,
  message: 'Too many requests, please try again shortly.',
});
// Generous limit for the Streamdeck API — keyed by Bearer token so each API key gets
// its own bucket regardless of which IP the request originates from.
const streamdeckLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => {
    const auth = req.headers['authorization'];
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
    return token ?? (req.ip ?? req.socket?.remoteAddress ?? 'unknown');
  },
  message: 'Too many requests, please try again shortly.',
});
// Body parsers
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Session
// Always trust exactly one proxy hop (Caddy). Without this, req.ip resolves to
// Caddy's loopback address and all users share a single rate-limit bucket.
app.set('trust proxy', 1);
const sessionStore = new (MySQLStore(session))({
  host: DB_HOST,
  port: DB_PORT,
  user: DB_USER,
  password: DB_PASSWORD,
  database: DB_NAME,
  expiration: 24 * 60 * 60 * 1000,
  createDatabaseTable: true,
  schema: { tableName: 'sessions' },
});
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    store: sessionStore,
    cookie: { secure: isProduction, httpOnly: true, sameSite: 'lax', maxAge: 24 * 60 * 60 * 1000 },
  }),
);

// General rate limiter — placed after session so authenticated users can be skipped
app.use(generalLimiter);

app.use((req, res, next) => {
  res.locals.user = req.session.user ?? null;
  res.locals.csrfToken = req.session.user ? ensureSessionCsrfToken(req) : '';
  next();
});

// Routes
app.use('/auth', authLimiter, authRouter);
// EventSub OAuth callback — must be outside requireAuth (Twitch redirects here without session)
app.use('/auth', authLimiter, eventsubCallbackRouter);
app.use('/api/streamdeck', streamdeckLimiter, streamdeckRouter);
app.use('/', sfxPublicRouter);
app.use('/api', requireAuth, apiRouter);
app.use('/', requireAuth, streamdeckKeysRouter);
app.use('/', requireAuth, sfxRouter);
app.use('/admin', requireAuth, adminRouter);
app.use('/admin', requireAuth, streamsRouter);
app.use('/admin', requireAuth, eventsubAdminRouter);
app.use('/user/settings', requireAuth, userSettingsRouter);
app.use('/admin', requireAuth, commandsRouter);
app.use('/admin', requireAuth, countersRouter);
app.use('/admin', requireAuth, commandMonitorRouter);
app.use('/', requireAuth, dashboardRouter);

// 404 handler
app.use((req, res) => {
  res.status(404).render('error', {
    message: 'Page not found.',
    user: req.session.user ?? null,
    csrfToken: req.session.user ? ensureSessionCsrfToken(req) : '',
  });
});

const csrfErrorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if ((err as { code?: string } | undefined)?.code !== 'EBADCSRFTOKEN') {
    next(err);
    return;
  }

  log.error('Invalid CSRF token:', err);

  if (req.originalUrl === '/api' || req.originalUrl.startsWith('/api/')) {
    res.status(403).json({
      ok: false,
      error: 'Your form session expired or the request could not be verified. Please reload the page and try again.',
    });
    return;
  }

  res.status(403).render('error', {
    message: 'Your form session expired or the request could not be verified. Please reload the page and try again.',
    user: req.session.user ?? null,
    csrfToken: req.session.user ? ensureSessionCsrfToken(req) : '',
  });
};

app.use(csrfErrorHandler);

// Centralised error handler
app.use((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  log.error('Unhandled error:', err);
  res.status(500).render('error', {
    message: 'An unexpected error occurred.',
    user: req.session.user ?? null,
    csrfToken: req.session.user ? ensureSessionCsrfToken(req) : '',
  });
});

export function startWebPanel(): void {
  app.listen(WEB_PORT, () => {
    log.info(`Panel available at http://localhost:${WEB_PORT}`);
  });
}
