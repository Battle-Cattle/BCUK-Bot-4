import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import { getEffectiveAccessLevel } from '../../db';
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

/** Render the guild picker. Users with a single guild are sent straight to the dashboard. */
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
 * Select the active guild. The requested guild ID is untrusted input: it must be
 * one the user already belongs to (their session guild list), or the request is
 * rejected. On success the effective access level is recomputed for that guild so
 * authorization reflects the current guild, never the previous one.
 */
router.post('/select', requireAuth, csrfProtection, async (req, res) => {
  const user = req.session.user!;
  const { guild_id } = req.body as { guild_id?: unknown };
  const requestedGuildId = typeof guild_id === 'string' ? normalizeDiscordId(guild_id) : null;

  if (!requestedGuildId || !user.guilds.some((g) => g.guildId === requestedGuildId)) {
    return res.redirect('/guild/select');
  }

  try {
    user.currentGuildId = requestedGuildId;
    user.accessLevel = (await getEffectiveAccessLevel(requestedGuildId, user.discordId)) as 0 | 1 | 2 | 3;
  } catch (err) {
    log.error('Guild select failed:', err);
    return res.redirect('/guild/select');
  }
  res.redirect('/');
});

export default router;
