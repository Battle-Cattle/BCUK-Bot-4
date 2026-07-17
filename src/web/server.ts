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
import dashboardEventsRouter from './routes/dashboardEvents';
import dashboardStatusEventsRouter from './routes/dashboardStatusEvents';
import adminRouter from './routes/admin';
import apiRouter from './routes/api';
import sfxRouter from './routes/sfx';
import sfxMutationsRouter from './routes/sfxMutations';
import sfxPublicRouter from './routes/sfxPublic';
import streamsRouter from './routes/streams';
import commandsRouter from './routes/commands';
import countersRouter from './routes/counters';
import counterHistoryRouter from './routes/counterHistory';
import commandMonitorRouter from './routes/commandMonitor';
import streamdeckRouter from './routes/streamdeck';
import streamdeckKeysRouter from './routes/streamdeckKeys';
import companionAuthRouter from './routes/companionAuth';
import companionEventsRouter from './routes/companionEvents';
import companionRewardsRouter from './routes/companionRewards';
import companionKeysRouter from './routes/companionKeys';
import userSettingsRouter from './routes/userSettings';
import overlaySourceRouter from './routes/overlaySource';
import overlayAdminRouter from './routes/overlayAdmin';
import alertsOverlaySourceRouter from './routes/alertsOverlaySource';
import alertsAdminRouter from './routes/alertsAdmin';
import channelPointsAdminRouter from './routes/channelPointsAdmin';
import privacyRouter from './routes/privacy';
import tosRouter from './routes/tos';
import serviceWorkerRouter from './routes/serviceWorker';
import { requireAuth, requireGuildContext } from './middleware';
import { ensureSessionCsrfToken } from './csrf';
import { renderView } from './routes/shared';
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
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        scriptSrcAttr: ["'none'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'https://cdn.discordapp.com', 'https://static-cdn.jtvnw.net'],
        fontSrc: ["'self'"],
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

// Served ahead of the static middleware below so its cache-version substitution (see
// serviceWorker.ts) takes effect instead of the raw, unsubstituted file on disk.
app.use(serviceWorkerRouter);

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
app.use('/alerts', alertsOverlaySourceRouter);
// authLimiter is applied per-route inside companionAuthRouter, not here — this
// router is mounted at '/', so a blanket limiter here would rate-limit every
// request on the site, not just the companion app's OAuth routes.
app.use('/', companionAuthRouter);
app.use('/api/companion', companionEventsRouter);
app.use('/api/companion', companionRewardsRouter);
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
rootAuthedRouter.use(counterHistoryRouter);
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
app.use('/alerts', requireAuth, alertsAdminRouter);
app.use('/channel-points', requireAuth, channelPointsAdminRouter);
app.use('/dashboard', requireAuth, dashboardEventsRouter);
app.use('/dashboard', requireAuth, dashboardStatusEventsRouter);

/**
 * Renders the `error` view with the given status and message, including a real CSRF
 * token when a session user is present (needed for the logout form in `partials/nav`).
 * Shared by the 404, CSRF-failure, and catch-all error handlers below — unlike
 * `routes/shared.ts`'s `renderError`, which always passes an empty `csrfToken` and is
 * meant for already-authenticated route handlers rather than this app-wide fallback tier.
 * @param req - Express request; reads `req.session.user` if present.
 * @param res - Express response; renders the `error` view with `status`.
 * @param status - HTTP status code to set.
 * @param message - Human-readable error message shown to the user.
 */
function renderErrorPage(req: express.Request, res: express.Response, status: number, message: string): void {
  res.status(status);
  renderView(res, 'error', {
    message,
    user: req.session.user ?? null,
    csrfToken: req.session.user ? ensureSessionCsrfToken(req) : '',
  });
}

/**
 * 404 handler — catches any request that fell through every mounted router.
 * @param req - Express request; reads `req.session.user` if present.
 * @param res - Express response; renders the `error` view with a 404 status.
 */
app.use((req, res) => {
  renderErrorPage(req, res, 404, 'Page not found.');
});

/**
 * Catches CSRF token validation failures raised by `csrfProtection` middleware.
 * Responds with JSON for `/api` requests, or renders the `error` view otherwise.
 * Delegates to `next(err)` for any other error type.
 * @param err - The error thrown by the request pipeline.
 * @param req - Express request; reads `req.originalUrl` and `req.session.user`.
 * @param res - Express response; renders/responds with a 403 on a CSRF failure.
 * @param next - Called with the original error when it isn't a CSRF failure.
 */
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

  renderErrorPage(req, res, 403, 'Your form session expired or the request could not be verified. Please reload the page and try again.');
};

app.use(csrfErrorHandler);

/**
 * Centralised error handler — catches anything unhandled by earlier middleware/routes.
 * @param err - The unhandled error.
 * @param req - Express request; reads `req.session.user` if present.
 * @param res - Express response; renders the `error` view with a 500 status.
 * @param _next - Unused, but required for Express to recognize this as an error handler.
 */
app.use((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  log.error('Unhandled error:', err);
  renderErrorPage(req, res, 500, 'An unexpected error occurred.');
});

// Exported so server.test.ts can drive the real route/middleware wiring with supertest
// without spinning up a listening socket.
export { app };

export function startWebPanel(): void {
  app.listen(WEB_PORT, () => {
    log.info(`Panel available at http://localhost:${WEB_PORT}`);
  });
}
