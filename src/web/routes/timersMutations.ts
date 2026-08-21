import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import {
  addTimerCommand, assignUsersToTimer, findUsersByIds, removeTimerCommand, updateTimerCommand,
  setTimerCommandEnabled, TimerCommandNotFoundError,
} from '../../db';
import type { TimerCommandInput } from '../../db';
import { csrfProtection } from '../csrf';
import { requireGuildContext, requireMod } from '../middleware';
import { normalizeDiscordId, normalizeRequiredText, parseCheckboxField, parsePositiveIntId } from './validation';
import { logAndRedirectError } from './errorHandling';

const log = createLogger('Web');
const router = Router();

const MIN_INTERVAL_SECONDS = 60;
/** MySQL `INT` (4-byte signed) max — both `interval_seconds` and `min_messages` are stored in `INT` columns. */
const MAX_INT_COLUMN_VALUE = 2147483647;

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
 * Assigns Twitch-linked users to a newly created timer, filtering out any id with no
 * linked Twitch name. On any failure, deletes the timer to avoid leaving it in a
 * partially-assigned state. Returns an error code, or null on success.
 */
async function assignUsersToNewTimer(timerId: number, discordIds: string[]): Promise<string | null> {
  try {
    const users = await findUsersByIds(discordIds);
    const eligibleDiscordIds = discordIds.filter((discordId) => {
      const user = users.get(discordId);
      return !!user && !!user.twitch_name;
    });
    await assignUsersToTimer(timerId, eligibleDiscordIds);
  } catch (err) {
    try {
      await removeTimerCommand(timerId);
    } catch (cleanupErr) {
      log.error('Cleanup after failed timer assign error:', cleanupErr);
    }
    log.error('Assign user during timer creation error:', err);
    return 'assign_failed';
  }
  return null;
}

/**
 * POST /timers/add — creates a new timer command and optionally assigns it to one or more
 * Twitch-linked Discord users. If any assignment fails, the just-created timer is deleted
 * to avoid a partially-assigned state.
 * @param req - Express request; reads `name`, `message`, `interval_seconds`, `min_messages`,
 *   `require_live`, `enabled`, and `discord_ids` from `req.body`.
 * @param res - Express response; redirects to `/timers` on success, or to
 *   `/timers?error=<code>` if a field is invalid (`missing_fields`, `invalid_interval`,
 *   `invalid_min_messages`), the insert fails (`add_failed`), or an assignment fails
 *   (`assign_failed`).
 */
router.post('/timers/add', requireGuildContext, requireMod, csrfProtection, async (req, res) => {
  const body = req.body as Record<string, string | string[] | undefined>;
  const result = parseTimerCommandFields(body);
  if (!result.ok) return res.redirect(`/timers?error=${result.errorCode}`);

  let timerId: number;
  try {
    timerId = await addTimerCommand(result.input);
  } catch (err) {
    return logAndRedirectError({ res, log, logLabel: 'Add timer command error:', err, basePath: '/timers', errorCode: 'add_failed' });
  }

  const rawDiscordIds = body.discord_ids;
  const discordIds: string[] = (Array.isArray(rawDiscordIds) ? rawDiscordIds : rawDiscordIds ? [rawDiscordIds] : [])
    .map((id) => normalizeDiscordId(id))
    .filter((id): id is string => id !== null);

  const assignError = await assignUsersToNewTimer(timerId, discordIds);
  if (assignError) return res.redirect(`/timers?error=${assignError}`);

  res.redirect('/timers');
});

/**
 * POST /timers/update — updates an existing timer command's fields.
 * @param req - Express request; reads `id`, plus the same fields as `/timers/add`, from `req.body`.
 * @param res - Express response; redirects to `/timers` on success, or to
 *   `/timers?error=<code>` if `id` is malformed (`invalid_id`), a field is invalid
 *   (`missing_fields`, `invalid_interval`, `invalid_min_messages`), the timer doesn't exist
 *   (`timer_not_found`), or the update fails (`update_failed`).
 */
router.post('/timers/update', requireGuildContext, requireMod, csrfProtection, async (req, res) => {
  const body = req.body as Record<string, string | string[] | undefined>;
  const id = parsePositiveIntId(body.id);
  if (id === null) return res.redirect('/timers?error=invalid_id');

  const result = parseTimerCommandFields(body);
  if (!result.ok) return res.redirect(`/timers?error=${result.errorCode}`);

  try {
    await updateTimerCommand(id, result.input);
  } catch (err) {
    if (err instanceof TimerCommandNotFoundError) {
      return res.redirect('/timers?error=timer_not_found');
    }
    return logAndRedirectError({ res, log, logLabel: 'Update timer command error:', err, basePath: '/timers', errorCode: 'update_failed' });
  }

  res.redirect('/timers');
});

/**
 * POST /timers/remove — deletes a timer command and all its streamer assignments.
 * No-ops (still redirects to success) if the id doesn't exist.
 * @param req - Express request; reads `id` from `req.body`.
 * @param res - Express response; redirects to `/timers` on success, or to
 *   `/timers?error=<code>` if `id` is malformed (`invalid_id`) or the delete fails
 *   (`remove_failed`).
 */
router.post('/timers/remove', requireGuildContext, requireMod, csrfProtection, async (req, res) => {
  const id = parsePositiveIntId((req.body as Record<string, string | string[] | undefined>).id);
  if (id === null) return res.redirect('/timers?error=invalid_id');

  try {
    await removeTimerCommand(id);
  } catch (err) {
    return logAndRedirectError({ res, log, logLabel: 'Remove timer command error:', err, basePath: '/timers', errorCode: 'remove_failed' });
  }

  res.redirect('/timers');
});

/**
 * POST /timers/toggle — flips a timer command's `enabled` flag, for a one-click
 * enable/disable control in the timer list without opening the full edit form.
 * @param req - Express request; reads `id` and `enabled` (`'true'`/`'false'`) from `req.body`.
 * @param res - Express response; redirects to `/timers` on success, or to `/timers?error=<code>`
 *   if `id` is malformed (`invalid_id`), the timer doesn't exist (`timer_not_found`), or the
 *   update fails (`toggle_failed`).
 */
router.post('/timers/toggle', requireGuildContext, requireMod, csrfProtection, async (req, res) => {
  const body = req.body as Record<string, string | string[] | undefined>;
  const id = parsePositiveIntId(body.id);
  if (id === null) return res.redirect('/timers?error=invalid_id');

  try {
    await setTimerCommandEnabled(id, body.enabled === 'true');
  } catch (err) {
    if (err instanceof TimerCommandNotFoundError) {
      return res.redirect('/timers?error=timer_not_found');
    }
    return logAndRedirectError({ res, log, logLabel: 'Toggle timer command error:', err, basePath: '/timers', errorCode: 'toggle_failed' });
  }

  res.redirect('/timers');
});

export default router;
