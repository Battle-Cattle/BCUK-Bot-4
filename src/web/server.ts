import express from 'express';
import session from 'express-session';
import path from 'path';
import { WEB_PORT, SESSION_SECRET } from '../config';

const isProduction = process.env.NODE_ENV === 'production';
import authRouter from './routes/auth';
import dashboardRouter from './routes/dashboard';
import adminRouter from './routes/admin';
import apiRouter from './routes/api';
import streamsRouter from './routes/streams';
import { requireAuth } from './middleware';

const app = express();

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
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { secure: isProduction, httpOnly: true, sameSite: 'lax', maxAge: 24 * 60 * 60 * 1000 },
  }),
);

// Routes
app.use('/auth', authRouter);
app.use('/api', requireAuth, apiRouter);
app.use('/admin', requireAuth, adminRouter);
app.use('/admin', requireAuth, streamsRouter);
app.use('/', requireAuth, dashboardRouter);

// 404 handler
app.use((_req, res) => {
  res.status(404).render('error', { message: 'Page not found.', user: null });
});

// Centralised error handler
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[Web] Unhandled error:', err);
  res.status(500).render('error', { message: 'An unexpected error occurred.', user: null });
});

export function startWebPanel(): void {
  app.listen(WEB_PORT, () => {
    console.log(`[Web] Panel available at http://localhost:${WEB_PORT}`);
  });
}
