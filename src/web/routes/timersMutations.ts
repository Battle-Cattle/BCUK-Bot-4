import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import { addTimerCommand, assignUsersToTimer, findUsersByIds } from '../../db';
import type { TimerCommandInput } from '../../db';
import { csrfProtection } from '../csrf';
import { requireGuildContext } from '../middleware';
import { normalizeRequiredText, parseCheckboxField, parsePositiveIntId } from './validation';
import { logAndRedirectError } from './errorHandling';
import {
  discardNewTimerAsSessionUser,
  removeTimerAsSessionUser,
  resolveNewTimerAssignees,
  setTimerEnabledAsSessionUser,
  timerAccessErrorCode,
  updateTimerAsSessionUser,
} from './timerWriteAccess';

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
 * linked Twitch name. On any failure, cleans the timer up via `discard` to avoid leaving it in a
 * partially-assigned state.
 * @param timerId - ID of the just-created timer.
 * @param discordIds - Discord IDs to assign (users without a Twitch name are skipped).
 * @param discard - Deletes the timer on failure (see `discardNewTimerAsSessionUser`).
 * @returns An error code, or null on success.
 */
async function assignUsersToNewTimer(
  timerId: number,
  discordIds: string[],
  discard: (timerId: number) => Promise<void>,
): Promise<string | null> {
  try {
    const users = await findUsersByIds(discordIds);
    const eligibleDiscordIds = discordIds.filter((discordId) => {
      const user = users.get(discordId);
      return !!user && !!user.twitch_name;
    });
    await assignUsersToTimer(timerId, eligibleDiscordIds);
  } catch (err) {
    try {
      await discard(timerId);
    } catch (cleanupErr) {
      log.error('Cleanup after failed timer assign error:', cleanupErr);
    }
    log.error('Assign user during timer creation error:', err);
    return 'assign_failed';
  }
  return null;
}

/**
 * POST /timers/add — creates a new timer command and assigns it. Mod+ may assign any
 * Twitch-linked Discord users (optionally none); a streamer below Mod creates a timer on their own
 * channel (`discord_ids` ignored). If any assignment fails, the just-created timer is deleted to
 * avoid a partially-assigned state.
 * @param req - Express request; reads `name`, `message`, `interval_seconds`, `min_messages`,
 *   `require_live`, `enabled`, and `discord_ids` from `req.body`.
 * @param res - Express response; redirects to `/timers` on success, or to
 *   `/timers?error=<code>` if a field is invalid (`missing_fields`, `invalid_interval`,
 *   `invalid_min_messages`), a streamer has no linked Twitch account (`twitch_not_linked`), the
 *   insert fails (`add_failed`), or an assignment fails (`assign_failed`).
 */
router.post('/timers/add', requireGuildContext, csrfProtection, async (req, res) => {
  const body = req.body as Record<string, string | string[] | undefined>;
  const result = parseTimerCommandFields(body);
  if (!result.ok) return res.redirect(`/timers?error=${result.errorCode}`);

  let timerId: number;
  let discordIds: string[];
  try {
    const assignees = await resolveNewTimerAssignees(req);
    if ('error' in assignees) return res.redirect(`/timers?error=${assignees.error}`);
    discordIds = assignees.discordIds;
    timerId = await addTimerCommand(result.input);
  } catch (err) {
    return logAndRedirectError({ res, log, logLabel: 'Add timer command error:', err, basePath: '/timers', errorCode: 'add_failed' });
  }

  const assignError = await assignUsersToNewTimer(timerId, discordIds, (id) => discardNewTimerAsSessionUser(req, id));
  if (assignError) return res.redirect(`/timers?error=${assignError}`);

  res.redirect('/timers');
});

