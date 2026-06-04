import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import {
  DbCustomCommandWithAssignments,
  DbUser,
  getAllCustomCommandsWithAssignments,
  getAllUsers,
} from '../../db';
import { csrfProtection } from '../csrf';
import { requireAuth } from '../middleware';
import { renderError, filterQueryParam } from './shared';
import commandMutationsRouter from './commandMutations';
import commandAssignmentsRouter from './commandAssignments';

const log = createLogger('Web');
const router = Router();

const KNOWN_ERRORS = new Set([
  'missing_fields',
  'command_taken',
  'command_not_found',
  'reserved_command',
  'invalid_id',
  'add_failed',
  'update_failed',
  'remove_failed',
  'assign_failed',
  'unassign_failed',
  'invalid_assignment_user',
]);

interface CommandViewModel extends DbCustomCommandWithAssignments {
  unassigned_users: DbUser[];
}

router.get('/commands', requireAuth, csrfProtection, async (req, res) => {
  try {
    const [commands, users] = await Promise.all([
      getAllCustomCommandsWithAssignments(),
      getAllUsers(),
    ]);
    const assignableUsers = users.filter((entry) => entry.twitch_name);
    const commandsForView: CommandViewModel[] = commands.map((command) => {
      const assignedDiscordIds = new Set(command.assigned_users.map((entry) => entry.discord_id));

      return {
        ...command,
        unassigned_users: assignableUsers.filter((entry) => !assignedDiscordIds.has(entry.discord_id)),
      };
    });

    res.render('commands', {
      user: req.session.user,
      commands: commandsForView,
      assignableUsers,
      csrfToken: req.csrfToken(),
      error: filterQueryParam(req.query.error, KNOWN_ERRORS),
    });
  } catch (err) {
    log.error('Commands page error:', err);
    renderError(res, 500, 'Failed to load commands page.', req.session.user);
  }
});

router.use(commandMutationsRouter);
router.use(commandAssignmentsRouter);

export default router;
