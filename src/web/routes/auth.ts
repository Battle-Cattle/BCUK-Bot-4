import { createLogger } from '../../shared/logger';
import { Router, type Request, type Response } from 'express';
import crypto from 'crypto';
import { DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, DISCORD_CALLBACK_URL } from '../../shared/config';
import { findUser, createCode } from '../../db';
import { resolveAccessibleGuilds, establishDashboardSession, type DiscordProfile } from '../loginSession';
import { csrfProtection, oauthStateMatches } from '../csrf';
import { requireAuth } from '../middleware';
import { filterQueryParam, isLoopbackRedirectUri } from './validation';
import { renderError, renderView } from './viewHelpers';
import { fetchWithRetry } from '../../shared/fetchWithRetry';

const log = createLogger('Web');
const router = Router();

/**
 * Error codes `GET /auth/login` accepts via `?error=`: `user_not_found`/`no_guilds` originate from
 * `POST /guild/select`; the `passkey_*`/`not_whitelisted` codes from a failed passkey sign-in (see passkeys.ts).
 */
const LOGIN_KNOWN_ERRORS = new Set(['user_not_found', 'no_guilds', 'not_whitelisted', 'passkey_failed', 'passkey_unknown']);

// Where `GET /auth/discord?return=<key>` may send the user after logging in. A fixed map rather
// than a caller-supplied path, so the parameter can't be used as an open redirect.
const LOGIN_RETURN_PATHS: Record<string, string> = {
  passkey: '/user/settings?success=passkey_reauthed',
};

// ─── Redirect to Discord OAuth2 ─────────────────────────────────────────────

/**
 * GET /auth/discord — starts the Discord OAuth2 flow. Generates a CSRF state
 * token, stores it on the session with a 10-minute expiry, then redirects the
 * browser to Discord's authorize URL.
 * @param req - Express request; receives the generated `oauthState` on its session. An optional
 *   `return` query key picks a post-login destination from {@link LOGIN_RETURN_PATHS}; unknown
 *   keys are ignored.
 * @param res - Express response; redirects to discord.com's OAuth2 authorize endpoint.
 */
router.get('/discord', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  const returnKey = req.query.return;
  const returnTo = typeof returnKey === 'string' && Object.hasOwn(LOGIN_RETURN_PATHS, returnKey)
    ? LOGIN_RETURN_PATHS[returnKey]
    : undefined;
  req.session.oauthState = { value: state, expiresAt: Date.now() + 10 * 60 * 1000, returnTo };

  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: DISCORD_CALLBACK_URL,
    response_type: 'code',
    scope: 'identify',
    state,
  });
  const authUrl = `https://discord.com/oauth2/authorize?${params}`;
  res.redirect(authUrl);
});

// ─── OAuth2 callback ─────────────────────────────────────────────────────────

/**
 * Exchanges an OAuth2 `code` for a Discord access token, via `fetchWithRetry`
 * (retries transient 502/503/504 responses from Discord's API).
 * @param code - The authorization code from Discord's OAuth2 redirect.
 * @returns The access token.
 * @throws If the token endpoint responds with a non-OK status.
 */
async function exchangeCodeForToken(code: string): Promise<string> {
  const tokenRes = await fetchWithRetry('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: DISCORD_CLIENT_ID,
      client_secret: DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: DISCORD_CALLBACK_URL,
    }),
    signal: AbortSignal.timeout(10_000),
  }, log);
  if (!tokenRes.ok) throw new Error(`Token exchange failed: ${tokenRes.status}`);
  const { access_token } = (await tokenRes.json()) as { access_token: string };
  return access_token;
}

/**
 * Fetches the authenticated user's Discord profile with the given access token,
 * via `fetchWithRetry`.
 * @param accessToken - Bearer token from `exchangeCodeForToken`.
 * @returns The Discord `@me` profile (id, username, avatar hash).
 * @throws If the profile endpoint responds with a non-OK status.
 */
async function fetchDiscordProfile(accessToken: string): Promise<DiscordProfile> {
  const profileRes = await fetchWithRetry('https://discord.com/api/users/@me', {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(10_000),
  }, log);
  if (!profileRes.ok) throw new Error(`Profile fetch failed: ${profileRes.status}`);
  return (await profileRes.json()) as DiscordProfile;
}

/**
 * Completes the companion app's loopback OAuth flow, if one is pending on the
 * session: hands back a one-time code via the app's `redirectUri` instead of
 * creating a dashboard session. Re-validates `redirectUri` at point of use
 * (defense-in-depth against session tampering) before minting the code.
 * @param req - Express request; reads and clears `session.companionOAuth`.
 * @param res - Express response; redirected on success, or rendered as a 400
 *   error page if `redirectUri` fails the loopback check.
 * @param discordId - The authenticated user's Discord ID.
 * @returns True if a companion login was pending and the response was already
 *   sent (redirect or error) — the caller must stop. False if there was no
 *   pending companion login and normal dashboard-session creation should proceed.
 */
