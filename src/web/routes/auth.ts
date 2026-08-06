import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import crypto from 'crypto';
import { DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, DISCORD_CALLBACK_URL } from '../../shared/config';
import {
  findUser,
  updateDiscordName,
  getAllGuilds,
  getGuildsForMember,
  getEffectiveAccessLevelForUser,
  createCode,
  AccessLevel,
  type DbGuild,
} from '../../db';
import { fetchMemberDisplayName } from '../../discord/discordBot';
import { csrfProtection } from '../csrf';
import { requireAuth } from '../middleware';
import { renderError, isLoopbackRedirectUri, renderView } from './shared';
import { userMutationQueue } from './adminUserMutationQueue';

const log = createLogger('Web');
const router = Router();

// ─── Redirect to Discord OAuth2 ─────────────────────────────────────────────

/**
 * GET /auth/discord — starts the Discord OAuth2 flow. Generates a CSRF state
 * token, stores it on the session with a 10-minute expiry, then redirects the
 * browser to Discord's authorize URL.
 * @param req - Express request; receives the generated `oauthState` on its session.
 * @param res - Express response; redirects to discord.com's OAuth2 authorize endpoint.
 */
router.get('/discord', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = { value: state, expiresAt: Date.now() + 10 * 60 * 1000 };

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
 * GET /auth/discord/callback — completes the Discord OAuth2 flow. Validates the
 * `state` param against the session, exchanges the `code` for an access token,
 * fetches the Discord profile, and checks the user whitelist. Then either:
 * creates/refreshes the dashboard session as usual (resolving accessible guilds,
 * syncing the display name, regenerating the session), or — if this login was
 * initiated via the companion app's loopback flow (`req.session.companionOAuth`
 * set by companionAuth.ts) — skips session creation entirely and redirects to
 * the companion app's `redirectUri` with a one-time code instead. The
 * `discord_name` sync is serialized per Discord ID through `userMutationQueue`,
 * so it can't race a concurrent admin edit or the name-refresh job on the same
 * user row.
 * @param req - Express request; reads `code`/`state` query params and the stored
 *   `oauthState` session value.
 * @param res - Express response; redirects to `/` on success, or to the
 *   companion app's `redirectUri` for the loopback flow. Renders a 400 error
 *   page when the OAuth state is invalid/missing or the companion redirectUri
 *   fails the loopback re-validation check (defense-in-depth), a 403 error page
 *   when the user is not whitelisted or has no accessible guild, or a 500 error
 *   page if any step of the exchange/profile-fetch/session-save fails.
 */
router.get('/discord/callback', async (req, res) => {
  const { code, state } = req.query as { code?: string; state?: string };

  const storedOAuth = req.session.oauthState;
  delete req.session.oauthState;
  const stateValid = !!storedOAuth && state === storedOAuth.value && Date.now() <= storedOAuth.expiresAt;
  if (!code || !state || !stateValid) {
    return renderError(res, 400, 'Invalid OAuth2 state — please try logging in again.', undefined);
  }

  try {
    // 1. Exchange code for access token
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
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
    });
    if (!tokenRes.ok) throw new Error(`Token exchange failed: ${tokenRes.status}`);
    const { access_token } = (await tokenRes.json()) as { access_token: string };

    // 2. Fetch Discord user profile
    const profileRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${access_token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!profileRes.ok) throw new Error(`Profile fetch failed: ${profileRes.status}`);
    const profile = (await profileRes.json()) as {
      id: string;
      username: string;
      avatar: string | null;
    };

    // 3. Check the user table whitelist
    const dbUser = await findUser(profile.id);
    if (!dbUser) {
      return renderError(res, 403, 'You are not on the whitelist. Contact an admin to be added.', undefined);
    }

    // 4. Resolve the guilds this user may act in. Owners get every guild; everyone
    //    else gets the guilds they have a membership row in. No accessible guild
    //    means they have not been provisioned anywhere — deny rather than show an
    //    empty panel.
    const accessibleGuilds: DbGuild[] = dbUser.is_owner
      ? await getAllGuilds()
      : await getGuildsForMember(profile.id);
    if (accessibleGuilds.length === 0) {
      return renderError(
        res,
        403,
        'You have not been added to any server yet. Contact the bot owner to be granted access.',
        undefined,
      );
    }

    // 4b. If this login was initiated by the companion app's loopback OAuth flow,
    // skip dashboard session creation entirely — hand back a one-time code via the
    // app's redirect_uri instead, which it exchanges server-side for a long-lived token.
    const companionOAuth = req.session.companionOAuth;
    if (companionOAuth && Date.now() <= companionOAuth.expiresAt) {
      delete req.session.companionOAuth;
      // Re-validate at point of use: defense-in-depth against session tampering.
      if (!isLoopbackRedirectUri(companionOAuth.redirectUri)) {
        return renderError(res, 400, 'Invalid companion redirect URI.', undefined);
      }
      const authCode = await createCode(profile.id);
      const redirectUrl = new URL(companionOAuth.redirectUri);
      redirectUrl.searchParams.set('code', authCode);
      redirectUrl.searchParams.set('state', companionOAuth.appState);
      return res.redirect(redirectUrl.toString());
    }
    delete req.session.companionOAuth;

    // Sync display name using the first accessible guild (display names are per-guild
    // in Discord; we use a best-effort lookup against one guild at login time).
    let syncedDiscordName = dbUser.discord_name?.trim() || profile.username;
    try {
      const displayName = await fetchMemberDisplayName(profile.id, accessibleGuilds[0].guild_id, true);
      const trimmedDisplayName = displayName?.trim();
      if (trimmedDisplayName) {
        syncedDiscordName = trimmedDisplayName;
      }
      if (syncedDiscordName !== dbUser.discord_name) {
        await userMutationQueue.run(profile.id, () => updateDiscordName(profile.id, syncedDiscordName));
      }
    } catch (syncErr) {
      log.warn('Non-blocking discord_name sync failed:', syncErr);
    }

    // Auto-select when there is only one choice; otherwise force the guild picker
    // by leaving currentGuildId null (accessLevel stays 0 until a guild is chosen).
    const currentGuildId = accessibleGuilds.length === 1 ? accessibleGuilds[0].guild_id : null;
    const accessLevel = currentGuildId
      ? ((await getEffectiveAccessLevelForUser(currentGuildId, dbUser)) as (typeof AccessLevel)[keyof typeof AccessLevel])
      : AccessLevel.USER;

    // 5. Save to session — regenerate the session ID first to prevent session fixation.
    const rawAvatar = profile.avatar
      ? `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.png`
      : null;
    const userData = {
      discordId: profile.id,
      discordName: syncedDiscordName,
      discordAvatar: rawAvatar?.startsWith('https://cdn.discordapp.com/') ? rawAvatar : null,
      isOwner: dbUser.is_owner,
      accessLevel,
      currentGuildId,
      guilds: accessibleGuilds.map((g) => ({ guildId: g.guild_id, name: g.name })),
    };

    await new Promise<void>((resolve, reject) => {
      req.session.regenerate((err) => {
        if (err) return reject(err);
        req.session.user = userData;
        req.session.save((saveErr) => (saveErr ? reject(saveErr) : resolve()));
      });
    });

    res.redirect('/');
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
 * @param req - Express request; checked for an existing `session.user`.
 * @param res - Express response; redirects to `/` if already logged in, otherwise
 *   renders the `login` view.
 */
router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  renderView(res, 'login', { user: null });
});

export default router;
