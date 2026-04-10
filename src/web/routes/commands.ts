import { Router } from 'express';
import {
  addCustomCommand,
  assignUserToCommand,
  DbCustomCommandWithAssignments,
  DbUser,
  findUser,
  getAllCustomCommandsWithAssignments,
  getAllUsers,
  removeCustomCommand,
  unassignUserFromCommand,
  updateCustomCommand,
} from '../../db';
import { requireManager } from '../middleware';

const router = Router();

const KNOWN_ERRORS = new Set([
  'missing_fields',
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

function normalizeRequiredText(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;

  const normalizedValue = value.trim();
  return normalizedValue.length > 0 ? normalizedValue : null;
}

function parseCommandId(value: string | undefined): number | null {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    return null;
  }

  const parsedValue = Number(value);
  return Number.isSafeInteger(parsedValue) ? parsedValue : null;
}

function normalizeDiscordId(value: string | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmedValue = value.trim();
  return /^\d+$/.test(trimmedValue) ? trimmedValue : null;
}

router.get('/commands', requireManager, async (req, res) => {
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
      error: KNOWN_ERRORS.has(req.query.error as string) ? (req.query.error as string) : null,
    });
  } catch (err) {
    console.error('[Web] Commands page error:', err);
    res.status(500).render('error', { message: 'Failed to load commands page.', user: req.session.user ?? null });
  }
});

router.post('/commands/add', requireManager, async (req, res) => {
  const { trigger_string, output } = req.body as Record<string, string | undefined>;
  const isDiscordEnabled = req.body.is_discord_enabled === 'on';
  const isMultiTwitch = req.body.is_multi_twitch === 'on';
  const normalizedTriggerString = normalizeRequiredText(trigger_string);
  const normalizedOutput = normalizeRequiredText(output);

  if (!normalizedTriggerString || !normalizedOutput) {
    return res.redirect('/admin/commands?error=missing_fields');
  }

  try {
    await addCustomCommand(normalizedTriggerString, normalizedOutput, isDiscordEnabled, isMultiTwitch);
  } catch (err) {
    console.error('[Web] Add custom command error:', err);
    return res.redirect('/admin/commands?error=add_failed');
  }

  res.redirect('/admin/commands');
});

router.post('/commands/update', requireManager, async (req, res) => {
  const { command_id, trigger_string, output } = req.body as Record<string, string | undefined>;
  const isDiscordEnabled = req.body.is_discord_enabled === 'on';
  const isMultiTwitch = req.body.is_multi_twitch === 'on';
  const normalizedTriggerString = normalizeRequiredText(trigger_string);
  const normalizedOutput = normalizeRequiredText(output);
  const parsedCommandId = parseCommandId(command_id);

  if (!normalizedTriggerString || !normalizedOutput) {
    return res.redirect('/admin/commands?error=missing_fields');
  }

  if (parsedCommandId === null) {
    return res.redirect('/admin/commands?error=invalid_id');
  }

  try {
    await updateCustomCommand(parsedCommandId, normalizedTriggerString, normalizedOutput, isDiscordEnabled, isMultiTwitch);
  } catch (err) {
    console.error('[Web] Update custom command error:', err);
    return res.redirect('/admin/commands?error=update_failed');
  }

  res.redirect('/admin/commands');
});

router.post('/commands/remove', requireManager, async (req, res) => {
  const { command_id } = req.body as { command_id?: string };
  if (!command_id) return res.redirect('/admin/commands');

  const parsedCommandId = parseCommandId(command_id);
  if (parsedCommandId === null) {
    return res.redirect('/admin/commands?error=invalid_id');
  }

  try {
    await removeCustomCommand(parsedCommandId);
  } catch (err) {
    console.error('[Web] Remove custom command error:', err);
    return res.redirect('/admin/commands?error=remove_failed');
  }

  res.redirect('/admin/commands');
});

router.post('/commands/assign', requireManager, async (req, res) => {
  const { command_id, discord_id } = req.body as { command_id?: string; discord_id?: string };
  if (!command_id || !discord_id) {
    return res.redirect('/admin/commands?error=missing_fields');
  }

  const parsedCommandId = parseCommandId(command_id);
  const normalizedDiscordId = normalizeDiscordId(discord_id);

  if (parsedCommandId === null || normalizedDiscordId === null) {
    return res.redirect('/admin/commands?error=invalid_id');
  }

  try {
    const user = await findUser(normalizedDiscordId);
    if (!user || !user.twitch_name) {
      return res.redirect('/admin/commands?error=invalid_assignment_user');
    }

    await assignUserToCommand(parsedCommandId, normalizedDiscordId);
  } catch (err) {
    console.error('[Web] Assign user to command error:', err);
    return res.redirect('/admin/commands?error=assign_failed');
  }

  res.redirect('/admin/commands');
});

router.post('/commands/unassign', requireManager, async (req, res) => {
  const { command_id, discord_id } = req.body as { command_id?: string; discord_id?: string };
  if (!command_id || !discord_id) {
    return res.redirect('/admin/commands?error=missing_fields');
  }

  const parsedCommandId = parseCommandId(command_id);
  const normalizedDiscordId = normalizeDiscordId(discord_id);

  if (parsedCommandId === null || normalizedDiscordId === null) {
    return res.redirect('/admin/commands?error=invalid_id');
  }

  try {
    const user = await findUser(normalizedDiscordId);
    if (!user || !user.twitch_name) {
      return res.redirect('/admin/commands?error=invalid_assignment_user');
    }

    await unassignUserFromCommand(parsedCommandId, normalizedDiscordId);
  } catch (err) {
    console.error('[Web] Unassign user from command error:', err);
    return res.redirect('/admin/commands?error=unassign_failed');
  }

  res.redirect('/admin/commands');
});

export default router;