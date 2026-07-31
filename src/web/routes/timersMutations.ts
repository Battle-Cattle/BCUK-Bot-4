import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import {
  addTimerCommand, countTimerCommandsForStreamer, updateTimerCommand, removeTimerCommand,
  setTimerCommandEnabled, TimerCommandNotFoundError,
} from '../../db';
import type { TimerCommandInput } from '../../db';
import { csrfProtection } from '../csrf';
import { requireAuth } from '../middleware';
import { createMutationQueue } from '../../shared/mutationQueue';
import {
  logAndRedirectError, normalizeRequiredText, parseCheckboxField, parsePositiveIntId,
  requireStreamer,
} from './shared';

const log = createLogger('Web');
const router = Router();

/**
 * Serializes the per-streamer timer count check and insert in `POST /timers/add` (keyed by
 * streamer id), so two concurrent requests for the same streamer can't both read a count under
 * {@link MAX_TIMER_COMMANDS_PER_STREAMER} and each insert, letting the cap be exceeded.
 */
const timerAddQueue = createMutationQueue<number>();

/** Redirect target used when the requester isn't a streamer, scoped to the timers admin page. */
const NOT_A_STREAMER_REDIRECT = '/timers?error=not_a_streamer';

const MIN_INTERVAL_SECONDS = 60;
/** MySQL `INT` (4-byte signed) max — both `interval_seconds` and `min_messages` are stored in `INT` columns. */
const MAX_INT_COLUMN_VALUE = 2147483647;
/**
 * Per-streamer cap on the number of timer commands, enforced in `/timers/add`. Every enabled
 * timer across every streamer is processed on every ~15s scheduler tick, so this bounds that
 * per-tick work rather than letting one streamer's rows (accidental duplicates, or a scripted
 * client) grow it unboundedly.
 */
const MAX_TIMER_COMMANDS_PER_STREAMER = 20;

/**
 * Parses a required numeric form field: an integer within `[min, max]`. Shared by both
 * `interval_seconds` (matching the DB's `chk_timer_command_interval` check, `min` =
 * {@link MIN_INTERVAL_SECONDS}) and `min_messages` (matching `chk_timer_command_min_messages`,
 * `min` = 0, since "no minimum" is valid) — validated here so a bad value redirects with a
 * clear error code instead of surfacing as an opaque DB constraint/range failure.
 */
function parseIntFieldInRange(value: string | string[] | undefined, min: number, max: number): number | null {
  if (Array.isArray(value)) return null;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

/** Result of validating the timer fields shared by the add and update forms — either the parsed input, or the specific error code to redirect with. */
type TimerFieldsResult =
  | { ok: true; input: TimerCommandInput }
  | { ok: false; errorCode: 'missing_fields' | 'invalid_interval' | 'invalid_min_messages' };

/** Parses and validates the timer fields shared by the add and update forms, reporting which field failed. */
function parseTimerCommandFields(body: Record<string, string | string[] | undefined>): TimerFieldsResult {
  const name = normalizeRequiredText(body.name as string | undefined);
  const message = normalizeRequiredText(body.message as string | undefined);
  if (!name || !message) return { ok: false, errorCode: 'missing_fields' };

  const intervalSeconds = parseIntFieldInRange(body.interval_seconds, MIN_INTERVAL_SECONDS, MAX_INT_COLUMN_VALUE);
  if (intervalSeconds === null) return { ok: false, errorCode: 'invalid_interval' };

  const minMessages = parseIntFieldInRange(body.min_messages, 0, MAX_INT_COLUMN_VALUE);
  if (minMessages === null) return { ok: false, errorCode: 'invalid_min_messages' };

  return {
    ok: true,
    input: {
      name,
      message,
      intervalSeconds,
      minMessages,
      requireLive: parseCheckboxField(body.require_live),
      enabled: parseCheckboxField(body.enabled),
    },
  };
}

/**
 * POST /timers/add — creates a new timer command for the requesting streamer. The count check
 * and insert are serialized per streamer through {@link timerAddQueue} so two concurrent
 * requests can't both observe a count under the cap and each insert, exceeding it.
 * @param req - Express request; reads `name`, `message`, `interval_seconds`, `min_messages`,
 *   `require_live`, `enabled` from `req.body`.
 * @param res - Express response; redirects to `/timers?success=timer_added` on success, or to
 *   `/timers?error=<code>` if the requester isn't a streamer (`not_a_streamer`), a field is
 *   invalid (`missing_fields`, `invalid_interval`, `invalid_min_messages`), the streamer has
 *   already reached {@link MAX_TIMER_COMMANDS_PER_STREAMER} timers (`timer_limit_reached`), or
 *   the count check or insert fails (`add_failed`).
 */
router.post('/add', requireAuth, csrfProtection, async (req, res) => {
  try {
    const streamer = await requireStreamer(req, res, NOT_A_STREAMER_REDIRECT);
    if (!streamer) return;

    const body = req.body as Record<string, string | string[] | undefined>;
    const result = parseTimerCommandFields(body);
    if (!result.ok) return res.redirect(`/timers?error=${result.errorCode}`);

    const added = await timerAddQueue.run(streamer.id, async () => {
      const existingCount = await countTimerCommandsForStreamer(streamer.id);
      if (existingCount >= MAX_TIMER_COMMANDS_PER_STREAMER) return false;
      await addTimerCommand(streamer.id, result.input);
      return true;
    });
    if (!added) return res.redirect('/timers?error=timer_limit_reached');
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
 *   malformed (`invalid_id`), a field is invalid (`missing_fields`, `invalid_interval`,
 *   `invalid_min_messages`), the timer doesn't exist or belongs to another streamer
 *   (`timer_not_found`), or the update fails (`update_failed`).
 */
router.post('/update', requireAuth, csrfProtection, async (req, res) => {
  try {
    const streamer = await requireStreamer(req, res, NOT_A_STREAMER_REDIRECT);
    if (!streamer) return;

    const body = req.body as Record<string, string | string[] | undefined>;
    const id = parsePositiveIntId(body.id);
    if (id === null) return res.redirect('/timers?error=invalid_id');

    const result = parseTimerCommandFields(body);
    if (!result.ok) return res.redirect(`/timers?error=${result.errorCode}`);

    await updateTimerCommand(id, streamer.id, result.input);
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
