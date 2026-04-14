import { Router } from 'express';
import {
  addCounter,
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
  'invalid_id',
  'add_failed',
  'update_failed',
  'remove_failed',
  'reset_failed',
]);

function isCounterNotFoundError(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith('Counter not found:');
}

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
  const { trigger_command, check_command, message, increment_message } = req.body as Record<string, string | undefined>;
  const resetYearly = req.body.reset_yearly === 'on';

  const normalizedTriggerCommand = normalizeSingleTokenRequiredText(trigger_command);
  const normalizedCheckCommand = normalizeSingleTokenRequiredText(check_command);
  const normalizedMessage = normalizeRequiredText(message);
  const normalizedIncrementMessage = normalizeRequiredText(increment_message);

  if (!normalizedTriggerCommand || !normalizedCheckCommand || !normalizedMessage || !normalizedIncrementMessage) {
    return res.redirect('/admin/counters?error=missing_fields');
  }

  if (normalizedTriggerCommand === normalizedCheckCommand) {
    return res.redirect('/admin/counters?error=same_commands');
  }

  try {
    await addCounter(
      normalizedTriggerCommand,
      normalizedCheckCommand,
      normalizedMessage,
      normalizedIncrementMessage,
      resetYearly,
    );
  } catch (err) {
    console.error('[Web] Add counter error:', err);
    return res.redirect('/admin/counters?error=add_failed');
  }

  res.redirect('/admin/counters');
});

router.post('/counters/update', requireManager, csrfProtection, async (req, res) => {
  const { id, trigger_command, check_command, message, increment_message } = req.body as Record<string, string | undefined>;
  const resetYearly = req.body.reset_yearly === 'on';

  const parsedId = parseCounterId(id);
  const normalizedTriggerCommand = normalizeSingleTokenRequiredText(trigger_command);
  const normalizedCheckCommand = normalizeSingleTokenRequiredText(check_command);
  const normalizedMessage = normalizeRequiredText(message);
  const normalizedIncrementMessage = normalizeRequiredText(increment_message);

  if (!normalizedTriggerCommand || !normalizedCheckCommand || !normalizedMessage || !normalizedIncrementMessage) {
    return res.redirect('/admin/counters?error=missing_fields');
  }

  if (normalizedTriggerCommand === normalizedCheckCommand) {
    return res.redirect('/admin/counters?error=same_commands');
  }

  if (parsedId === null) {
    return res.redirect('/admin/counters?error=invalid_id');
  }

  try {
    await updateCounter(
      parsedId,
      normalizedTriggerCommand,
      normalizedCheckCommand,
      normalizedMessage,
      normalizedIncrementMessage,
      resetYearly,
    );
  } catch (err) {
    if (isCounterNotFoundError(err)) {
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
    if (isCounterNotFoundError(err)) {
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
    if (isCounterNotFoundError(err)) {
      return res.status(404).render('error', { message: 'Counter not found.', user: req.session.user ?? null });
    }

    console.error('[Web] Reset counter error:', err);
    return res.redirect('/admin/counters?error=reset_failed');
  }

  res.redirect('/admin/counters?reset=1');
});

export default router;
