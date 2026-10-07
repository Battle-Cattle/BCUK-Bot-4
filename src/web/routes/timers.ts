import { createLogger } from '../../shared/logger';
import { Router, type Request } from 'express';
import { DbTimerCommandWithAssignments, DbUser, findUser, getAllTimerCommandsWithAssignments, getGuildMemberUsers } from '../../db';
import { csrfProtection } from '../csrf';
import { requireGuildContext } from '../middleware';
import { canManageCatalog, isAssignedTo } from './selfServiceAccess';
import { filterQueryParam } from './validation';
import { renderView } from './viewHelpers';
import { getCurrentGuildId } from '../session';
import { renderOrError } from './errorHandling';
import timersMutationsRouter from './timersMutations';
import timerAssignmentsRouter from './timerAssignments';
import { isTimerSelfManageable } from './timerPermissions';

const log = createLogger('Web');
const router = Router();

const KNOWN_ERRORS = new Set([
  'missing_fields', 'invalid_interval', 'invalid_min_messages', 'invalid_id',
  'timer_not_found', 'add_failed', 'update_failed', 'remove_failed', 'toggle_failed',
  'assign_failed', 'unassign_failed', 'invalid_assignment_user', 'assignee_not_in_guild',
  'forbidden', 'twitch_not_linked',
]);

interface TimerViewModel extends DbTimerCommandWithAssignments {
  unassigned_users: DbUser[];
  /** Whether the viewer may edit/toggle/delete this timer (always for Mod+; own-channel-only timers for streamers). */
  canEdit: boolean;
}

/** The timers a viewer sees, plus the users they may assign to them (empty for streamers). */
interface TimerPageData {
  timers: DbTimerCommandWithAssignments[];
  assignableUsers: DbUser[];
  /** Whether a streamer below Mod has a linked Twitch account (always true for Mod+, who don't need one). */
  twitchLinked: boolean;
}

/**
 * Loads what the timers page shows. Mod+ get the whole catalog and every Twitch-linked member of
 * the current guild to assign; a streamer below Mod gets only the timers on their own channel, and no user list (so
 * other users' Discord/Twitch names aren't exposed to them).
 * @param req - Express request; reads the session user.
 * @returns The timers, assignable users and Twitch-link state for the page.
 */
async function loadTimerPageData(req: Request): Promise<TimerPageData> {
  if (canManageCatalog(req)) {
    const [timers, users] = await Promise.all([getAllTimerCommandsWithAssignments(), getGuildMemberUsers(getCurrentGuildId(req))]);
    return { timers, assignableUsers: users.filter((entry) => entry.twitch_name), twitchLinked: true };
  }
  const discordId = req.session.user!.discordId;
  const [timers, self] = await Promise.all([getAllTimerCommandsWithAssignments(), findUser(discordId)]);
  return {
    timers: timers.filter((timer) => isAssignedTo(timer, discordId)),
    assignableUsers: [],
    twitchLinked: !!self?.twitch_name,
  };
}

/**
 * GET /timers — renders the Timers page. Mod+ see the global timer-command catalog, each with its
 * list of assigned Twitch-linked streamers, plus an add form that can assign any Twitch-linked
 * member of the current guild. A streamer below Mod sees and self-manages only the timers on their
 * own Twitch channel.
 * `requireGuildContext` refreshes the access level first, so a demoted session can't keep the
 * catalog view.
 */
router.get('/timers', requireGuildContext, csrfProtection, async (req, res) => {
  await renderOrError({ res, log, logLabel: 'Timers page error:', sessionUser: req.session.user, errorMessage: 'Failed to load timers page.' }, async () => {
    const isCatalogManager = canManageCatalog(req);
    const discordId = req.session.user!.discordId;
    const { timers, assignableUsers, twitchLinked } = await loadTimerPageData(req);
    const timersForView: TimerViewModel[] = timers.map((timer) => {
      const assignedDiscordIds = new Set(timer.assigned_users.map((entry) => entry.discord_id));
      return {
        ...timer,
        unassigned_users: assignableUsers.filter((entry) => !assignedDiscordIds.has(entry.discord_id)),
        canEdit: isCatalogManager || isTimerSelfManageable(timer, discordId),
      };
    });

    renderView(res, 'timers', {
      user: req.session.user,
      timers: timersForView,
      assignableUsers,
      canManageCatalog: isCatalogManager,
      twitchLinked,
      csrfToken: req.csrfToken(),
      error: filterQueryParam(req.query.error, KNOWN_ERRORS),
    });
  });
});

router.use(timersMutationsRouter);
router.use(timerAssignmentsRouter);

export default router;
