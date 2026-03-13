import express from 'express';
import session from 'express-session';
import path from 'path';
import { WEB_PORT, SESSION_SECRET } from '../config';
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
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 },
  }),
);

// Routes
app.use('/auth', authRouter);
app.use('/api', requireAuth, apiRouter);
app.use('/admin', requireAuth, adminRouter);
app.use('/admin', requireAuth, streamsRouter);
app.use('/', requireAuth, dashboardRouter);

export function startWebPanel(): void {
  app.listen(WEB_PORT, () => {
    console.log(`[Web] Panel available at http://localhost:${WEB_PORT}`);
  });
}
