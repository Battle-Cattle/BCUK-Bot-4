import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import { AccessLevel, findUser, getAllGuilds, getEffectiveAccessLevel, getGuildsForMember } from '../../db';
import { csrfProtection } from '../csrf';
import { requireAuth } from '../middleware';
import { normalizeDiscordId } from './shared';

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
  const user = req.session.user!;
  if (user.guilds.length <= 1) {
    return res.redirect('/');
  }
  res.render('guildSelect', {
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
 */
router.post('/select', requireAuth, csrfProtection, async (req, res) => {
  const user = req.session.user!;
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
    const liveGuilds = isOwner ? await getAllGuilds() : await getGuildsForMember(user.discordId);
    user.isOwner = isOwner;
    user.guilds = liveGuilds.map((g) => ({ guildId: g.guild_id, name: g.name }));
    if (user.guilds.length === 0) {
      user.currentGuildId = null;
      return res.redirect('/auth/login');
    }
    if (!liveGuilds.some((g) => g.guild_id === requestedGuildId)) {
      return res.redirect('/guild/select');
    }
    const accessLevel = (await getEffectiveAccessLevel(requestedGuildId, user.discordId)) as (typeof AccessLevel)[keyof typeof AccessLevel];
    user.currentGuildId = requestedGuildId;
    user.accessLevel = accessLevel;
  } catch (err) {
    log.error('Guild select failed:', err);
    return res.redirect('/guild/select');
  }
  res.redirect('/');
});

export default router;
