import { Router } from 'express';
import {
  addCounter,
  CounterNotFoundError,
  findCounterByCommand,
  getAllCounters,
  removeCounter,
  resetCounterCurrentValue,
  updateCounter,
} from '../../db';
import { csrfProtection } from '../csrf';
import { requireManager } from '../middleware';

const router = Router();

const KNOWN_ERRORS = new Set([
  'missing_fields',
  'same_commands',
  'duplicate_command',
  'invalid_id',
  'add_failed',
  'update_failed',
  'remove_failed',
  'reset_failed',
]);

function normalizeRequiredText(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;

  const normalizedValue = value.trim();
  return normalizedValue.length > 0 ? normalizedValue : null;
}

function normalizeSingleTokenRequiredText(value: string | undefined): string | null {
  const normalizedValue = normalizeRequiredText(value);
  if (!normalizedValue || /\s/.test(normalizedValue)) {
    return null;
  }

  return normalizedValue.toLowerCase();
}

function parseCounterId(value: string | undefined): number | null {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    return null;
  }

  const parsedValue = Number(value);
  return Number.isSafeInteger(parsedValue) && parsedValue > 0 ? parsedValue : null;
}

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

router.get('/counters', requireManager, csrfProtection, async (req, res) => {
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
    console.error('[Web] Counters page error:', err);
    res.status(500).render('error', { message: 'Failed to load counters page.', user: req.session.user ?? null });
  }
});

router.post('/counters/add', requireManager, csrfProtection, async (req, res) => {
  const form = validateAndNormalizeCounterForm(req.body as Record<string, string | undefined>);
  if (form.error) {
    return res.redirect(`/admin/counters?error=${form.error}`);
  }

  try {
    const existingTrigger = await findCounterByCommand(form.triggerCommand);
    const existingCheck = await findCounterByCommand(form.checkCommand);
    if (existingTrigger || existingCheck) {
      return res.redirect('/admin/counters?error=duplicate_command');
    }

    await addCounter(
      form.triggerCommand,
      form.checkCommand,
      form.message,
      form.incrementMessage,
      form.resetYearly,
    );
  } catch (err) {
    console.error('[Web] Add counter error:', err);
    return res.redirect('/admin/counters?error=add_failed');
  }

  res.redirect('/admin/counters');
});

router.post('/counters/update', requireManager, csrfProtection, async (req, res) => {
  const { id } = req.body as Record<string, string | undefined>;

  const parsedId = parseCounterId(id);
  const form = validateAndNormalizeCounterForm(req.body as Record<string, string | undefined>);
  if (form.error) {
    return res.redirect(`/admin/counters?error=${form.error}`);
  }

  if (parsedId === null) {
    return res.redirect('/admin/counters?error=invalid_id');
  }

  try {
    const existingTrigger = await findCounterByCommand(form.triggerCommand, parsedId);
    const existingCheck = await findCounterByCommand(form.checkCommand, parsedId);
    if (existingTrigger || existingCheck) {
      return res.redirect('/admin/counters?error=duplicate_command');
    }

    await updateCounter(
      parsedId,
      form.triggerCommand,
      form.checkCommand,
      form.message,
      form.incrementMessage,
      form.resetYearly,
    );
  } catch (err) {
    if (err instanceof CounterNotFoundError) {
      return res.status(404).render('error', { message: 'Counter not found.', user: req.session.user ?? null });
    }

    console.error('[Web] Update counter error:', err);
    return res.redirect('/admin/counters?error=update_failed');
  }

  res.redirect('/admin/counters');
});

router.post('/counters/remove', requireManager, csrfProtection, async (req, res) => {
  const { id } = req.body as { id?: string };
  const parsedId = parseCounterId(id);

  if (parsedId === null) {
    return res.redirect('/admin/counters?error=invalid_id');
  }

  try {
    await removeCounter(parsedId);
  } catch (err) {
    if (err instanceof CounterNotFoundError) {
      return res.status(404).render('error', { message: 'Counter not found.', user: req.session.user ?? null });
    }

    console.error('[Web] Remove counter error:', err);
    return res.redirect('/admin/counters?error=remove_failed');
  }

  res.redirect('/admin/counters');
});

router.post('/counters/reset/:id', requireManager, csrfProtection, async (req, res) => {
  const rawId = req.params.id;
  const parsedId = parseCounterId(typeof rawId === 'string' ? rawId : undefined);
  if (parsedId === null) {
    return res.redirect('/admin/counters?error=invalid_id');
  }

  try {
    await resetCounterCurrentValue(parsedId);
  } catch (err) {
    if (err instanceof CounterNotFoundError) {
      return res.status(404).render('error', { message: 'Counter not found.', user: req.session.user ?? null });
    }

    console.error('[Web] Reset counter error:', err);
    return res.redirect('/admin/counters?error=reset_failed');
  }

  res.redirect('/admin/counters?reset=1');
});

export default router;
