import express from 'express';
import type { ErrorRequestHandler } from 'express';
import session from 'express-session';
import MySQLStore from 'express-mysql-session';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { WEB_PORT, SESSION_SECRET, DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME } from '../config';

const isProduction = process.env.NODE_ENV === 'production';
import authRouter from './routes/auth';
import dashboardRouter from './routes/dashboard';
import adminRouter from './routes/admin';
import apiRouter from './routes/api';
import sfxRouter from './routes/sfx';
import streamsRouter from './routes/streams';
import commandsRouter from './routes/commands';
import countersRouter from './routes/counters';
import commandMonitorRouter from './routes/commandMonitor';
import streamdeckRouter from './routes/streamdeck';
import streamdeckKeysRouter from './routes/streamdeckKeys';
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
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip: (req) => req.path.startsWith('/api/streamdeck'),
});
// Tighter limit for auth endpoints to protect against OAuth quota exhaustion
const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: 'Too many requests, please try again shortly.',
});
// Generous limit for the Streamdeck API — authenticated by API key, used for live button presses
const streamdeckLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: 'Too many requests, please try again shortly.',
});
app.use(generalLimiter);

// Body parsers
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Session
if (isProduction) app.set('trust proxy', 1);
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

app.use((req, res, next) => {
  res.locals.user = req.session.user ?? null;
  res.locals.csrfToken = req.session.user ? ensureSessionCsrfToken(req) : '';
  next();
});

// Routes
app.use('/auth', authLimiter, authRouter);
app.use('/api/streamdeck', streamdeckLimiter, streamdeckRouter);
app.use('/api', requireAuth, apiRouter);
app.use('/', requireAuth, streamdeckKeysRouter);
app.use('/', requireAuth, sfxRouter);
app.use('/admin', requireAuth, adminRouter);
app.use('/admin', requireAuth, streamsRouter);
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

  console.error('[Web] Invalid CSRF token:', err);

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
  console.error('[Web] Unhandled error:', err);
  res.status(500).render('error', {
    message: 'An unexpected error occurred.',
    user: req.session.user ?? null,
    csrfToken: req.session.user ? ensureSessionCsrfToken(req) : '',
  });
});

export function startWebPanel(): void {
  app.listen(WEB_PORT, () => {
    console.log(`[Web] Panel available at http://localhost:${WEB_PORT}`);
  });
}
