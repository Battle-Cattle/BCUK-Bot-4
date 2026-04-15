import express from 'express';
import type { ErrorRequestHandler } from 'express';
import session from 'express-session';
import MySQLStore from 'express-mysql-session';
import helmet from 'helmet';
import path from 'path';
import { WEB_PORT, SESSION_SECRET, DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME } from '../config';

const isProduction = process.env.NODE_ENV === 'production';
import authRouter from './routes/auth';
import dashboardRouter from './routes/dashboard';
import adminRouter from './routes/admin';
import apiRouter from './routes/api';
import streamsRouter from './routes/streams';
import commandsRouter from './routes/commands';
import countersRouter from './routes/counters';
import { requireAuth } from './middleware';

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
  res.locals.csrfToken = typeof req.session.csrfToken === 'string' ? req.session.csrfToken : '';
  next();
});

// Routes
app.use('/auth', authRouter);
app.use('/api', requireAuth, apiRouter);
app.use('/admin', requireAuth, adminRouter);
app.use('/admin', requireAuth, streamsRouter);
app.use('/admin', requireAuth, commandsRouter);
app.use('/admin', requireAuth, countersRouter);
app.use('/', requireAuth, dashboardRouter);

// 404 handler
app.use((_req, res) => {
  res.status(404).render('error', { message: 'Page not found.', user: null, csrfToken: '' });
});

const csrfErrorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if ((err as { code?: string } | undefined)?.code !== 'EBADCSRFTOKEN') {
    next(err);
    return;
  }

  console.error('[Web] Invalid CSRF token:', err);
  res.status(403).render('error', {
    message: 'Your form session expired or the request could not be verified. Please reload the page and try again.',
    user: req.session.user ?? null,
    csrfToken: typeof req.session.csrfToken === 'string' ? req.session.csrfToken : '',
  });
};

app.use(csrfErrorHandler);

// Centralised error handler
app.use((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[Web] Unhandled error:', err);
  res.status(500).render('error', {
    message: 'An unexpected error occurred.',
    user: req.session.user ?? null,
    csrfToken: typeof req.session.csrfToken === 'string' ? req.session.csrfToken : '',
  });
});

export function startWebPanel(): void {
  app.listen(WEB_PORT, () => {
    console.log(`[Web] Panel available at http://localhost:${WEB_PORT}`);
  });
}
