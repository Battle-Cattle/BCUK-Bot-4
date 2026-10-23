import type { Request } from 'express';
import {
  discardOwnNewTimerCommand,
  removeOwnTimerCommand,
  removeTimerCommand,
  setOwnTimerCommandEnabled,
  setTimerCommandEnabled,
  TimerCommandNotFoundError,
  TimerSelfServiceDeniedError,
  updateOwnTimerCommand,
  updateTimerCommand,
  type TimerCommandInput,
} from '../../db';
import { accessErrorCode, dispatchByAccess } from './selfServiceAccess';

// Which timer write the session user gets: Mod+ use the unrestricted catalog writes; a streamer
// below Mod gets timers on their own channel only, and their updates/toggles/deletes go through the
// *Own* DB writes, which re-check ownership inside the write's own transaction. Kept apart from
// timersMutations.ts so the routes only handle HTTP.

/**
 * Maps the not-found/not-yours errors a timer write can throw to their redirect codes.
 * @param err - The error thrown by the write.
 * @returns `timer_not_found`, `forbidden`, or null for any other error.
 */
export function timerAccessErrorCode(err: unknown): string | null {
  return accessErrorCode(err, TimerCommandNotFoundError, 'timer_not_found', TimerSelfServiceDeniedError);
}

/**
 * Updates a timer as the session user: the unrestricted `updateTimerCommand` for Mod+, or the
 * owner-checked `updateOwnTimerCommand` for a streamer below Mod.
 * @param req - Express request; reads the session user.
 * @param timerId - ID of the timer to update.
 * @param input - The timer's new fields.
 * @returns Resolves once the update completes; rejects with the DB write's error (see
 *   {@link timerAccessErrorCode}).
 */
export function updateTimerAsSessionUser(req: Request, timerId: number, input: TimerCommandInput): Promise<void> {
  return dispatchByAccess(req, () => updateTimerCommand(timerId, input), (discordId) => updateOwnTimerCommand(timerId, input, discordId));
}

/**
 * Enables/disables a timer as the session user: the unrestricted `setTimerCommandEnabled` for
 * Mod+, or the owner-checked `setOwnTimerCommandEnabled` for a streamer below Mod.
 * @param req - Express request; reads the session user.
 * @param timerId - ID of the timer to toggle.
 * @param enabled - The new enabled state.
 * @returns Resolves once the update completes; rejects with the DB write's error (see
 *   {@link timerAccessErrorCode}).
 */
export function setTimerEnabledAsSessionUser(req: Request, timerId: number, enabled: boolean): Promise<void> {
  return dispatchByAccess(
    req,
    () => setTimerCommandEnabled(timerId, enabled),
    (discordId) => setOwnTimerCommandEnabled(timerId, enabled, discordId),
  );
}

/**
 * Deletes a timer as the session user: the unrestricted `removeTimerCommand` for Mod+, or the
 * owner-checked `removeOwnTimerCommand` for a streamer below Mod.
 * @param req - Express request; reads the session user.
 * @param timerId - ID of the timer to delete.
 * @returns Resolves once the delete completes; rejects with the DB write's error (see
 *   {@link timerAccessErrorCode}).
 */
export function removeTimerAsSessionUser(req: Request, timerId: number): Promise<void> {
  return dispatchByAccess(req, () => removeTimerCommand(timerId), (discordId) => removeOwnTimerCommand(timerId, discordId));
}

/**
 * Cleans up a just-created timer whose assignment failed, as the session user: the unrestricted
 * `removeTimerCommand` for Mod+, or `discardOwnNewTimerCommand` for a streamer below Mod, which
 * leaves the timer alone if a Mod adopted it in the meantime.
 * @param req - Express request; reads the session user.
 * @param timerId - ID of the timer to discard.
 * @returns Resolves once the cleanup completes; rejects if it fails or is denied.
 */
export function discardNewTimerAsSessionUser(req: Request, timerId: number): Promise<void> {
  return dispatchByAccess(req, () => removeTimerCommand(timerId), (discordId) => discardOwnNewTimerCommand(timerId, discordId));
}
