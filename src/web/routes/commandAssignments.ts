import { createLogger } from '../../shared/logger';
import {
  assignUserToCommand,
  CommandConflictError,
  isMysqlDuplicateEntryError,
  unassignUserFromCommand,
} from '../../db';
import { parsePositiveIntId } from './validation';
import { createAssignmentRouter } from './assignmentRoutes';

/**
 * `POST /commands/assign` / `POST /commands/unassign` — assigns or removes a Twitch-linked
 * Discord user's association with a custom command. See {@link createAssignmentRouter} for the
 * shared route shape; a command assignment conflict (`CommandConflictError` or a raw MySQL
 * duplicate-entry error) redirects to `?error=command_taken` instead of the generic
 * `assign_failed`.
 */
export default createAssignmentRouter({
  basePath: '/commands',
  idField: 'command_id',
  parseId: parsePositiveIntId,
  assign: assignUserToCommand,
  unassign: unassignUserFromCommand,
  mapAssignError: (err) => (
    err instanceof CommandConflictError || isMysqlDuplicateEntryError(err) ? 'command_taken' : null
  ),
  log: createLogger('Web'),
});
