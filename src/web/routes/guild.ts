import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import { findUser } from '../../db';
import { csrfProtection } from '../csrf';
import { requireAuth } from '../middleware';
import { getSessionUser } from '../session';
import { filterQueryParam, normalizeDiscordId } from './validation';
import { renderView } from './viewHelpers';
import { logAndRedirectError } from './errorHandling';
import { fetchLiveGuildsForUser, resolveAccessLevelForGuild } from '../guildAccess';

const log = createLogger('Web');
const router = Router();

/** Error codes `GET /guild/select` accepts via `?error=`, all originating from `POST /guild/select`. */
const KNOWN_ERRORS = new Set(['invalid_guild', 'guild_not_found', 'select_failed']);

// ─── Guild picker ──────────────────────────────────────────────────────────
//
// After Discord OAuth login a user may have access to more than one guild. This
// page lets them choose which one the session acts in. Single-guild users never
// reach it — requireGuildContext auto-selects their only guild.

/**
 * Renders the guild picker page for multi-guild users.
 * @param req - Express request; reads `req.session.user.guilds` and `req.query.error`
 *   (set by `POST /guild/select` on failure) to show a banner.
 * @param res - Express response; renders `guildSelect` with the sanitized `error` code
 *   if any, or redirects to `/` when the user has at most one guild and no error is
 *   present (single-guild users are normally sent straight to the dashboard, but a
 *   `guild_not_found`/`select_failed` error must still be shown even if the live-guild
 *   refresh in `POST /guild/select` left the session with only one guild).
 */
router.get('/select', requireAuth, csrfProtection, (req, res) => {
  const user = getSessionUser(req);
  const error = filterQueryParam(req.query.error, KNOWN_ERRORS);
  if (user.guilds.length <= 1 && !error) {
    return res.redirect('/');
  }
  renderView(res, 'guildSelect', {
    user,
    guilds: user.guilds,
    csrfToken: req.csrfToken(),
    error,
  });
});

/**
 * Select the active guild. The requested guild ID is untrusted input: owner status and
 * membership are re-read from the database (not the session's cached `isOwner`/`guilds`,
 * which can be stale if either was revoked after login) before the guild is accepted.
 * On success the effective access level is recomputed for that guild so authorization
 * reflects the current guild, never the previous one.
 *
 * Guild fetching and access-level resolution are shared with `requireGuildContext`
 * (`../middleware`) via `fetchLiveGuildsForUser`/`resolveAccessLevelForGuild` (`../guildAccess`).
 *
 * When the session's user no longer exists in the DB or has no accessible guilds, the session
 * is destroyed (not just partially cleared) before redirecting to `/auth/login` — otherwise
 * `GET /auth/login` would see a still-populated `session.user` and bounce straight to `/`
 * without ever rendering the error.
 *
 * @param req - Express request; reads `req.session.user` and the `guild_id` form field.
 * @param res - Express response; redirects to `/` on success, or back to `/guild/select` /
 *   `/auth/login` when the selection can't be accepted.
 * @returns Resolves once the redirect has been issued.
 */
router.post('/select', requireAuth, csrfProtection, async (req, res) => {
  const user = getSessionUser(req);
  const { guild_id } = req.body as { guild_id?: unknown };
  const requestedGuildId = typeof guild_id === 'string' ? normalizeDiscordId(guild_id) : null;

  if (!requestedGuildId) {
    return res.redirect('/guild/select?error=invalid_guild');
  }

  try {
    const dbUser = await findUser(user.discordId);
    if (!dbUser) {
      // The session's user no longer exists in the DB — destroy the session so GET
      // /auth/login doesn't see a still-populated session.user and bounce straight
      // back to `/` before the error banner ever renders.
      return req.session.destroy(() => res.redirect('/auth/login?error=user_not_found'));
    }
    const { guilds: liveGuilds, accessLevelByGuildId } = await fetchLiveGuildsForUser(dbUser);
    user.isOwner = dbUser.is_owner;
    user.guilds = liveGuilds.map((g) => ({ guildId: g.guild_id, name: g.name }));
    if (user.guilds.length === 0) {
      // Same reasoning as above: destroy the session rather than just clearing
      // currentGuildId, so the login page's error banner actually reaches the user.
      return req.session.destroy(() => res.redirect('/auth/login?error=no_guilds'));
    }
    if (!liveGuilds.some((g) => g.guild_id === requestedGuildId)) {
      return res.redirect('/guild/select?error=guild_not_found');
    }
    user.currentGuildId = requestedGuildId;
    user.accessLevel = await resolveAccessLevelForGuild(dbUser, requestedGuildId, accessLevelByGuildId);
  } catch (err) {
    return logAndRedirectError({
      res,
      log,
      logLabel: 'Guild select failed:',
      err,
      basePath: '/guild/select',
      errorCode: 'select_failed',
    });
  }
  res.redirect('/');
});

export default router;
