import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import { AccessLevel, findUser, getAllGuilds, getEffectiveAccessLevelForUser, getGuildsForMember } from '../../db';
import { csrfProtection } from '../csrf';
import { requireAuth } from '../middleware';
import { getSessionUser } from '../session';
import { filterQueryParam, logAndRedirectError, normalizeDiscordId, renderView } from './shared';

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
 *   if any, or redirects to `/` when the user has at most one guild (single-guild
 *   users are sent straight to the dashboard).
 */
router.get('/select', requireAuth, csrfProtection, (req, res) => {
  const user = getSessionUser(req);
  if (user.guilds.length <= 1) {
    return res.redirect('/');
  }
  renderView(res, 'guildSelect', {
    user,
    guilds: user.guilds,
    csrfToken: req.csrfToken(),
    error: filterQueryParam(req.query.error, KNOWN_ERRORS),
  });
});

/**
 * Select the active guild. The requested guild ID is untrusted input: owner status and
 * membership are re-read from the database (not the session's cached `isOwner`/`guilds`,
 * which can be stale if either was revoked after login) before the guild is accepted.
 * On success the effective access level is recomputed for that guild so authorization
 * reflects the current guild, never the previous one.
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
      return res.redirect('/auth/login?error=user_not_found');
    }
    const isOwner = dbUser.is_owner;
    const liveGuilds = isOwner ? await getAllGuilds() : await getGuildsForMember(user.discordId);
    user.isOwner = isOwner;
    user.guilds = liveGuilds.map((g) => ({ guildId: g.guild_id, name: g.name }));
    if (user.guilds.length === 0) {
      user.currentGuildId = null;
      return res.redirect('/auth/login?error=no_guilds');
    }
    if (!liveGuilds.some((g) => g.guild_id === requestedGuildId)) {
      return res.redirect('/guild/select?error=guild_not_found');
    }
    const accessLevel = (await getEffectiveAccessLevelForUser(requestedGuildId, dbUser)) as (typeof AccessLevel)[keyof typeof AccessLevel];
    user.currentGuildId = requestedGuildId;
    user.accessLevel = accessLevel;
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
