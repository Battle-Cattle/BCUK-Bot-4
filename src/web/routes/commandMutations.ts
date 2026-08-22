import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import {
  addCustomCommand,
  assignUsersToCommand,
  CommandConflictError,
  CommandNotFoundError,
  isMysqlDuplicateEntryError,
  findUsersByIds,
  removeCustomCommand,
  updateCustomCommand,
} from '../../db';
import { csrfProtection } from '../csrf';
import { requireGuildContext, requireMod } from '../middleware';
import { normalizeRequiredText, normalizeSingleTokenRequiredText, parsePositiveIntId, parseCheckboxField, normalizeDiscordId } from './validation';
import { logAndRedirectError, handleReservedOrConflictCommandError } from './errorHandling';

const log = createLogger('Web');
const router = Router();

/** `handleReservedOrConflictCommandError` options scoped to the commands admin page. */
const COMMAND_WRITE_ERROR_OPTIONS = { basePath: '/commands', conflictErrorCode: 'command_taken' };

/** Assigns users to a newly created command.  On any failure, deletes the command
 *  to avoid leaving it in a partially-assigned state.  Returns an error code, or
 *  null on success. */
async function assignUsersToNewCommand(commandId: number, discordIds: string[]): Promise<string | null> {
  try {
    const users = await findUsersByIds(discordIds);
    const eligibleDiscordIds = discordIds.filter((discordId) => {
      const user = users.get(discordId);
      return !!user && !!user.twitch_name;
    });
    await assignUsersToCommand(commandId, eligibleDiscordIds);
  } catch (err) {
    try {
      await removeCustomCommand(commandId);
    } catch (cleanupErr) {
      log.error('Cleanup after failed assign error:', cleanupErr);
    }
    if (err instanceof CommandConflictError || isMysqlDuplicateEntryError(err)) return 'command_taken';
    log.error('Assign user during command creation error:', err);
    return 'assign_failed';
  }
  return null;
}

/**
 * POST /commands/add — creates a custom command and optionally assigns it to one or
 * more Twitch-linked Discord users. If any assignment fails, the just-created command
 * is deleted to avoid a partially-assigned state.
 * @param req - Express request; reads `trigger_string`, `output`, `is_discord_enabled`,
 *   `is_multi_twitch`, and `discord_ids` from `req.body`.
 * @param res - Express response; redirects to `/commands` on success, or to
 *   `/commands?error=<code>` if required fields are missing (`missing_fields`), the
 *   trigger is reserved (`reserved_command`) or already taken (`command_taken`), the
 *   command insert fails (`add_failed`), or an assignment fails (`command_taken` or
 *   `assign_failed`).
 */
router.post('/commands/add', requireGuildContext, requireMod, csrfProtection, async (req, res) => {
  const { trigger_string, output } = req.body as Record<string, string | undefined>;
  const isDiscordEnabled = parseCheckboxField(req.body.is_discord_enabled);
  const isMultiTwitch = parseCheckboxField(req.body.is_multi_twitch);
  const normalizedTriggerString = normalizeSingleTokenRequiredText(trigger_string);
  const normalizedOutput = normalizeRequiredText(output);

  if (!normalizedTriggerString || !normalizedOutput) {
    return res.redirect('/commands?error=missing_fields');
  }

  let commandId: number;
  try {
    commandId = await addCustomCommand(normalizedTriggerString, normalizedOutput, isDiscordEnabled, isMultiTwitch);
  } catch (err) {
    if (handleReservedOrConflictCommandError(err, res, COMMAND_WRITE_ERROR_OPTIONS)) return;
    return logAndRedirectError({ res, log, logLabel: 'Add custom command error:', err, basePath: '/commands', errorCode: 'add_failed' });
  }

  const rawDiscordIds = req.body.discord_ids;
  const discordIds: string[] = (Array.isArray(rawDiscordIds) ? rawDiscordIds : rawDiscordIds ? [rawDiscordIds] : [])
    .map((id: string) => normalizeDiscordId(id))
    .filter((id): id is string => id !== null);

  const assignError = await assignUsersToNewCommand(commandId, discordIds);
  if (assignError) return res.redirect(`/commands?error=${assignError}`);

  res.redirect('/commands');
});

/**
 * POST /commands/update — updates an existing custom command's trigger, output,
 * and Discord/multi-Twitch flags.
 * @param req - Express request; reads `command_id`, `trigger_string`, `output`,
 *   `is_discord_enabled`, and `is_multi_twitch` from `req.body`.
 * @param res - Express response; redirects to `/commands` on success, or to
 *   `/commands?error=<code>` if required fields are missing (`missing_fields`),
 *   `command_id` is malformed (`invalid_id`), the command no longer exists
 *   (`command_not_found`), the trigger is reserved (`reserved_command`) or already
 *   taken (`command_taken`), or the update fails (`update_failed`).
 */
router.post('/commands/update', requireGuildContext, requireMod, csrfProtection, async (req, res) => {
  const { command_id, trigger_string, output } = req.body as Record<string, string | undefined>;
  const isDiscordEnabled = parseCheckboxField(req.body.is_discord_enabled);
  const isMultiTwitch = parseCheckboxField(req.body.is_multi_twitch);
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
    if (handleReservedOrConflictCommandError(err, res, COMMAND_WRITE_ERROR_OPTIONS)) return;
    return logAndRedirectError({ res, log, logLabel: 'Update custom command error:', err, basePath: '/commands', errorCode: 'update_failed' });
  }

  res.redirect('/commands');
});

/**
 * POST /commands/remove — deletes a custom command.
 * @param req - Express request; reads `command_id` from `req.body`.
 * @param res - Express response; redirects to `/commands` on success or if
 *   `command_id` is absent, or to `/commands?error=<code>` if it's malformed
 *   (`invalid_id`) or the delete fails (`remove_failed`).
 */
router.post('/commands/remove', requireGuildContext, requireMod, csrfProtection, async (req, res) => {
  const { command_id } = req.body as { command_id?: string };
  if (!command_id) return res.redirect('/commands');

  const parsedCommandId = parsePositiveIntId(command_id);
  if (parsedCommandId === null) {
    return res.redirect('/commands?error=invalid_id');
  }

  try {
    await removeCustomCommand(parsedCommandId);
  } catch (err) {
    return logAndRedirectError({ res, log, logLabel: 'Remove custom command error:', err, basePath: '/commands', errorCode: 'remove_failed' });
  }

  res.redirect('/commands');
});

export default router;
