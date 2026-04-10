import { Router } from 'express';
import {
  addCustomCommand,
  assignUserToCommand,
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
]);

router.get('/commands', requireManager, async (req, res) => {
  try {
    const [commands, users] = await Promise.all([
      getAllCustomCommandsWithAssignments(),
      getAllUsers(),
    ]);

    res.render('commands', {
      user: req.session.user,
      commands,
      assignableUsers: users.filter((entry) => entry.twitch_name),
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

  if (!trigger_string || !output) {
    return res.redirect('/admin/commands?error=missing_fields');
  }

  try {
    await addCustomCommand(trigger_string, output, isDiscordEnabled, isMultiTwitch);
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

  if (!command_id || !trigger_string || !output) {
    return res.redirect('/admin/commands?error=missing_fields');
  }

  const parsedCommandId = parseInt(command_id, 10);
  if (!Number.isInteger(parsedCommandId)) {
    return res.redirect('/admin/commands?error=invalid_id');
  }

  try {
    await updateCustomCommand(parsedCommandId, trigger_string, output, isDiscordEnabled, isMultiTwitch);
  } catch (err) {
    console.error('[Web] Update custom command error:', err);
    return res.redirect('/admin/commands?error=update_failed');
  }

  res.redirect('/admin/commands');
});

router.post('/commands/remove', requireManager, async (req, res) => {
  const { command_id } = req.body as { command_id?: string };
  if (!command_id) return res.redirect('/admin/commands');

  const parsedCommandId = parseInt(command_id, 10);
  if (!Number.isInteger(parsedCommandId)) {
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

  const parsedCommandId = parseInt(command_id, 10);
  if (!Number.isInteger(parsedCommandId)) {
    return res.redirect('/admin/commands?error=invalid_id');
  }

  try {
    await assignUserToCommand(parsedCommandId, discord_id);
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

  const parsedCommandId = parseInt(command_id, 10);
  if (!Number.isInteger(parsedCommandId)) {
    return res.redirect('/admin/commands?error=invalid_id');
  }

  try {
    await unassignUserFromCommand(parsedCommandId, discord_id);
  } catch (err) {
    console.error('[Web] Unassign user from command error:', err);
    return res.redirect('/admin/commands?error=unassign_failed');
  }

  res.redirect('/admin/commands');
});

export default router;