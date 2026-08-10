import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import { AccessLevel, findUser, getAllGuilds, getEffectiveAccessLevelForUser, getGuildsForMember, type DbGuild } from '../../db';
import { csrfProtection } from '../csrf';
import { requireAuth } from '../middleware';
import { getSessionUser } from '../session';
import { normalizeDiscordId, renderView } from './shared';

const log = createLogger('Web');
const router = Router();

// ─── Guild picker ──────────────────────────────────────────────────────────
//
// After Discord OAuth login a user may have access to more than one guild. This
// page lets them choose which one the session acts in. Single-guild users never
// reach it — requireGuildContext auto-selects their only guild.

/**
 * Renders the guild picker page for multi-guild users.
 * @param req - Express request; reads `req.session.user.guilds`.
 * @param res - Express response; renders `guildSelect`, or redirects to `/` when the user
 *   has at most one guild (single-guild users are sent straight to the dashboard).
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
  });
});

/**
 * Select the active guild. The requested guild ID is untrusted input: owner status and
 * membership are re-read from the database (not the session's cached `isOwner`/`guilds`,
 * which can be stale if either was revoked after login) before the guild is accepted.
 * On success the effective access level is recomputed for that guild so authorization
 * reflects the current guild, never the previous one.
 *
 * For a non-owner, the access level is read off the same `getGuildsForMember` result already
 * fetched to build `user.guilds` (each entry carries the user's `access_level` for that guild)
 * instead of a second `guild_member` query, mirroring `requireGuildContext` in `../middleware`.
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
    return res.redirect('/guild/select');
  }

  try {
    const dbUser = await findUser(user.discordId);
    if (!dbUser) {
      return res.redirect('/auth/login');
    }
    const isOwner = dbUser.is_owner;

    let liveGuilds: DbGuild[];
    let accessLevelByGuildId: Map<string, number> | null = null;
    if (isOwner) {
      liveGuilds = await getAllGuilds();
    } else {
      const memberships = await getGuildsForMember(user.discordId);
      liveGuilds = memberships;
      accessLevelByGuildId = new Map(memberships.map((g) => [g.guild_id, g.access_level]));
    }
    user.isOwner = isOwner;
    user.guilds = liveGuilds.map((g) => ({ guildId: g.guild_id, name: g.name }));
    if (user.guilds.length === 0) {
      user.currentGuildId = null;
      return res.redirect('/auth/login');
    }
    if (!liveGuilds.some((g) => g.guild_id === requestedGuildId)) {
      return res.redirect('/guild/select');
    }
    const accessLevel = (
      accessLevelByGuildId
        ? accessLevelByGuildId.get(requestedGuildId) ?? AccessLevel.USER
        : await getEffectiveAccessLevelForUser(requestedGuildId, dbUser)
    ) as (typeof AccessLevel)[keyof typeof AccessLevel];
    user.currentGuildId = requestedGuildId;
    user.accessLevel = accessLevel;
  } catch (err) {
    log.error('Guild select failed:', err);
    return res.redirect('/guild/select');
  }
  res.redirect('/');
});

export default router;
