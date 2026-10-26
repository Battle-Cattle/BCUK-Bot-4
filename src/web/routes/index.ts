import express from 'express';
import type { Express, RequestHandler } from 'express';
import authRouter from './auth';
import passkeysRouter from './passkeys';
import guildRouter from './guild';
import eventsubCallbackRouter from './eventsubCallback';
import eventsubAdminRouter from './eventsubAdmin';
import botAuthRouter from './botAuth';
import botAuthCallbackRouter from './botAuthCallback';
import dashboardRouter from './dashboard';
import dashboardEventsRouter from './dashboardEvents';
import dashboardStatusEventsRouter from './dashboardStatusEvents';
import adminRouter from './admin';
import apiRouter from './api';
import sfxRouter from './sfx';
import sfxMutationsRouter from './sfxMutations';
import sfxPublicRouter from './sfxPublic';
import streamsRouter from './streams';
import commandsRouter from './commands';
import countersRouter from './counters';
import counterHistoryRouter from './counterHistory';
import loyaltyPointsRouter from './loyaltyPoints';
import advancedCommandsRouter from './advancedCommands';
import streamdeckRouter from './streamdeck';
import streamdeckKeysRouter from './streamdeckKeys';
import companionAuthRouter from './companionAuth';
import companionEventsRouter from './companionEvents';
import companionRewardsRouter from './companionRewards';
import companionCommandsRouter from './companionCommands';
import companionKeysRouter from './companionKeys';
import userSettingsRouter from './userSettings';
import overlaySourceRouter from './overlaySource';
import overlayAdminRouter from './overlayAdmin';
import alertsOverlaySourceRouter from './alertsOverlaySource';
import alertsAdminRouter from './alertsAdmin';
import channelPointsAdminRouter from './channelPointsAdmin';
import timersRouter from './timers';
import privacyRouter from './privacy';
import tosRouter from './tos';
import healthRouter from './health';
import healthStatusEventsRouter from './healthStatusEvents';
import { requireAuth, requireGuildContext } from '../middleware';
import { authLimiter, streamdeckAuthFailureLimiter } from '../rateLimits';

// Every feature route, mounted in one place so server.ts keeps only the app-wide middleware
// chain (see "Web Server" in CLAUDE.md). The order below matters: routers share prefixes and
// fall through via next(), and the requireAuth/requireGuildContext gates must run before any
// router that checks an access level.

/** Rate limiters created in server.ts that individual routes need. */
export interface MountRoutesOptions {
  /** Token-keyed limiter for the Stream Deck API. */
  streamdeckLimiter: RequestHandler;
}

/**
 * Mounts every feature router on `app`, after server.ts's session, rate-limit and
 * `res.locals` middleware and before its 404/error handlers.
 * @param app - The Express app to mount the routes on.
 * @param options - Limiters the routes need; see {@link MountRoutesOptions}.
 */
export function mountRoutes(app: Express, { streamdeckLimiter }: MountRoutesOptions): void {
  // authLimiter is applied exactly once for the whole '/auth' prefix (which also covers
  // '/auth/passkey'), rather than on each '/auth'-mounted router: the routers below share
  // a prefix and fall through via next(), so a per-mount limiter counted a single request
  // once per layer it passed through (express-rate-limit's ERR_ERL_DOUBLE_COUNT).
  app.use('/auth', authLimiter);
  app.use('/auth/passkey', passkeysRouter);
  app.use('/auth', authRouter);
  // EventSub OAuth callback — must be outside requireAuth (Twitch redirects here without session)
  app.use('/auth', eventsubCallbackRouter);
  // Bot chat OAuth callback — same reasoning, Twitch redirects here without session (see #550).
  app.use('/auth', botAuthCallbackRouter);
  // streamdeckAuthFailureLimiter (IP-keyed, counts only 401s) runs first: the token-keyed
  // streamdeckLimiter alone gives every random unverified token its own fresh bucket.
  app.use('/api/streamdeck', streamdeckAuthFailureLimiter, streamdeckLimiter, streamdeckRouter);
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
  app.use('/api/companion', companionCommandsRouter);
  app.use('/guild', requireAuth, guildRouter);
  app.use('/api', requireAuth, apiRouter);

  // Health isn't guild-scoped (unlike the '/admin'-mounted routers below), so it's mounted here,
  // ahead of the '/'-mounted routers' requireGuildContext gate — matching '/guild'/'/api' above —
  // rather than falling through the '/admin' prefix's adminGuildRouter, which would otherwise run
  // requireGuildContext for every '/admin/*' path regardless of which route actually matches.
  // requireOwner is applied per-route inside healthRouter/healthStatusEventsRouter (matching
  // admin.ts's per-route convention) rather than router-level here.
  app.use('/admin/health', requireAuth, healthRouter);
  app.use('/admin/health', requireAuth, healthStatusEventsRouter);
  // Bot chat account connect page (see #550) — same not-guild-scoped, owner-gated pattern as health above.
  app.use('/admin/bot-auth', requireAuth, botAuthRouter);

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
  rootAuthedRouter.use(loyaltyPointsRouter);
  rootAuthedRouter.use(advancedCommandsRouter);
  rootAuthedRouter.use(timersRouter);
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
}
