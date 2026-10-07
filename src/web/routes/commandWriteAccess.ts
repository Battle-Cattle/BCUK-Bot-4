import type { Request } from 'express';
import {
  CommandNotFoundError,
  CommandSelfServiceDeniedError,
  discardOwnNewCustomCommand,
  removeCustomCommand,
  removeOwnCustomCommand,
  updateCustomCommand,
  updateOwnCustomCommand,
} from '../../db';
import { canManageCatalog } from './selfServiceAccess';
import { normalizeRequiredText, normalizeSingleTokenRequiredText, parseCheckboxField } from './validation';

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
  const isCatalogManager = canManageCatalog(req);
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
 * Updates a command as the session user: the unrestricted `updateCustomCommand` for Mod+, or the
 * owner-checked, Twitch-only `updateOwnCustomCommand` for a streamer below Mod.
 * @param req - Express request; reads the session user.
 * @param commandId - ID of the command to update.
 * @param form - The normalized form (its flags are already forced off for streamers).
 * @returns Resolves once the update completes; rejects with the DB write's error (see
 *   {@link commandAccessErrorCode}).
 */
export async function updateCommandAsSessionUser(req: Request, commandId: number, form: CommandForm): Promise<void> {
  if (canManageCatalog(req)) {
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
  if (canManageCatalog(req)) return removeCustomCommand(commandId);
  return removeOwnCustomCommand(commandId, req.session.user!.discordId);
}

/**
 * Cleans up a just-created command whose assignment failed, as the session user: the unrestricted
 * `removeCustomCommand` for Mod+, or `discardOwnNewCustomCommand` for a streamer below Mod, which
 * leaves the command alone if a Mod adopted it in the meantime.
 * @param req - Express request; reads the session user.
 * @param commandId - ID of the command to discard.
 * @returns Resolves once the cleanup completes; rejects if it fails or is denied.
 */
export async function discardNewCommandAsSessionUser(req: Request, commandId: number): Promise<void> {
  if (canManageCatalog(req)) return removeCustomCommand(commandId);
  return discardOwnNewCustomCommand(commandId, req.session.user!.discordId);
}
