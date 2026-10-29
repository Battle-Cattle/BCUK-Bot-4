import { createLogger } from '../shared/logger';
import express from 'express';
import type { ErrorRequestHandler } from 'express';
import session from 'express-session';
import MySQLStore from 'express-mysql-session';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'path';
import type { Server } from 'http';
import { WEB_PORT, SESSION_SECRET, DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME } from '../shared/config';

const log = createLogger('Web');

const isProduction = process.env.NODE_ENV === 'production';
import serviceWorkerRouter from './routes/serviceWorker';
import streamdeckPluginDownloadRouter from './routes/streamdeckPluginDownload';
import { mountRoutes } from './routes/index';
import { ensureSessionCsrfToken } from './csrf';
import { renderView } from './routes/viewHelpers';
import {
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

// Liveness probe for deploy.sh's post-restart check: answers once the panel is listening, which
// main() only reaches after the DB ping, guild registry load and bot startup. Registered ahead
// of static files, sessions and the rate limiters so polling it never touches the session store
// or uses up a client's request budget, and it reveals nothing beyond "up".
/**
 * GET /healthz — replies 200 `{"status":"ok"}`, uncached.
 * @param _req - Express request (unused).
 * @param res - Express response.
 */
app.get('/healthz', (_req, res) => {
  res.set('Cache-Control', 'no-store').json({ status: 'ok' });
});

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '../../views'));

// Served ahead of the static middleware below so its cache-version substitution (see
// serviceWorker.ts) takes effect instead of the raw, unsubstituted file on disk.
app.use(serviceWorkerRouter);
// Ahead of static for the same reason: a stale plugin file left in public/downloads/ must not
// shadow the redirect to the latest release (see streamdeckPluginDownload.ts).
app.use(streamdeckPluginDownloadRouter);

// Browser half of the passkey (WebAuthn) flow, served straight from the installed package so
// it always matches the server library's version. Must be same-origin: CSP is script-src 'self'.
app.use(
  '/vendor/simplewebauthn',
  express.static(path.join(__dirname, '../../node_modules/@simplewebauthn/browser/dist/bundle'), {
    /**
     * Forces revalidation on every response, matching the public/ static assets below.
     * @param res - The response for the vendored SimpleWebAuthn file being served.
     */
    setHeaders: (res) => {
      res.setHeader('Cache-Control', 'no-cache');
    },
  }),
);

// Static assets. `Cache-Control: no-cache` forces revalidation (via the ETag express.static
// already sends) on every request rather than letting browsers serve a stale copy from
// heuristic HTTP caching — without it, a deploy's new CSS/JS can be masked both for plain
// page loads and for the service worker's own cache-busting fetches in install (see
// serviceWorker.ts), since those fetches would otherwise also read from the stale HTTP cache.
app.use(
  express.static(path.join(__dirname, '../../public'), {
    /**
     * Forces revalidation on every static asset response instead of allowing heuristic HTTP caching.
     * @param res - The response for the public/ static file being served.
     */
    setHeaders: (res) => {
      res.setHeader('Cache-Control', 'no-cache');
    },
  }),
);

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
// can reach a few hundred req/15 min (status + streams-live), so 600 gives headroom
// while still capping a compromised or runaway session. Skips unauthenticated
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

// Feature routes, in their mount order (see routes/index.ts).
mountRoutes(app, { streamdeckLimiter });

/**
 * Renders the `error` view with the given status and message, including a real CSRF
 * token when a session user is present (needed for the logout form in `partials/nav`).
 * Shared by the 404, CSRF-failure, and catch-all error handlers below — unlike
 * `routes/shared.ts`'s `renderError`, which always passes an empty `csrfToken` and is
 * meant for already-authenticated route handlers rather than this app-wide fallback tier.
 * @param req - Express request; reads `req.session.user` if present. `req.session` itself is
 *   absent when the error came from middleware ahead of the session (e.g. the body parsers).
 * @param res - Express response; renders the `error` view with `status`.
 * @param status - HTTP status code to set.
 * @param message - Human-readable error message shown to the user.
 */
function renderErrorPage(req: express.Request, res: express.Response, status: number, message: string): void {
  // Typed as always present, but body-parser errors reach the handlers before session middleware runs.
  const user = (req.session as express.Request['session'] | undefined)?.user ?? null;
  res.status(status);
  renderView(res, 'error', {
    message,
    user,
    csrfToken: user ? ensureSessionCsrfToken(req) : '',
  });
}

/**
 * Reads the 4xx status an `http-errors`-style error (e.g. body-parser's malformed-body,
 * bad-encoding or too-large errors) carries, so the catch-all handler can answer the client
 * with it instead of treating the client's mistake as a server failure.
 * @param err - The error handed to the error handler.
 * @returns The error's 4xx `status`/`statusCode`, or `undefined` when it has none (a real 500).
 */
function clientErrorStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const { status, statusCode } = err as { status?: unknown; statusCode?: unknown };
  const code = status ?? statusCode;
  return typeof code === 'number' && code >= 400 && code < 500 ? code : undefined;
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
 * Client errors (a 4xx `status`, e.g. a corrupt or unsupported-encoding request body from
 * body-parser) get that status and a one-line warning; anything else is logged as an error
 * and answered with a 500.
 * @param err - The unhandled error.
 * @param req - Express request; reads `req.session.user` if present.
 * @param res - Express response; renders the `error` view with the client-error status or 500.
 * @param _next - Unused, but required for Express to recognize this as an error handler.
 */
app.use((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = clientErrorStatus(err);
  if (status !== undefined) {
    // `status` is only set on objects, so `err` is one here.
    const { message } = err as { message?: unknown };
    log.warn(`Rejected bad request ${req.method} ${req.originalUrl} (${status}): ${String(message)}`);
    renderErrorPage(req, res, status, 'The request could not be processed.');
    return;
  }
  log.error('Unhandled error:', err);
  renderErrorPage(req, res, 500, 'An unexpected error occurred.');
});

// Exported so server.test.ts can drive the real route/middleware wiring with supertest
// without spinning up a listening socket.
export { app };

// Exported so server.test.ts can exercise these exact instances directly — confirming both
// that each got paired with the correct keyGenerator/skip function and that hitting the
// threshold actually enforces a 429 — without looping enough real requests through the
// entire app to reach the 100/600 thresholds via every other mounted route.
export { generalLimiter, sessionLimiter };

/** The panel's listening server, kept so {@link stopWebPanel} can close it on shutdown. */
let webServer: Server | null = null;

/**
 * Starts the Express app listening on {@link WEB_PORT}.
 * @param port - Port to listen on; defaults to {@link WEB_PORT} (tests pass 0 for a free port).
 * @returns Resolves with the listening server. Rejects with the listen error (e.g.
 *   `EADDRINUSE`) instead — Express 5 hands that error to the listen callback, so ignoring the
 *   callback's argument would log "Panel available" for a panel that never came up.
 */
export function startWebPanel(port: number = WEB_PORT): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, (err?: Error) => {
      if (err) {
        reject(err);
        return;
      }
      webServer = server;
      log.info(`Panel available at http://localhost:${port}`);
      resolve(server);
    });
  });
}

/**
 * Stops the web panel: stops accepting connections and drops the open ones — long-lived SSE
 * streams would otherwise hold `server.close()` open indefinitely. No-op if it isn't running.
 * @returns Resolves once the server has closed.
 */
export function stopWebPanel(): Promise<void> {
  const server = webServer;
  if (!server) return Promise.resolve();
  webServer = null;
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
    server.closeAllConnections();
  });
}
