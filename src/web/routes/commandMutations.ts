import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import type { Response } from 'express';
import {
  addCustomCommand,
  assignUserToCommand,
  CommandConflictError,
  CommandNotFoundError,
  isMysqlDuplicateEntryError,
  ReservedCommandError,
  findUser,
  removeCustomCommand,
  updateCustomCommand,
} from '../../db';
import { csrfProtection } from '../csrf';
import { requireMod } from '../middleware';
import {
  normalizeRequiredText,
  normalizeSingleTokenRequiredText,
  parsePositiveIntId,
  normalizeDiscordId,
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
      // Roll back the newly created command so it doesn't get stuck partially assigned.
      try { await removeCustomCommand(commandId); } catch (cleanupErr) { log.error('Cleanup after failed assign error:', cleanupErr); }
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
      return res.redirect('/commands?error=command_not_found');
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

export default router;