async function tryCompleteCompanionLogin(req: Request, res: Response, discordId: string): Promise<boolean> {
  const companionOAuth = req.session.companionOAuth;
  if (!companionOAuth || Date.now() > companionOAuth.expiresAt) return false;

  delete req.session.companionOAuth;
  if (!isLoopbackRedirectUri(companionOAuth.redirectUri)) {
    renderError(res, 400, 'Invalid companion redirect URI.', undefined);
    return true;
  }
  const authCode = await createCode(discordId);
  const redirectUrl = new URL(companionOAuth.redirectUri);
  redirectUrl.searchParams.set('code', authCode);
  redirectUrl.searchParams.set('state', companionOAuth.appState);
  res.redirect(redirectUrl.toString());
  return true;
}

/**
 * GET /auth/discord/callback — completes the Discord OAuth2 flow. Validates the
 * `state` param against the session, exchanges the `code` for an access token,
 * fetches the Discord profile, and checks the user whitelist. The token-exchange
 * and profile-fetch requests go through `fetchWithRetry`, which retries transient
 * 502/503/504 responses from Discord's API instead of failing the login outright.
 * Then either:
 * creates/refreshes the dashboard session as usual (resolving accessible guilds,
 * syncing the display name, regenerating the session), or — if this login was
 * initiated via the companion app's loopback flow (`req.session.companionOAuth`
 * set by companionAuth.ts) — skips session creation entirely and redirects to
 * the companion app's `redirectUri` with a one-time code instead. The
 * `discord_name` sync is serialized per Discord ID through `runUserMutation`,
 * so it can't race a concurrent admin edit or the name-refresh job on the same
 * user row.
 * @param req - Express request; reads `code`/`state` query params and the stored
 *   `oauthState` session value.
 * @param res - Express response; redirects to `/` (or the allowlisted `oauthState.returnTo`)
 *   on success, or to the companion app's `redirectUri` for the loopback flow. Renders a 400 error
 *   page when the OAuth state is invalid/missing or the companion redirectUri
 *   fails the loopback re-validation check (defense-in-depth), a 403 error page
 *   when the user is not whitelisted or has no accessible guild, or a 500 error
 *   page if any step of the exchange/profile-fetch/session-save fails.
 */
router.get('/discord/callback', async (req, res) => {
  // req.query values are `string | string[] | ParsedQs | ParsedQs[] | undefined` at runtime
  // (e.g. `?state=a&state=b` parses to an array) — narrow with typeof rather than an unchecked
  // `as` cast, so a tampered array/object param is rejected here instead of reaching
  // oauthStateMatches (which requires a string) or the token-exchange request body below.
  const { code, state } = req.query;
  if (typeof code !== 'string' || typeof state !== 'string') {
    return renderError(res, 400, 'Invalid OAuth2 state — please try logging in again.', undefined);
  }

  const storedOAuth = req.session.oauthState;
  delete req.session.oauthState;
  const stateValid = !!storedOAuth && oauthStateMatches(state, storedOAuth.value) && Date.now() <= storedOAuth.expiresAt;
  if (!code || !stateValid) {
    return renderError(res, 400, 'Invalid OAuth2 state — please try logging in again.', undefined);
  }

  try {
    const accessToken = await exchangeCodeForToken(code);
    const profile = await fetchDiscordProfile(accessToken);

    const dbUser = await findUser(profile.id);
    if (!dbUser) {
      return renderError(res, 403, 'You are not on the whitelist. Contact an admin to be added.', undefined);
    }

    const accessibleGuilds = await resolveAccessibleGuilds(dbUser);
    if (accessibleGuilds.length === 0) {
      return renderError(
        res,
        403,
        'You have not been added to any server yet. Contact the bot owner to be granted access.',
        undefined,
      );
    }

    if (await tryCompleteCompanionLogin(req, res, profile.id)) return;
    delete req.session.companionOAuth;

    await establishDashboardSession(req, profile, dbUser, accessibleGuilds, { discordAuthAt: Date.now() });

    res.redirect(storedOAuth.returnTo ?? '/');
  } catch (err) {
    log.error('Auth error:', err);
    renderError(res, 500, 'Authentication failed — please try again.', undefined);
  }
});

// ─── Logout ───────────────────────────────────────────────────────────────────
// POST-only and CSRF-protected to prevent cross-site triggered logouts.

/**
 * POST /auth/logout — destroys the current session, logging the user out.
 * @param req - Express request; requires an authenticated session.
 * @param res - Express response; always redirects to `/auth/login`.
 */
router.post('/logout', requireAuth, csrfProtection, (req, res) => {
  req.session.destroy(() => res.redirect('/auth/login'));
});

// ─── Login page ───────────────────────────────────────────────────────────────

/**
 * GET /auth/login — renders the login page.
 * @param req - Express request; checked for an existing `session.user`, and reads
 *   `req.query.error` (set by `POST /guild/select` on failure) to show a banner.
 * @param res - Express response; redirects to `/` if already logged in, otherwise
 *   renders the `login` view with the sanitized `error` code, if any.
 */
router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  renderView(res, 'login', { user: null, error: filterQueryParam(req.query.error, LOGIN_KNOWN_ERRORS) });
});

export default router;
