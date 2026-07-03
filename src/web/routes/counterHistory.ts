import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import { getCounterHistory } from '../../db';
import { csrfProtection } from '../csrf';
import { requireAuth } from '../middleware';
import { parsePositiveIntId, renderError, renderView } from './shared';

// Split out of counters.ts to keep that file's per-file complexity down, mirroring
// the sfxCategoryMutations / sfxTriggerMutations / sfxFileMutations split.

const log = createLogger('Web');
const router = Router();

/**
 * GET /counters/:id/history — renders a counter's archived yearly-reset history
 * (open to any logged-in user, same gating as the main counters page since counter
 * values are already publicly readable via chat commands).
 * @param req - Express request; reads the `id` route param and `req.session.user`.
 * @param res - Express response; renders the `counterHistory` view, or a 404 error
 *   page if `id` is malformed or no counter exists with that id.
 */
router.get('/counters/:id/history', requireAuth, csrfProtection, async (req, res) => {
  const parsedId = parsePositiveIntId(req.params.id);
  if (parsedId === null) {
    return renderError(res, 404, 'Counter not found.', req.session.user);
  }

  try {
    const result = await getCounterHistory(parsedId);
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
