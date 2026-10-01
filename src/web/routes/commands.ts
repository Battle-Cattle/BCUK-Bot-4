import { createLogger } from '../../shared/logger';
import { Router, type Request } from 'express';
import {
  DbCustomCommandWithAssignments,
  DbGuildCommandOverride,
  DbUser,
  findUser,
  getAllCustomCommandsWithAssignments,
  getAllUsers,
  getOverridesForGuild,
} from '../../db';
import { csrfProtection } from '../csrf';
import { requireGuildContext } from '../middleware';
import { filterQueryParam } from './validation';
import { renderError, renderView } from './viewHelpers';
import commandMutationsRouter from './commandMutations';
import commandAssignmentsRouter from './commandAssignments';
import commandGuildOverridesRouter from './commandGuildOverrides';
import { canManageCommandCatalog, isCommandAssignedTo, isCommandSelfManageable } from './commandPermissions';

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
  'forbidden',
  'twitch_not_linked',
]);

interface CommandViewModel extends DbCustomCommandWithAssignments {
  unassigned_users: DbUser[];
  /** Per-guild override row for the current guild, or null when at catalog default. */
  guildOverride: DbGuildCommandOverride | null;
  /** Whether the viewer may edit/delete this command (always for Mod+; own-channel-only commands for streamers). */
  canEdit: boolean;
}

/** The commands a viewer sees, plus the users they may assign to them (empty for streamers). */
interface CommandPageData {
  commands: DbCustomCommandWithAssignments[];
  assignableUsers: DbUser[];
  /** Whether a streamer below Mod has a linked Twitch account (always true for Mod+, who don't need one). */
  twitchLinked: boolean;
}

/**
 * Loads what the commands page shows. Mod+ get the whole catalog and every Twitch-linked user to
 * assign; a streamer below Mod gets only the commands on their own channel, and no user list.
 * @param req - Express request; reads the session user.
 */
async function loadCommandPageData(req: Request): Promise<CommandPageData> {
  if (canManageCommandCatalog(req)) {
    const [commands, users] = await Promise.all([getAllCustomCommandsWithAssignments(), getAllUsers()]);
    return { commands, assignableUsers: users.filter((entry) => entry.twitch_name), twitchLinked: true };
  }
  const discordId = req.session.user!.discordId;
  const [commands, self] = await Promise.all([getAllCustomCommandsWithAssignments(), findUser(discordId)]);
  return {
    commands: commands.filter((command) => isCommandAssignedTo(command, discordId)),
    assignableUsers: [],
    twitchLinked: !!self?.twitch_name,
  };
}

/**
 * Renders the commands page. Mod+ see the global custom-command catalog with each command's
 * per-guild override state; a streamer below Mod sees and self-manages only the commands on their
 * own Twitch channel.
 */
router.get('/commands', requireGuildContext, csrfProtection, async (req, res) => {
  try {
    const guildId = req.session.user?.currentGuildId ?? null;
    const isCatalogManager = canManageCommandCatalog(req);
    const discordId = req.session.user!.discordId;
    const [{ commands, assignableUsers, twitchLinked }, overrides] = await Promise.all([
      loadCommandPageData(req),
      guildId ? getOverridesForGuild(guildId) : Promise.resolve([] as DbGuildCommandOverride[]),
    ]);
    const overridesByCommandId = new Map(overrides.map((o) => [o.command_id, o]));
    const commandsForView: CommandViewModel[] = commands.map((command) => {
      const assignedDiscordIds = new Set(command.assigned_users.map((entry) => entry.discord_id));
      return {
        ...command,
        unassigned_users: assignableUsers.filter((entry) => !assignedDiscordIds.has(entry.discord_id)),
        guildOverride: overridesByCommandId.get(command.command_id) ?? null,
        canEdit: isCatalogManager || isCommandSelfManageable(command, discordId),
      };
    });

    renderView(res, 'commands', {
      user: req.session.user,
      commands: commandsForView,
      assignableUsers,
      canManageCatalog: isCatalogManager,
      twitchLinked,
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
