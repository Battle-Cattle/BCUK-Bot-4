import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import {
  assignUserToCommand,
  CommandConflictError,
  isMysqlDuplicateEntryError,
  findUser,
  unassignUserFromCommand,
} from '../../db';
import { csrfProtection } from '../csrf';
import { requireMod } from '../middleware';
import { parsePositiveIntId, normalizeDiscordId } from './shared';

const log = createLogger('Web');
const router = Router();

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
