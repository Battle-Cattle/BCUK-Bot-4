import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import {
  DbCustomCommandWithAssignments,
  DbGuildCommandOverride,
  DbUser,
  getAllCustomCommandsWithAssignments,
  getAllUsers,
  getOverridesForGuild,
} from '../../db';
import { csrfProtection } from '../csrf';
import { requireAuth } from '../middleware';
import { renderError, filterQueryParam, renderView } from './shared';
import commandMutationsRouter from './commandMutations';
import commandAssignmentsRouter from './commandAssignments';
import commandGuildOverridesRouter from './commandGuildOverrides';

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
  'override_failed',
  'override_reset_failed',
]);

interface CommandViewModel extends DbCustomCommandWithAssignments {
  unassigned_users: DbUser[];
  /** Per-guild override row for the current guild, or null when at catalog default. */
  guildOverride: DbGuildCommandOverride | null;
}

/**
 * Renders the commands page: the global custom-command catalog plus, when a
 * guild is in session, each command's per-guild override state.
 */
router.get('/commands', requireAuth, csrfProtection, async (req, res) => {
  try {
    const guildId = req.session.user?.currentGuildId ?? null;
    const [commands, users, overrides] = await Promise.all([
      getAllCustomCommandsWithAssignments(),
      getAllUsers(),
      guildId ? getOverridesForGuild(guildId) : Promise.resolve([] as DbGuildCommandOverride[]),
    ]);
    const overridesByCommandId = new Map(overrides.map((o) => [o.command_id, o]));
    const assignableUsers = users.filter((entry) => entry.twitch_name);
    const commandsForView: CommandViewModel[] = commands.map((command) => {
      const assignedDiscordIds = new Set(command.assigned_users.map((entry) => entry.discord_id));
      return {
        ...command,
        unassigned_users: assignableUsers.filter((entry) => !assignedDiscordIds.has(entry.discord_id)),
        guildOverride: overridesByCommandId.get(command.command_id) ?? null,
      };
    });

    renderView(res, 'commands', {
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
router.use(commandGuildOverridesRouter);

export default router;
