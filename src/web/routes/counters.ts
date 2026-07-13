import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import {
  addCounter,
  CounterNotFoundError,
  getAllCounters,
  isCounterCommandTaken,
  removeCounter,
  resetCounterCurrentValue,
  updateCounter,
} from '../../db';
import { csrfProtection } from '../csrf';
import { requireAuth, requireMod, requireManager } from '../middleware';
import {
  logAndRedirectError,
  normalizeRequiredText,
  normalizeSingleTokenRequiredText,
  parsePositiveIntId,
  parseCheckboxField,
  renderError,
  filterQueryParam,
  renderView,
  handleReservedOrConflictCommandError,
} from './shared';

const log = createLogger('Web');
const router = Router();

/** `handleReservedOrConflictCommandError` options scoped to the counters admin page. */
const COUNTER_WRITE_ERROR_OPTIONS = { basePath: '/counters', conflictErrorCode: 'duplicate_command' };

const KNOWN_ERRORS = new Set([
  'missing_fields',
  'same_commands',
  'duplicate_command',
  'counter_not_found',
  'reserved_command',
  'invalid_id',
  'add_failed',
  'update_failed',
  'remove_failed',
  'reset_failed',
]);

type CounterFormValidationResult =
  | {
      error: null;
      triggerCommand: string;
      checkCommand: string;
      message: string;
      incrementMessage: string;
      resetYearly: boolean;
    }
  | {
      error: 'missing_fields' | 'same_commands';
    };

function validateAndNormalizeCounterForm(
  rawForm: Record<string, string | undefined>,
): CounterFormValidationResult {
  const normalizedTriggerCommand = normalizeSingleTokenRequiredText(rawForm.trigger_command);
  const normalizedCheckCommand = normalizeSingleTokenRequiredText(rawForm.check_command);
  const normalizedMessage = normalizeRequiredText(rawForm.message);
  const normalizedIncrementMessage = normalizeRequiredText(rawForm.increment_message);
  const resetYearly = parseCheckboxField(rawForm.reset_yearly);

  if (!normalizedTriggerCommand || !normalizedCheckCommand || !normalizedMessage || !normalizedIncrementMessage) {
    return { error: 'missing_fields' };
  }

  if (normalizedTriggerCommand === normalizedCheckCommand) {
    return { error: 'same_commands' };
  }

  return {
    error: null,
    triggerCommand: normalizedTriggerCommand,
    checkCommand: normalizedCheckCommand,
    message: normalizedMessage,
    incrementMessage: normalizedIncrementMessage,
    resetYearly,
  };
}

/**
 * GET /counters — renders the counters page listing every counter.
 * @param req - Express request; reads `req.session.user`, `error`, and `reset`
 *   query params.
 * @param res - Express response; renders the `counters` view, or a 500 error page
 *   if loading counters fails.
 */
router.get('/counters', requireAuth, csrfProtection, async (req, res) => {
  try {
    const counters = await getAllCounters();

    renderView(res, 'counters', {
      user: req.session.user,
      counters,
      csrfToken: req.csrfToken(),
      error: filterQueryParam(req.query.error, KNOWN_ERRORS),
      reset: req.query.reset === '1',
    });
  } catch (err) {
    log.error('Counters page error:', err);
    renderError(res, 500, 'Failed to load counters page.', req.session.user);
  }
});

/**
 * POST /counters/add — creates a new counter with a trigger command, check command,
 * increment/check messages, and yearly-reset flag.
 * @param req - Express request; reads `trigger_command`, `check_command`, `message`,
 *   `increment_message`, and `reset_yearly` from `req.body`.
 * @param res - Express response; redirects to `/counters` on success, or to
 *   `/counters?error=<code>` for validation failures (`missing_fields`,
 *   `same_commands`, `duplicate_command`, `reserved_command`) or a DB failure
 *   (`add_failed`).
 */
router.post('/counters/add', requireMod, csrfProtection, async (req, res) => {
  const form = validateAndNormalizeCounterForm(req.body as Record<string, string | undefined>);
  if (form.error) {
    return res.redirect(`/counters?error=${form.error}`);
  }

  try {
    const hasDuplicateCommand = await isCounterCommandTaken([
      form.triggerCommand,
      form.checkCommand,
    ]);
    if (hasDuplicateCommand) {
      return res.redirect('/counters?error=duplicate_command');
    }

    await addCounter(
      form.triggerCommand,
      form.checkCommand,
      form.message,
      form.incrementMessage,
      form.resetYearly,
    );
  } catch (err) {
    if (handleReservedOrConflictCommandError(err, res, COUNTER_WRITE_ERROR_OPTIONS)) return;
    return logAndRedirectError({ res, log, logLabel: 'Add counter error:', err, basePath: '/counters', errorCode: 'add_failed' });
  }

  res.redirect('/counters');
});

