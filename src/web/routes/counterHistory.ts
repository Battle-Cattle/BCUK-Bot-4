import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import { getCounterHistory } from '../../db';
import { csrfProtection } from '../csrf';
import { requireGuildContext } from '../middleware';
import { getCurrentGuildId } from '../session';
import { parsePositiveIntId } from './validation';
import { renderError, renderView } from './viewHelpers';

// Split out of counters.ts to keep that file's per-file complexity down, mirroring
// the sfxCategoryMutations / sfxTriggerMutations / sfxFileMutations split.

const log = createLogger('Web');
const router = Router();

/**
 * GET /counters/:id/history — renders a counter's archived yearly-reset history
 * (open to any logged-in user with the current guild selected, same gating as the
 * main counters page since counter values are already publicly readable via chat
 * commands). The counter must belong to the current guild.
 * @param req - Express request; reads the `id` route param, `req.session.user`, and
 *   the current guild from session.
 * @param res - Express response; renders the `counterHistory` view, or a 404 error
 *   page if `id` is malformed or no counter with that id exists in this guild.
 */
router.get('/counters/:id/history', requireGuildContext, csrfProtection, async (req, res) => {
  const parsedId = parsePositiveIntId(req.params.id);
  if (parsedId === null) {
    return renderError(res, 404, 'Counter not found.', req.session.user);
  }

  try {
    const result = await getCounterHistory(getCurrentGuildId(req), parsedId);
    if (!result) {
      return renderError(res, 404, 'Counter not found.', req.session.user);
    }

    renderView(res, 'counterHistory', {
      user: req.session.user,
      counter: result.counter,
      history: result.history,
      csrfToken: req.csrfToken(),
    });
  } catch (err) {
    log.error('Counter history page error:', err);
    renderError(res, 500, 'Failed to load counter history.', req.session.user);
  }
});

export default router;
