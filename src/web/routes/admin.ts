import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import { getGuildMemberUsers, ACCESS_LEVEL_LABELS } from '../../db';
import { csrfProtection } from '../csrf';
import { requireManager } from '../middleware';
import { getCurrentGuildId } from '../session';
import { filterQueryParam } from './validation';
import { renderView } from './viewHelpers';
import { renderOrError } from './errorHandling';
import adminRefreshRouter from './adminRefresh';
import { router as adminUsersMutationsRouter } from './adminUsersMutations';
import { getRefreshState } from '../../discord/guildRefreshState';

const log = createLogger('Web');
const router = Router();
router.use(adminRefreshRouter);

// The `?error=` codes the page shows: those the member-mutation routes in adminUsersMutations.ts
// redirect with.
const KNOWN_ERRORS = new Set([
  'add_failed', 'duplicate_twitch_name', 'db_busy', 'update_failed', 'remove_failed', 'toggle_failed',
  'invalid_discord_id', 'invalid_access_level', 'access_level_too_high', 'invalid_twitch_name',
  'self_edit_forbidden', 'self_remove_forbidden', 'target_above_level', 'invalid_twitch_state',
]);

// View the current guild's members (Manager+)

/**
 * GET /admin/users — renders the member-management page for the current guild,
 * listing every member with their access level and Twitch state.
 * @param req - Express request; reads `getCurrentGuildId(req)` and the
 *   `error` query param.
 * @param res - Express response; renders the `admin` view, or a 500 error page if
 *   loading members fails.
 */
router.get('/users', requireManager, csrfProtection, async (req, res) => {
  const guildId = getCurrentGuildId(req);
  await renderOrError({ res, log, logLabel: 'Admin users error:', sessionUser: req.session.user, errorMessage: 'Failed to load users.' }, async () => {
    const users = await getGuildMemberUsers(guildId);
    renderView(res, 'admin', {
      user: req.session.user,
      users,
      csrfToken: req.csrfToken(),
      accessLevelLabels: ACCESS_LEVEL_LABELS,
      error: filterQueryParam(req.query.error, KNOWN_ERRORS),
      refreshState: getRefreshState(guildId),
    });
  });
});

router.use(adminUsersMutationsRouter);

export default router;
