import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import { DbTimerCommandWithAssignments, DbUser, getAllTimerCommandsWithAssignments, getAllUsers } from '../../db';
import { csrfProtection } from '../csrf';
import { requireGuildContext, requireManager } from '../middleware';
import { renderError, filterQueryParam, renderView } from './shared';
import timersMutationsRouter from './timersMutations';
import timerAssignmentsRouter from './timerAssignments';

const log = createLogger('Web');
const router = Router();

const KNOWN_ERRORS = new Set([
  'missing_fields', 'invalid_interval', 'invalid_min_messages', 'invalid_id',
  'timer_not_found', 'add_failed', 'update_failed', 'remove_failed', 'toggle_failed',
  'assign_failed', 'unassign_failed', 'invalid_assignment_user',
]);

interface TimerViewModel extends DbTimerCommandWithAssignments {
  unassigned_users: DbUser[];
}

/**
 * GET /timers — renders the Timers admin page: the global timer-command catalog, each with
 * its list of assigned Twitch-linked streamers, plus an add form. Gated at Manager — the page
 * lists every Twitch-linked user's discord_id/discord_name/twitch_name plus every timer's
 * assignments, so authentication alone isn't enough (mutations additionally require Mod+).
 */
router.get('/timers', requireGuildContext, requireManager, csrfProtection, async (req, res) => {
  try {
    const [timers, users] = await Promise.all([
      getAllTimerCommandsWithAssignments(),
      getAllUsers(),
    ]);
    const assignableUsers = users.filter((entry) => entry.twitch_name);
    const timersForView: TimerViewModel[] = timers.map((timer) => {
      const assignedDiscordIds = new Set(timer.assigned_users.map((entry) => entry.discord_id));
      return {
        ...timer,
        unassigned_users: assignableUsers.filter((entry) => !assignedDiscordIds.has(entry.discord_id)),
      };
    });

    renderView(res, 'timers', {
      user: req.session.user,
      timers: timersForView,
      assignableUsers,
      csrfToken: req.csrfToken(),
      error: filterQueryParam(req.query.error, KNOWN_ERRORS),
    });
  } catch (err) {
    log.error('Timers page error:', err);
    renderError(res, 500, 'Failed to load timers page.', req.session.user);
  }
});

router.use(timersMutationsRouter);
router.use(timerAssignmentsRouter);

export default router;
