import { createLogger } from '../../shared/logger';
import { Router, type Request } from 'express';
import {
  addCustomCommand,
  assignUsersToCommand,
  CommandConflictError,
  CommandNotFoundError,
  isMysqlDuplicateEntryError,
  findUser,
  findUsersByIds,
  getCustomCommandWithAssignments,
  removeCustomCommand,
  updateCustomCommand,
} from '../../db';
import { csrfProtection } from '../csrf';
import { requireGuildContext } from '../middleware';
import { normalizeRequiredText, normalizeSingleTokenRequiredText, parsePositiveIntId, parseCheckboxField, normalizeDiscordId } from './validation';
import { logAndRedirectError, handleReservedOrConflictCommandError } from './errorHandling';
import { canManageCommandCatalog, isCommandSelfManageable } from './commandPermissions';

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

/** Parses the optional `discord_ids` multi-select (one value or many) into normalized Discord IDs, dropping malformed ones. */
function parseDiscordIdsField(rawDiscordIds: unknown): string[] {
  const values: unknown[] = Array.isArray(rawDiscordIds) ? rawDiscordIds : rawDiscordIds ? [rawDiscordIds] : [];
  return values
    .map((id) => (typeof id === 'string' ? normalizeDiscordId(id) : null))
    .filter((id): id is string => id !== null);
}

/**
 * Checks that a streamer below Mod may edit or delete a command themselves (see
 * {@link isCommandSelfManageable}).
 * @param commandId - ID of the command being changed.
 * @param discordId - Discord ID of the session user.
 * @returns `command_not_found` or `forbidden` when the change isn't allowed, or null when it is.
 */
async function getSelfServiceDenial(commandId: number, discordId: string): Promise<string | null> {
  const command = await getCustomCommandWithAssignments(commandId);
  if (!command) return 'command_not_found';
  return isCommandSelfManageable(command, discordId) ? null : 'forbidden';
}

/**
 * Works out who a new command is assigned to. Mod+ pick any users via `discord_ids`; a streamer
 * below Mod always gets the command on their own channel only, which needs a linked Twitch account.
 * @param req - Express request; reads `discord_ids` and the session user.
 * @returns The Discord IDs to assign, or an `error` code (`twitch_not_linked`) to redirect with.
 */
async function resolveNewCommandAssignees(req: Request): Promise<{ discordIds: string[] } | { error: string }> {
  if (canManageCommandCatalog(req)) {
    return { discordIds: parseDiscordIdsField(req.body.discord_ids) };
  }
  const selfId = req.session.user!.discordId;
  const self = await findUser(selfId);
  if (!self?.twitch_name) return { error: 'twitch_not_linked' };
  return { discordIds: [selfId] };
}

/**
 * POST /commands/add — creates a custom command and assigns it. Mod+ may set the Discord and
 * multi-Twitch flags and assign any Twitch-linked users; a streamer below Mod creates a
 * Twitch-only command on their own channel (flags forced off, `discord_ids` ignored). If any
 * assignment fails, the just-created command is deleted to avoid a partially-assigned state.
 * @param req - Express request; reads `trigger_string`, `output`, `is_discord_enabled`,
 *   `is_multi_twitch`, and `discord_ids` from `req.body`.
 * @param res - Express response; redirects to `/commands` on success, or to
 *   `/commands?error=<code>` if required fields are missing (`missing_fields`), a streamer has no
 *   linked Twitch account (`twitch_not_linked`), the trigger is reserved (`reserved_command`) or
 *   already taken (`command_taken`), the command insert fails (`add_failed`), or an assignment
 *   fails (`command_taken` or `assign_failed`).
 */
