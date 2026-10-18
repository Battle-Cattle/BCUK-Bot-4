// Cache-invalidating wrappers for timerCommands.ts writes, re-exported by the db.ts facade.
// timerCommands.ts is a pure DB layer with no cache knowledge, so the invalidation of the
// scheduler's timer command cache lives here instead.
import {
  addTimerCommand as addTimerCommandRecord,
  updateTimerCommand as updateTimerCommandRecord,
  removeTimerCommand as removeTimerCommandRecord,
  setTimerCommandEnabled as setTimerCommandEnabledRecord,
  assignUserToTimer as assignUserToTimerRecord,
  assignUsersToTimer as assignUsersToTimerRecord,
  unassignUserFromTimer as unassignUserFromTimerRecord,
  updateOwnTimerCommand as updateOwnTimerCommandRecord,
  setOwnTimerCommandEnabled as setOwnTimerCommandEnabledRecord,
  removeOwnTimerCommand as removeOwnTimerCommandRecord,
  discardOwnNewTimerCommand as discardOwnNewTimerCommandRecord,
  type TimerCommandInput,
} from './timerCommands';
import { invalidateTimerCommandCache } from './timerCommandCache';
import { withInvalidation } from './withInvalidation';

/**
 * Creates a new timer command and invalidates the timer command cache.
 * @param input - The timer's fields.
 * @returns The new timer's primary key.
 */
export async function addTimerCommand(input: TimerCommandInput): Promise<number> {
  return withInvalidation(() => addTimerCommandRecord(input), invalidateTimerCommandCache);
}

/**
 * Updates an existing timer command's fields and invalidates the timer command cache.
 * @param id - Primary key of the `timer_command` row.
 * @param input - The timer's new fields.
 * @throws {TimerCommandNotFoundError} If no row matches `id` (the cache is left as is).
 */
export async function updateTimerCommand(id: number, input: TimerCommandInput): Promise<void> {
  await withInvalidation(() => updateTimerCommandRecord(id, input), invalidateTimerCommandCache);
}

/**
 * Deletes a timer command (and its assignments) and invalidates the timer command cache.
 * @param id - Primary key of the `timer_command` row.
 */
export async function removeTimerCommand(id: number): Promise<void> {
  await withInvalidation(() => removeTimerCommandRecord(id), invalidateTimerCommandCache);
}

/**
 * Toggles a timer command's `enabled` flag and invalidates the timer command cache.
 * @param id - Primary key of the `timer_command` row.
 * @param enabled - The new enabled state.
 * @throws {TimerCommandNotFoundError} If no row matches `id` (the cache is left as is).
 */
export async function setTimerCommandEnabled(id: number, enabled: boolean): Promise<void> {
  await withInvalidation(() => setTimerCommandEnabledRecord(id, enabled), invalidateTimerCommandCache);
}

/**
 * Assigns a user to a timer command and invalidates the timer command cache.
 * @param timerId - ID of the timer to assign the user to.
 * @param discordId - Discord snowflake of the user to assign.
 */
export async function assignUserToTimer(timerId: number, discordId: string): Promise<void> {
  await withInvalidation(() => assignUserToTimerRecord(timerId, discordId), invalidateTimerCommandCache);
}

/**
 * Assigns several users to a timer command and invalidates the timer command cache.
 * @param timerId - ID of the timer to assign the users to.
 * @param discordIds - Discord snowflakes of the users to assign.
 */
export async function assignUsersToTimer(timerId: number, discordIds: string[]): Promise<void> {
  await withInvalidation(() => assignUsersToTimerRecord(timerId, discordIds), invalidateTimerCommandCache);
}

/**
 * Removes a user's assignment from a timer command and invalidates the timer command cache.
 * @param timerId - ID of the timer to remove the assignment from.
 * @param discordId - Discord snowflake of the user to unassign.
 */
export async function unassignUserFromTimer(timerId: number, discordId: string): Promise<void> {
  await withInvalidation(() => unassignUserFromTimerRecord(timerId, discordId), invalidateTimerCommandCache);
}

/**
 * Streamer self-service update (see `updateOwnTimerCommand` in timerCommands.ts); invalidates
 * the timer command cache once it succeeds.
 * @param id - Primary key of the `timer_command` row.
 * @param input - The timer's new fields.
 * @param discordId - Discord ID of the streamer making the change.
 */
export async function updateOwnTimerCommand(id: number, input: TimerCommandInput, discordId: string): Promise<void> {
  await withInvalidation(() => updateOwnTimerCommandRecord(id, input, discordId), invalidateTimerCommandCache);
}

/**
 * Streamer self-service toggle (see `setOwnTimerCommandEnabled` in timerCommands.ts);
 * invalidates the timer command cache once it succeeds.
 * @param id - Primary key of the `timer_command` row.
 * @param enabled - The new enabled state.
 * @param discordId - Discord ID of the streamer making the change.
 */
export async function setOwnTimerCommandEnabled(id: number, enabled: boolean, discordId: string): Promise<void> {
  await withInvalidation(() => setOwnTimerCommandEnabledRecord(id, enabled, discordId), invalidateTimerCommandCache);
}

/**
 * Streamer self-service delete (see `removeOwnTimerCommand` in timerCommands.ts); invalidates
 * the timer command cache once it succeeds.
 * @param id - Primary key of the `timer_command` row.
 * @param discordId - Discord ID of the streamer making the change.
 */
export async function removeOwnTimerCommand(id: number, discordId: string): Promise<void> {
  await withInvalidation(() => removeOwnTimerCommandRecord(id, discordId), invalidateTimerCommandCache);
}

/**
 * Failed-create cleanup (see `discardOwnNewTimerCommand` in timerCommands.ts); invalidates the
 * timer command cache once it succeeds.
 * @param id - Primary key of the `timer_command` row.
 * @param discordId - Discord ID of the streamer who created it.
 */
export async function discardOwnNewTimerCommand(id: number, discordId: string): Promise<void> {
  await withInvalidation(() => discardOwnNewTimerCommandRecord(id, discordId), invalidateTimerCommandCache);
}