/**
 * POST /counters/update — updates an existing counter's commands, messages, and
 * yearly-reset flag.
 * @param req - Express request; reads `id`, `trigger_command`, `check_command`,
 *   `message`, `increment_message`, and `reset_yearly` from `req.body`.
 * @param res - Express response; redirects to `/counters` on success, or to
 *   `/counters?error=<code>` for validation failures (`missing_fields`,
 *   `same_commands`, `invalid_id`, `duplicate_command`, `reserved_command`), if the
 *   counter no longer exists (`counter_not_found`), or the update fails
 *   (`update_failed`).
 */
router.post('/counters/update', requireMod, csrfProtection, async (req, res) => {
  const { id } = req.body as Record<string, string | undefined>;

  const parsedId = parsePositiveIntId(id);
  const form = validateAndNormalizeCounterForm(req.body as Record<string, string | undefined>);
  if (form.error) {
    return res.redirect(`/counters?error=${form.error}`);
  }

  if (parsedId === null) {
    return res.redirect('/counters?error=invalid_id');
  }

  try {
    const hasDuplicateCommand = await isCounterCommandTaken(
      [form.triggerCommand, form.checkCommand],
      parsedId,
    );
    if (hasDuplicateCommand) {
      return res.redirect('/counters?error=duplicate_command');
    }

    await updateCounter({
      id: parsedId,
      triggerCommand: form.triggerCommand,
      checkCommand: form.checkCommand,
      message: form.message,
      incrementMessage: form.incrementMessage,
      resetYearly: form.resetYearly,
    });
  } catch (err) {
    if (err instanceof CounterNotFoundError) {
      return res.redirect('/counters?error=counter_not_found');
    }
    if (handleReservedOrConflictCommandError(err, res, COUNTER_WRITE_ERROR_OPTIONS)) return;
    return logAndRedirectError({ res, log, logLabel: 'Update counter error:', err, basePath: '/counters', errorCode: 'update_failed' });
  }

  res.redirect('/counters');
});

/**
 * POST /counters/remove — deletes a counter.
 * @param req - Express request; reads `id` from `req.body`.
 * @param res - Express response; redirects to `/counters` on success, or to
 *   `/counters?error=<code>` if `id` is malformed (`invalid_id`), the counter
 *   doesn't exist (`counter_not_found`), or the delete fails (`remove_failed`).
 */
router.post('/counters/remove', requireMod, csrfProtection, async (req, res) => {
  const { id } = req.body as { id?: string };
  const parsedId = parsePositiveIntId(id);

  if (parsedId === null) {
    return res.redirect('/counters?error=invalid_id');
  }

  try {
    await removeCounter(parsedId);
  } catch (err) {
    if (err instanceof CounterNotFoundError) {
      return res.redirect('/counters?error=counter_not_found');
    }

    return logAndRedirectError({ res, log, logLabel: 'Remove counter error:', err, basePath: '/counters', errorCode: 'remove_failed' });
  }

  res.redirect('/counters');
});

/**
 * POST /counters/reset/:id — resets a counter's current value back to zero
 * (Manager+).
 * @param req - Express request; reads the `id` route param.
 * @param res - Express response; redirects to `/counters?reset=1` on success, or
 *   to `/counters?error=<code>` if `id` is malformed (`invalid_id`), the counter
 *   doesn't exist (`counter_not_found`), or the reset fails (`reset_failed`).
 */
router.post('/counters/reset/:id', requireManager, csrfProtection, async (req, res) => {
  const rawId = req.params.id;
  const parsedId = parsePositiveIntId(typeof rawId === 'string' ? rawId : undefined);
  if (parsedId === null) {
    return res.redirect('/counters?error=invalid_id');
  }

  try {
    await resetCounterCurrentValue(parsedId);
  } catch (err) {
    if (err instanceof CounterNotFoundError) {
      return res.redirect('/counters?error=counter_not_found');
    }

    return logAndRedirectError({ res, log, logLabel: 'Reset counter error:', err, basePath: '/counters', errorCode: 'reset_failed' });
  }

  res.redirect('/counters?reset=1');
});

export default router;
