import { createLogger } from '../shared/logger';
import express from 'express';
import type { ErrorRequestHandler } from 'express';
import session from 'express-session';
import MySQLStore from 'express-mysql-session';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { WEB_PORT, SESSION_SECRET, DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME } from '../shared/config';

const log = createLogger('Web');

const isProduction = process.env.NODE_ENV === 'production';
import authRouter from './routes/auth';
import guildRouter from './routes/guild';
import eventsubCallbackRouter from './routes/eventsubCallback';
import eventsubAdminRouter from './routes/eventsubAdmin';
import dashboardRouter from './routes/dashboard';
import adminRouter from './routes/admin';
import apiRouter from './routes/api';
import sfxRouter from './routes/sfx';
import sfxMutationsRouter from './routes/sfxMutations';
import sfxPublicRouter from './routes/sfxPublic';
import streamsRouter from './routes/streams';
import commandsRouter from './routes/commands';
import countersRouter from './routes/counters';
import commandMonitorRouter from './routes/commandMonitor';
import streamdeckRouter from './routes/streamdeck';
import streamdeckKeysRouter from './routes/streamdeckKeys';
import companionAuthRouter from './routes/companionAuth';
import companionEventsRouter from './routes/companionEvents';
import companionKeysRouter from './routes/companionKeys';
import userSettingsRouter from './routes/userSettings';
import overlaySourceRouter from './routes/overlaySource';
import overlayAdminRouter from './routes/overlayAdmin';
import privacyRouter from './routes/privacy';
import tosRouter from './routes/tos';
import { requireAuth, requireGuildContext } from './middleware';
import { ensureSessionCsrfToken } from './csrf';
import {
  authLimiter,
  ipKey,
  generalLimiterSkip,
  sessionLimiterKey,
  sessionLimiterSkip,
  streamdeckLimiterKey,
} from './rateLimits';

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
        mediaSrc: ["'self'"],
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
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: ipKey,
  skip: generalLimiterSkip,
});
// Generous limit for the Streamdeck API — keyed by Bearer token so each API key gets
// its own bucket regardless of which IP the request originates from.
const streamdeckLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: streamdeckLimiterKey,
  message: 'Too many requests, please try again shortly.',
});
// Per-account limit for session-authenticated panel users. Dashboard polling alone
// can reach ~420 req/15 min (status + command-monitor + streams-live), so 600 gives
// headroom while still capping a compromised or runaway session. Skips unauthenticated
// requests (covered by generalLimiter) and the Streamdeck API (its own limiter).
const sessionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 600,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: sessionLimiterKey,
  skip: sessionLimiterSkip,
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

// Rate limiters — placed after session middleware so req.session is populated
app.use(generalLimiter);
app.use(sessionLimiter);

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
app.use('/', privacyRouter);
app.use('/', tosRouter);
app.use('/overlay', overlaySourceRouter);
// authLimiter is applied per-route inside companionAuthRouter, not here — this
// router is mounted at '/', so a blanket limiter here would rate-limit every
// request on the site, not just the companion app's OAuth routes.
app.use('/', companionAuthRouter);
app.use('/api/companion', companionEventsRouter);
app.use('/guild', requireAuth, guildRouter);
app.use('/api', requireAuth, apiRouter);

// All of the routers below share the same '/' mount point, so registering each one
// behind its own app.use(path, ...middleware, router) call made requireAuth (and, for
// some, requireGuildContext) run once per sibling mount per request — not once per
// request — since every '/'-mounted layer matches every path and falls through via
// next() until a route inside actually matches. Nesting them under shared Router()
// instances collapses that to one middleware pass per group.
//
// requireGuildContext refreshes req.session.user.accessLevel for the current guild;
// sfxMutationsRouter gates on requireMod, which reads that level, so it must run
// behind requireGuildContext (not just requireAuth) or a stale/missing level could
// bypass the Mod check.
const rootGuildRouter = express.Router();
rootGuildRouter.use(requireGuildContext);
rootGuildRouter.use(streamdeckKeysRouter);
rootGuildRouter.use(companionKeysRouter);
rootGuildRouter.use(dashboardRouter);
rootGuildRouter.use(sfxMutationsRouter);

const rootAuthedRouter = express.Router();
rootAuthedRouter.use(requireAuth);
rootAuthedRouter.use(sfxRouter);
rootAuthedRouter.use(commandsRouter);
rootAuthedRouter.use(countersRouter);
rootAuthedRouter.use(commandMonitorRouter);
rootAuthedRouter.use(rootGuildRouter);
app.use('/', rootAuthedRouter);

// Same redundancy as above for the '/admin'-mounted routers.
const adminGuildRouter = express.Router();
adminGuildRouter.use(requireAuth, requireGuildContext);
adminGuildRouter.use(adminRouter);
adminGuildRouter.use(streamsRouter);
adminGuildRouter.use(eventsubAdminRouter);
app.use('/admin', adminGuildRouter);

app.use('/user/settings', requireAuth, userSettingsRouter);
app.use('/overlay', requireAuth, overlayAdminRouter);

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

// Exported so server.test.ts can drive the real route/middleware wiring with supertest
// without spinning up a listening socket.
export { app };

export function startWebPanel(): void {
  app.listen(WEB_PORT, () => {
    log.info(`Panel available at http://localhost:${WEB_PORT}`);
  });
}
