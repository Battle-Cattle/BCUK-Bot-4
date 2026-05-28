import { createLogger } from '../../logger';
import { Router } from 'express';
import {
  addCounter,
  CommandConflictError,
  CounterNotFoundError,
  isMysqlDuplicateEntryError,
  ReservedCommandError,
  getAllCounters,
  isCounterCommandTaken,
  removeCounter,
  resetCounterCurrentValue,
  updateCounter,
} from '../../db';
import { csrfProtection } from '../csrf';
import { requireAuth, requireMod, requireManager } from '../middleware';
import {
  normalizeRequiredText,
  normalizeSingleTokenRequiredText,
  parsePositiveIntId,
  renderError,
} from './shared';

const log = createLogger('Web');
const router = Router();

const KNOWN_ERRORS = new Set([
  'missing_fields',
  'same_commands',
  'duplicate_command',
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
  const resetYearly = rawForm.reset_yearly === 'on';

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

router.get('/counters', requireAuth, csrfProtection, async (req, res) => {
  try {
    const counters = await getAllCounters();

    res.render('counters', {
      user: req.session.user,
      counters,
      csrfToken: req.csrfToken(),
      error: KNOWN_ERRORS.has(req.query.error as string) ? (req.query.error as string) : null,
      reset: req.query.reset === '1',
    });
  } catch (err) {
    log.error('Counters page error:', err);
    renderError(res, 500, 'Failed to load counters page.', req.session.user);
  }
});

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
    if (err instanceof ReservedCommandError) {
      return res.redirect('/counters?error=reserved_command');
    }

    if (err instanceof CommandConflictError || isMysqlDuplicateEntryError(err)) {
      return res.redirect('/counters?error=duplicate_command');
    }

    log.error('Add counter error:', err);
    return res.redirect('/counters?error=add_failed');
  }

  res.redirect('/counters');
});

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
      return renderError(res, 404, 'Counter not found.', req.session.user);
    }

    if (err instanceof ReservedCommandError) {
      return res.redirect('/counters?error=reserved_command');
    }

    if (err instanceof CommandConflictError || isMysqlDuplicateEntryError(err)) {
      return res.redirect('/counters?error=duplicate_command');
    }

    log.error('Update counter error:', err);
    return res.redirect('/counters?error=update_failed');
  }

  res.redirect('/counters');
});

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
      return renderError(res, 404, 'Counter not found.', req.session.user);
    }

    log.error('Remove counter error:', err);
    return res.redirect('/counters?error=remove_failed');
  }

  res.redirect('/counters');
});

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
      return renderError(res, 404, 'Counter not found.', req.session.user);
    }

    log.error('Reset counter error:', err);
    return res.redirect('/counters?error=reset_failed');
  }

  res.redirect('/counters?reset=1');
});

export default router;