/**
 * POST /timers/update — updates an existing timer command's fields. A streamer below Mod may only
 * update a timer assigned to them alone (see `isTimerSelfManageableBy`).
 * @param req - Express request; reads `id`, plus the same fields as `/timers/add`, from `req.body`.
 * @param res - Express response; redirects to `/timers` on success, or to
 *   `/timers?error=<code>` if `id` is malformed (`invalid_id`), a field is invalid
 *   (`missing_fields`, `invalid_interval`, `invalid_min_messages`), the timer doesn't exist
 *   (`timer_not_found`), a streamer doesn't own it outright (`forbidden`, checked inside the
 *   update's own transaction), or the update fails (`update_failed`).
 */
router.post('/timers/update', requireGuildContext, csrfProtection, async (req, res) => {
  const body = req.body as Record<string, string | string[] | undefined>;
  const id = parsePositiveIntId(body.id);
  if (id === null) return res.redirect('/timers?error=invalid_id');

  const result = parseTimerCommandFields(body);
  if (!result.ok) return res.redirect(`/timers?error=${result.errorCode}`);

  try {
    await updateTimerAsSessionUser(req, id, result.input);
  } catch (err) {
    const accessErrorCode = timerAccessErrorCode(err);
    if (accessErrorCode) return res.redirect(`/timers?error=${accessErrorCode}`);
    return logAndRedirectError({ res, log, logLabel: 'Update timer command error:', err, basePath: '/timers', errorCode: 'update_failed' });
  }

  res.redirect('/timers');
});

/**
 * POST /timers/remove — deletes a timer command and all its streamer assignments. For Mod+ this
 * no-ops (still redirects to success) if the id doesn't exist. A streamer below Mod may only delete
 * a timer assigned to them alone; for a shared one they unassign themselves via `/timers/unassign`.
 * @param req - Express request; reads `id` from `req.body`.
 * @param res - Express response; redirects to `/timers` on success, or to
 *   `/timers?error=<code>` if `id` is malformed (`invalid_id`), a streamer's timer no longer
 *   exists (`timer_not_found`) or isn't theirs alone (`forbidden`, checked inside the delete's own
 *   transaction), or the delete fails (`remove_failed`).
 */
router.post('/timers/remove', requireGuildContext, csrfProtection, async (req, res) => {
  const id = parsePositiveIntId((req.body as Record<string, string | string[] | undefined>).id);
  if (id === null) return res.redirect('/timers?error=invalid_id');

  try {
    await removeTimerAsSessionUser(req, id);
  } catch (err) {
    const accessErrorCode = timerAccessErrorCode(err);
    if (accessErrorCode) return res.redirect(`/timers?error=${accessErrorCode}`);
    return logAndRedirectError({ res, log, logLabel: 'Remove timer command error:', err, basePath: '/timers', errorCode: 'remove_failed' });
  }

  res.redirect('/timers');
});

/**
 * POST /timers/toggle — flips a timer command's `enabled` flag, for a one-click
 * enable/disable control in the timer list without opening the full edit form. A streamer below
 * Mod may only toggle a timer assigned to them alone.
 * @param req - Express request; reads `id` and `enabled` (`'true'`/`'false'`) from `req.body`.
 * @param res - Express response; redirects to `/timers` on success, or to `/timers?error=<code>`
 *   if `id` is malformed (`invalid_id`), the timer doesn't exist (`timer_not_found`), a streamer
 *   doesn't own it outright (`forbidden`), or the update fails (`toggle_failed`).
 */
router.post('/timers/toggle', requireGuildContext, csrfProtection, async (req, res) => {
  const body = req.body as Record<string, string | string[] | undefined>;
  const id = parsePositiveIntId(body.id);
  if (id === null) return res.redirect('/timers?error=invalid_id');

  try {
    await setTimerEnabledAsSessionUser(req, id, body.enabled === 'true');
  } catch (err) {
    const accessErrorCode = timerAccessErrorCode(err);
    if (accessErrorCode) return res.redirect(`/timers?error=${accessErrorCode}`);
    return logAndRedirectError({ res, log, logLabel: 'Toggle timer command error:', err, basePath: '/timers', errorCode: 'toggle_failed' });
  }

  res.redirect('/timers');
});

export default router;
