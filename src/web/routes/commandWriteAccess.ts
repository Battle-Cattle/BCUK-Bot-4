import type { Request } from 'express';
import {
  CommandNotFoundError,
  CommandSelfServiceDeniedError,
  findUser,
  removeCustomCommand,
  removeOwnCustomCommand,
  updateCustomCommand,
  updateOwnCustomCommand,
} from '../../db';
import { normalizeRequiredText, normalizeSingleTokenRequiredText, parseCheckboxField, parseDiscordIdList } from './validation';
import { canManageCommandCatalog } from './commandPermissions';

// Which command write the session user gets: Mod+ use the unrestricted catalog writes; a streamer
// below Mod gets Twitch-only commands on their own channel, and their updates/deletes go through
// the *Own* DB writes, which re-check ownership inside the write's own transaction. Kept apart
// from commandMutations.ts so the routes only handle HTTP.

/** The add/update form's normalized trigger, output and flags. */
export interface CommandForm {
  triggerString: string;
  output: string;
  isDiscordEnabled: boolean;
  isMultiTwitch: boolean;
}

/**
 * Reads and normalizes the add/update form. The Discord and multi-Twitch flags are only honoured
 * for Mod+; a streamer's command is always Twitch-only, since both flags reach beyond their channel.
 * @param req - Express request; reads `trigger_string`, `output`, `is_discord_enabled` and
 *   `is_multi_twitch` from `req.body`.
 * @returns The form, or null when the trigger or output is missing/invalid.
 */
export function readCommandForm(req: Request): CommandForm | null {
  const { trigger_string, output } = req.body as Record<string, string | undefined>;
  const triggerString = normalizeSingleTokenRequiredText(trigger_string);
  const normalizedOutput = normalizeRequiredText(output);
  if (!triggerString || !normalizedOutput) return null;
  const isCatalogManager = canManageCommandCatalog(req);
  return {
    triggerString,
    output: normalizedOutput,
    isDiscordEnabled: isCatalogManager && parseCheckboxField(req.body.is_discord_enabled),
    isMultiTwitch: isCatalogManager && parseCheckboxField(req.body.is_multi_twitch),
  };
}

/**
 * Maps the not-found/not-yours errors a command write can throw to their redirect codes.
 * @param err - The error thrown by the write.
 * @returns `command_not_found`, `forbidden`, or null for any other error.
 */
export function commandAccessErrorCode(err: unknown): string | null {
  if (err instanceof CommandNotFoundError) return 'command_not_found';
  if (err instanceof CommandSelfServiceDeniedError) return 'forbidden';
  return null;
}

/**
 * Works out who a new command is assigned to. Mod+ pick any users via `discord_ids`; a streamer
 * below Mod always gets the command on their own channel only, which needs a linked Twitch account.
 * @param req - Express request; reads `discord_ids` and the session user.
 * @returns The Discord IDs to assign, or an `error` code (`twitch_not_linked`) to redirect with.
 */
export async function resolveNewCommandAssignees(req: Request): Promise<{ discordIds: string[] } | { error: string }> {
  if (canManageCommandCatalog(req)) {
    return { discordIds: parseDiscordIdList(req.body.discord_ids) };
  }
  const selfId = req.session.user!.discordId;
  const self = await findUser(selfId);
  if (!self?.twitch_name) return { error: 'twitch_not_linked' };
  return { discordIds: [selfId] };
}

/**
 * Updates a command as the session user: the unrestricted `updateCustomCommand` for Mod+, or the
 * owner-checked, Twitch-only `updateOwnCustomCommand` for a streamer below Mod.
 * @param req - Express request; reads the session user.
 * @param commandId - ID of the command to update.
 * @param form - The normalized form (its flags are already forced off for streamers).
 * @returns Resolves once the update completes; rejects with the DB write's error (see
 *   {@link commandAccessErrorCode}).
 */
export async function updateCommandAsSessionUser(req: Request, commandId: number, form: CommandForm): Promise<void> {
  if (canManageCommandCatalog(req)) {
    return updateCustomCommand(commandId, form.triggerString, form.output, form.isDiscordEnabled, form.isMultiTwitch);
  }
  return updateOwnCustomCommand(commandId, form.triggerString, form.output, req.session.user!.discordId);
}

/**
 * Deletes a command as the session user: the unrestricted `removeCustomCommand` for Mod+, or the
 * owner-checked `removeOwnCustomCommand` for a streamer below Mod.
 * @param req - Express request; reads the session user.
 * @param commandId - ID of the command to delete.
 * @returns Resolves once the delete completes; rejects with the DB write's error (see
 *   {@link commandAccessErrorCode}).
 */
export async function removeCommandAsSessionUser(req: Request, commandId: number): Promise<void> {
  if (canManageCommandCatalog(req)) return removeCustomCommand(commandId);
  return removeOwnCustomCommand(commandId, req.session.user!.discordId);
}
