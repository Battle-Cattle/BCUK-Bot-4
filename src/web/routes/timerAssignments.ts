import { createLogger } from '../../shared/logger';
import { assignUserToTimer, unassignUserFromTimer } from '../../db';
import { parsePositiveIntId } from './validation';
import { createAssignmentRouter } from './assignmentRoutes';

/**
 * `POST /timers/assign` / `POST /timers/unassign` — assigns or removes a Twitch-linked Discord
 * user's association with a timer command. See {@link createAssignmentRouter} for the shared
 * route shape; timers have no conflict concept, so an assignment failure always falls through
 * to the generic `assign_failed` redirect.
 */
export default createAssignmentRouter({
  basePath: '/timers',
  idField: 'timer_id',
  parseId: parsePositiveIntId,
  assign: assignUserToTimer,
  unassign: unassignUserFromTimer,
  log: createLogger('Web'),
});
