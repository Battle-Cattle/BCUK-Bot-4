import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import {
  addTimerCommand, updateTimerCommand, removeTimerCommand, setTimerCommandEnabled,
  TimerCommandNotFoundError,
} from '../../db';
import type { TimerCommandInput } from '../../db';
import { csrfProtection } from '../csrf';
import { requireAuth } from '../middleware';
import {
  logAndRedirectError, normalizeRequiredText, parseCheckboxField, parsePositiveIntId,
  requireStreamer,
} from './shared';

const log = createLogger('Web');
const router = Router();

/** Redirect target used when the requester isn't a streamer, scoped to the timers admin page. */
const NOT_A_STREAMER_REDIRECT = '/timers?error=not_a_streamer';

const MIN_INTERVAL_SECONDS = 60;

/**
 * Parses a required interval-seconds form field: an integer of at least
 * {@link MIN_INTERVAL_SECONDS}, matching the DB's `chk_timer_command_interval` check —
 * validated here so a bad value redirects with a clear `invalid_interval` code instead of
 * surfacing as an opaque DB constraint failure.
 */
function parseIntervalSecondsField(value: string | string[] | undefined): number | null {
  if (Array.isArray(value)) return null;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= MIN_INTERVAL_SECONDS ? parsed : null;
}

/**
 * Parses a required min-messages form field: a non-negative integer, matching the DB's
 * `chk_timer_command_min_messages` check. `0` (the "no minimum" value) is valid.
 */
function parseMinMessagesField(value: string | string[] | undefined): number | null {
  if (Array.isArray(value)) return null;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

/** Parses and validates the timer fields shared by the add and update forms. Returns `null` if any field is invalid. */
function parseTimerCommandFields(body: Record<string, string | string[] | undefined>): TimerCommandInput | null {
  const name = normalizeRequiredText(body.name as string | undefined);
  const message = normalizeRequiredText(body.message as string | undefined);
  if (!name || !message) return null;

  const intervalSeconds = parseIntervalSecondsField(body.interval_seconds);
  if (intervalSeconds === null) return null;

  const minMessages = parseMinMessagesField(body.min_messages);
  if (minMessages === null) return null;

  return {
    name,
    message,
    intervalSeconds,
    minMessages,
    requireLive: parseCheckboxField(body.require_live),
    enabled: parseCheckboxField(body.enabled),
  };
}

/**
 * POST /timers/add — creates a new timer command for the requesting streamer.
 * @param req - Express request; reads `name`, `message`, `interval_seconds`, `min_messages`,
 *   `require_live`, `enabled` from `req.body`.
 * @param res - Express response; redirects to `/timers?success=timer_added` on success, or to
 *   `/timers?error=<code>` if the requester isn't a streamer (`not_a_streamer`), a field is
 *   invalid (`missing_fields`, `invalid_interval`, `invalid_min_messages`), or the insert fails
 *   (`add_failed`).
 */
router.post('/add', requireAuth, csrfProtection, async (req, res) => {
  try {
    const streamer = await requireStreamer(req, res, NOT_A_STREAMER_REDIRECT);
    if (!streamer) return;

    const body = req.body as Record<string, string | string[] | undefined>;
    const input = parseTimerCommandFields(body);
    if (!input) return res.redirect('/timers?error=missing_fields');

    await addTimerCommand(streamer.id, input);
    res.redirect('/timers?success=timer_added');
  } catch (err) {
    logAndRedirectError({ res, log, logLabel: 'Add timer command error:', err, basePath: '/timers', errorCode: 'add_failed' });
  }
});

/**
 * POST /timers/update — updates an existing timer command belonging to the requesting streamer.
 * @param req - Express request; reads `id`, plus the same fields as `/timers/add`, from `req.body`.
 * @param res - Express response; redirects to `/timers?success=timer_updated` on success, or to
 *   `/timers?error=<code>` if the requester isn't a streamer (`not_a_streamer`), `id` is
 *   malformed (`invalid_id`), a field is invalid (`missing_fields`), the timer doesn't exist or
 *   belongs to another streamer (`timer_not_found`), or the update fails (`update_failed`).
 */
router.post('/update', requireAuth, csrfProtection, async (req, res) => {
  try {
    const streamer = await requireStreamer(req, res, NOT_A_STREAMER_REDIRECT);
    if (!streamer) return;

    const body = req.body as Record<string, string | string[] | undefined>;
    const id = parsePositiveIntId(body.id);
    if (id === null) return res.redirect('/timers?error=invalid_id');

    const input = parseTimerCommandFields(body);
    if (!input) return res.redirect('/timers?error=missing_fields');

    await updateTimerCommand(id, streamer.id, input);
    res.redirect('/timers?success=timer_updated');
  } catch (err) {
    if (err instanceof TimerCommandNotFoundError) {
      return res.redirect('/timers?error=timer_not_found');
    }
    logAndRedirectError({ res, log, logLabel: 'Update timer command error:', err, basePath: '/timers', errorCode: 'update_failed' });
  }
});

/**
 * POST /timers/remove — deletes a timer command belonging to the requesting streamer.
 * No-ops (still redirects to success) if the id doesn't exist or belongs to another streamer.
 * @param req - Express request; reads `id` from `req.body`.
 * @param res - Express response; redirects to `/timers?success=timer_removed` on success, or to
 *   `/timers?error=<code>` if the requester isn't a streamer (`not_a_streamer`), `id` is
 *   malformed (`invalid_id`), or the delete fails (`remove_failed`).
 */
router.post('/remove', requireAuth, csrfProtection, async (req, res) => {
  try {
    const streamer = await requireStreamer(req, res, NOT_A_STREAMER_REDIRECT);
    if (!streamer) return;

    const id = parsePositiveIntId((req.body as Record<string, string | string[] | undefined>).id);
    if (id === null) return res.redirect('/timers?error=invalid_id');

    await removeTimerCommand(id, streamer.id);
    res.redirect('/timers?success=timer_removed');
  } catch (err) {
    logAndRedirectError({ res, log, logLabel: 'Remove timer command error:', err, basePath: '/timers', errorCode: 'remove_failed' });
  }
});

/**
 * POST /timers/toggle — flips a timer command's `enabled` flag, for a one-click
 * enable/disable control in the timer list without opening the full edit form.
 * @param req - Express request; reads `id` and `enabled` (`'true'`/`'false'`) from `req.body`.
 * @param res - Express response; redirects to `/timers` on success, or to `/timers?error=<code>`
 *   if the requester isn't a streamer (`not_a_streamer`), `id` is malformed (`invalid_id`), the
 *   timer doesn't exist or belongs to another streamer (`timer_not_found`), or the update fails
 *   (`toggle_failed`).
 */
router.post('/toggle', requireAuth, csrfProtection, async (req, res) => {
  try {
    const streamer = await requireStreamer(req, res, NOT_A_STREAMER_REDIRECT);
    if (!streamer) return;

    const body = req.body as Record<string, string | string[] | undefined>;
    const id = parsePositiveIntId(body.id);
    if (id === null) return res.redirect('/timers?error=invalid_id');

    await setTimerCommandEnabled(id, streamer.id, body.enabled === 'true');
    res.redirect('/timers');
  } catch (err) {
    if (err instanceof TimerCommandNotFoundError) {
      return res.redirect('/timers?error=timer_not_found');
    }
    logAndRedirectError({ res, log, logLabel: 'Toggle timer command error:', err, basePath: '/timers', errorCode: 'toggle_failed' });
  }
});

export default router;