router.post('/commands/add', requireGuildContext, csrfProtection, async (req, res) => {
  const { trigger_string, output } = req.body as Record<string, string | undefined>;
  const isCatalogManager = canManageCommandCatalog(req);
  const isDiscordEnabled = isCatalogManager && parseCheckboxField(req.body.is_discord_enabled);
  const isMultiTwitch = isCatalogManager && parseCheckboxField(req.body.is_multi_twitch);
  const normalizedTriggerString = normalizeSingleTokenRequiredText(trigger_string);
  const normalizedOutput = normalizeRequiredText(output);

  if (!normalizedTriggerString || !normalizedOutput) {
    return res.redirect('/commands?error=missing_fields');
  }

  let commandId: number;
  let discordIds: string[];
  try {
    const assignees = await resolveNewCommandAssignees(req);
    if ('error' in assignees) return res.redirect(`/commands?error=${assignees.error}`);
    discordIds = assignees.discordIds;
    commandId = await addCustomCommand(normalizedTriggerString, normalizedOutput, isDiscordEnabled, isMultiTwitch);
  } catch (err) {
    if (handleReservedOrConflictCommandError(err, res, COMMAND_WRITE_ERROR_OPTIONS)) return;
    return logAndRedirectError({ res, log, logLabel: 'Add custom command error:', err, basePath: '/commands', errorCode: 'add_failed' });
  }

  const assignError = await assignUsersToNewCommand(commandId, discordIds);
  if (assignError) return res.redirect(`/commands?error=${assignError}`);

  res.redirect('/commands');
});

/**
 * POST /commands/update — updates an existing custom command's trigger, output,
 * and Discord/multi-Twitch flags. A streamer below Mod may only update a command they own outright
 * (see {@link isCommandSelfManageable}), and it stays Twitch-only (flags forced off).
 * @param req - Express request; reads `command_id`, `trigger_string`, `output`,
 *   `is_discord_enabled`, and `is_multi_twitch` from `req.body`.
 * @param res - Express response; redirects to `/commands` on success, or to
 *   `/commands?error=<code>` if required fields are missing (`missing_fields`),
 *   `command_id` is malformed (`invalid_id`), the command no longer exists
 *   (`command_not_found`), a streamer doesn't own it outright (`forbidden`), the trigger is
 *   reserved (`reserved_command`) or already taken (`command_taken`), or the update fails
 *   (`update_failed`).
 */
router.post('/commands/update', requireGuildContext, csrfProtection, async (req, res) => {
  const { command_id, trigger_string, output } = req.body as Record<string, string | undefined>;
  const isCatalogManager = canManageCommandCatalog(req);
  const isDiscordEnabled = isCatalogManager && parseCheckboxField(req.body.is_discord_enabled);
  const isMultiTwitch = isCatalogManager && parseCheckboxField(req.body.is_multi_twitch);
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
    const denial = isCatalogManager ? null : await getSelfServiceDenial(parsedCommandId, req.session.user!.discordId);
    if (denial) return res.redirect(`/commands?error=${denial}`);
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
 * POST /commands/remove — deletes a custom command. A streamer below Mod may only delete a command
 * they own outright (see {@link isCommandSelfManageable}); for a shared one they unassign
 * themselves via `/commands/unassign` instead.
 * @param req - Express request; reads `command_id` from `req.body`.
 * @param res - Express response; redirects to `/commands` on success or if
 *   `command_id` is absent, or to `/commands?error=<code>` if it's malformed
 *   (`invalid_id`), the command no longer exists (`command_not_found`, streamers only), a
 *   streamer doesn't own it outright (`forbidden`), or the delete fails (`remove_failed`).
 */
router.post('/commands/remove', requireGuildContext, csrfProtection, async (req, res) => {
  const { command_id } = req.body as { command_id?: string };
  if (!command_id) return res.redirect('/commands');

  const parsedCommandId = parsePositiveIntId(command_id);
  if (parsedCommandId === null) {
    return res.redirect('/commands?error=invalid_id');
  }

  try {
    const denial = canManageCommandCatalog(req) ? null : await getSelfServiceDenial(parsedCommandId, req.session.user!.discordId);
    if (denial) return res.redirect(`/commands?error=${denial}`);
    await removeCustomCommand(parsedCommandId);
  } catch (err) {
    return logAndRedirectError({ res, log, logLabel: 'Remove custom command error:', err, basePath: '/commands', errorCode: 'remove_failed' });
  }

  res.redirect('/commands');
});

export default router;
