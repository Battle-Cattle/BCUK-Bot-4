import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import { assignUserToTimer, findUser, unassignUserFromTimer } from '../../db';
import { csrfProtection } from '../csrf';
import { requireMod } from '../middleware';
import { parsePositiveIntId, normalizeDiscordId, logAndRedirectError } from './shared';

const log = createLogger('Web');
const router = Router();

/**
 * POST /timers/assign — assigns a Twitch-linked Discord user to a timer command's channel list.
 * @param req - Express request; reads `timer_id` and `discord_id` from `req.body`.
 * @param res - Express response; redirects to `/timers` on success, or to
 *   `/timers?error=<code>` if fields are missing (`missing_fields`), IDs are
 *   malformed (`invalid_id`), the user doesn't exist or has no linked Twitch name
 *   (`invalid_assignment_user`), or the assignment write fails (`assign_failed`).
 */
router.post('/timers/assign', requireMod, csrfProtection, async (req, res) => {
  const { timer_id, discord_id } = req.body as { timer_id?: string; discord_id?: string };
  if (!timer_id || !discord_id) {
    return res.redirect('/timers?error=missing_fields');
  }

  const parsedTimerId = parsePositiveIntId(timer_id);
  const normalizedDiscordId = normalizeDiscordId(discord_id);

  if (parsedTimerId === null || normalizedDiscordId === null) {
    return res.redirect('/timers?error=invalid_id');
  }

  try {
    const user = await findUser(normalizedDiscordId);
    if (!user || !user.twitch_name) {
      return res.redirect('/timers?error=invalid_assignment_user');
    }

    await assignUserToTimer(parsedTimerId, normalizedDiscordId);
  } catch (err) {
    return logAndRedirectError({
      res, log, logLabel: 'Assign user to timer error:', err, basePath: '/timers', errorCode: 'assign_failed',
    });
  }

  res.redirect('/timers');
});

/**
 * POST /timers/unassign — removes a user's assignment from a timer command.
 * @param req - Express request; reads `timer_id` and `discord_id` from `req.body`.
 * @param res - Express response; redirects to `/timers` on success, or to
 *   `/timers?error=<code>` if fields are missing (`missing_fields`), IDs are
 *   malformed (`invalid_id`), or the unassign write fails (`unassign_failed`).
 */
router.post('/timers/unassign', requireMod, csrfProtection, async (req, res) => {
  const { timer_id, discord_id } = req.body as { timer_id?: string; discord_id?: string };
  if (!timer_id || !discord_id) {
    return res.redirect('/timers?error=missing_fields');
  }

  const parsedTimerId = parsePositiveIntId(timer_id);
  const normalizedDiscordId = normalizeDiscordId(discord_id);

  if (parsedTimerId === null || normalizedDiscordId === null) {
    return res.redirect('/timers?error=invalid_id');
  }

  try {
    await unassignUserFromTimer(parsedTimerId, normalizedDiscordId);
  } catch (err) {
    return logAndRedirectError({
      res, log, logLabel: 'Unassign user from timer error:', err, basePath: '/timers', errorCode: 'unassign_failed',
    });
  }

  res.redirect('/timers');
});

export default router;
