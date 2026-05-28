import { createLogger } from '../../logger';
import { Router } from 'express';
import type { Response } from 'express';
import {
  addCustomCommand,
  assignUserToCommand,
  CommandConflictError,
  CommandNotFoundError,
  DbCustomCommandWithAssignments,
  isMysqlDuplicateEntryError,
  ReservedCommandError,
  DbUser,
  findUser,
  getAllCustomCommandsWithAssignments,
  getAllUsers,
  removeCustomCommand,
  unassignUserFromCommand,
  updateCustomCommand,
} from '../../db';
import { csrfProtection } from '../csrf';
import { requireAuth, requireMod } from '../middleware';
import {
  normalizeRequiredText,
  normalizeSingleTokenRequiredText,
  parsePositiveIntId,
  normalizeDiscordId,
  renderError,
} from './shared';

const log = createLogger('Web');
const router = Router();

function handleCommandWriteError(err: unknown, res: Response): boolean {
  if (err instanceof ReservedCommandError) {
    res.redirect('/commands?error=reserved_command');
    return true;
  }
  if (err instanceof CommandConflictError || isMysqlDuplicateEntryError(err)) {
    res.redirect('/commands?error=command_taken');
    return true;
  }
  return false;
}

const KNOWN_ERRORS = new Set([
  'missing_fields',
  'command_taken',
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
      error: KNOWN_ERRORS.has(req.query.error as string) ? (req.query.error as string) : null,
    });
  } catch (err) {
    log.error('Commands page error:', err);
    renderError(res, 500, 'Failed to load commands page.', req.session.user);
  }
});

router.post('/commands/add', requireMod, csrfProtection, async (req, res) => {
  const { trigger_string, output } = req.body as Record<string, string | undefined>;
  const isDiscordEnabled = req.body.is_discord_enabled === 'on';
  const isMultiTwitch = req.body.is_multi_twitch === 'on';
  const normalizedTriggerString = normalizeSingleTokenRequiredText(trigger_string);
  const normalizedOutput = normalizeRequiredText(output);

  if (!normalizedTriggerString || !normalizedOutput) {
    return res.redirect('/commands?error=missing_fields');
  }

  let commandId: number;
  try {
    commandId = await addCustomCommand(normalizedTriggerString, normalizedOutput, isDiscordEnabled, isMultiTwitch);
  } catch (err) {
    if (handleCommandWriteError(err, res)) return;
    log.error('Add custom command error:', err);
    return res.redirect('/commands?error=add_failed');
  }

  const rawDiscordIds = req.body.discord_ids;
  const discordIds: string[] = (Array.isArray(rawDiscordIds) ? rawDiscordIds : rawDiscordIds ? [rawDiscordIds] : [])
    .map((id: string) => normalizeDiscordId(id))
    .filter((id): id is string => id !== null);

  for (const discordId of discordIds) {
    try {
      const user = await findUser(discordId);
      if (!user || !user.twitch_name) continue;
      await assignUserToCommand(commandId, discordId);
    } catch (err) {
      if (err instanceof CommandConflictError || isMysqlDuplicateEntryError(err)) {
        return res.redirect('/commands?error=command_taken');
      }
      log.error('Assign user during command creation error:', err);
      return res.redirect('/commands?error=assign_failed');
    }
  }

  res.redirect('/commands');
});

router.post('/commands/update', requireMod, csrfProtection, async (req, res) => {
  const { command_id, trigger_string, output } = req.body as Record<string, string | undefined>;
  const isDiscordEnabled = req.body.is_discord_enabled === 'on';
  const isMultiTwitch = req.body.is_multi_twitch === 'on';
  const normalizedTriggerString = normalizeSingleTokenRequiredText(trigger_string);
  const normalizedOutput = normalizeRequiredText(output);
  const parsedCommandId = parsePositiveIntId(command_id);

  if (!normalizedTriggerString || !normalizedOutput) {
    return res.redirect('/commands?error=missing_fields');
  }

  if (parsedCommandId === null) {
    return res.redirect('/commands?error=invalid_id');
  }

  try {
    await updateCustomCommand(parsedCommandId, normalizedTriggerString, normalizedOutput, isDiscordEnabled, isMultiTwitch);
  } catch (err) {
    if (err instanceof CommandNotFoundError) {
      return renderError(res, 404, 'Command not found.', req.session.user);
    }
    if (handleCommandWriteError(err, res)) return;
    log.error('Update custom command error:', err);
    return res.redirect('/commands?error=update_failed');
  }

  res.redirect('/commands');
});

router.post('/commands/remove', requireMod, csrfProtection, async (req, res) => {
  const { command_id } = req.body as { command_id?: string };
  if (!command_id) return res.redirect('/commands');

  const parsedCommandId = parsePositiveIntId(command_id);
  if (parsedCommandId === null) {
    return res.redirect('/commands?error=invalid_id');
  }

  try {
    await removeCustomCommand(parsedCommandId);
  } catch (err) {
    log.error('Remove custom command error:', err);
    return res.redirect('/commands?error=remove_failed');
  }

  res.redirect('/commands');
});

router.post('/commands/assign', requireMod, csrfProtection, async (req, res) => {
  const { command_id, discord_id } = req.body as { command_id?: string; discord_id?: string };
  if (!command_id || !discord_id) {
    return res.redirect('/commands?error=missing_fields');
  }

  const parsedCommandId = parsePositiveIntId(command_id);
  const normalizedDiscordId = normalizeDiscordId(discord_id);

  if (parsedCommandId === null || normalizedDiscordId === null) {
    return res.redirect('/commands?error=invalid_id');
  }

  try {
    const user = await findUser(normalizedDiscordId);
    if (!user || !user.twitch_name) {
      return res.redirect('/commands?error=invalid_assignment_user');
    }

    await assignUserToCommand(parsedCommandId, normalizedDiscordId);
  } catch (err) {
    if (err instanceof CommandConflictError || isMysqlDuplicateEntryError(err)) {
      return res.redirect('/commands?error=command_taken');
    }

    log.error('Assign user to command error:', err);
    return res.redirect('/commands?error=assign_failed');
  }

  res.redirect('/commands');
});

router.post('/commands/unassign', requireMod, csrfProtection, async (req, res) => {
  const { command_id, discord_id } = req.body as { command_id?: string; discord_id?: string };
  if (!command_id || !discord_id) {
    return res.redirect('/commands?error=missing_fields');
  }

  const parsedCommandId = parsePositiveIntId(command_id);
  const normalizedDiscordId = normalizeDiscordId(discord_id);

  if (parsedCommandId === null || normalizedDiscordId === null) {
    return res.redirect('/commands?error=invalid_id');
  }

  try {
    await unassignUserFromCommand(parsedCommandId, normalizedDiscordId);
  } catch (err) {
    log.error('Unassign user from command error:', err);
    return res.redirect('/commands?error=unassign_failed');
  }

  res.redirect('/commands');
});

export default router;