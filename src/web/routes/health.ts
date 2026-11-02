import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import { requireOwner } from '../middleware';
import { csrfProtection } from '../csrf';
import { getHealthSnapshot } from '../../shared/healthStore';
import {
  enableDebugLogging, disableDebugLogging, getDebugLoggingUntil, DEFAULT_DEBUG_LOGGING_HOURS, MAX_DEBUG_LOGGING_HOURS,
} from '../../shared/debugLogging';
import { renderView, renderError } from './viewHelpers';

const log = createLogger('Web');
const router = Router();

/** Durations offered by the health page's debug logging form, in hours. */
const DEBUG_LOGGING_HOUR_OPTIONS = [1, 6, DEFAULT_DEBUG_LOGGING_HOURS, MAX_DEBUG_LOGGING_HOURS];

const KNOWN_SUCCESSES = new Set(['debug_on', 'debug_off']);
const KNOWN_ERRORS = new Set(['debug_failed', 'debug_invalid']);

/**
 * Returns `value` when it is one of the page's known status codes.
 * @param value - Raw `success`/`error` query param value, in whatever type Express parsed it as.
 * @param known - The codes this page recognises.
 * @returns `value` when it is a string in `known`, else undefined.
 */
function filterKnown(value: unknown, known: Set<string>): string | undefined {
  return typeof value === 'string' && known.has(value) ? value : undefined;
}

/**
 * GET /admin/health — renders the owner-only bot health dashboard, summarizing
 * `healthStore.getHealthSnapshot()` (Discord/Twitch chat connection state, DB
 * ping, per-streamer EventSub status, stream-monitor poll status, scheduler
 * runs, and recent errors). Not guild-scoped — health isn't per-guild.
 * @param req - Express request; reads `req.session.user`.
 * @param res - Express response; renders the `health` view, or a 500 error
 *   page if building the response somehow throws.
 */
router.get('/', requireOwner, csrfProtection, (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    renderView(res, 'health', {
      user: req.session.user,
      csrfToken: req.csrfToken(),
      health: getHealthSnapshot(),
      debugLoggingUntil: getDebugLoggingUntil(),
      debugLoggingHourOptions: DEBUG_LOGGING_HOUR_OPTIONS,
      defaultDebugLoggingHours: DEFAULT_DEBUG_LOGGING_HOURS,
      success: filterKnown(req.query.success, KNOWN_SUCCESSES),
      error: filterKnown(req.query.error, KNOWN_ERRORS),
    });
  } catch (err) {
    log.error('Failed to render health dashboard:', err);
    renderError(res, 500, 'Failed to load health dashboard.', req.session.user);
  }
});

/**
 * POST /admin/health/debug-logging — switches the separate debug log file on for a chosen number
 * of hours (`action=enable`, `hours`) or off now (`action=disable`). It switches itself off when the
 * time runs out, and stays on across restarts until then (see src/shared/debugLogging.ts).
 * @param req - Express request; reads `action` and `hours` from the form body.
 * @param res - Express response; redirects back to the health page with a `success` or `error` code.
 */
router.post('/debug-logging', requireOwner, csrfProtection, async (req, res) => {
  const { action, hours } = (req.body ?? {}) as { action?: unknown; hours?: unknown };
  try {
    if (action === 'disable') {
      await disableDebugLogging();
      res.redirect('/admin/health?success=debug_off');
      return;
    }
    const parsedHours = Number(hours);
    if (action !== 'enable' || !DEBUG_LOGGING_HOUR_OPTIONS.includes(parsedHours)) {
      res.redirect('/admin/health?error=debug_invalid');
      return;
    }
    await enableDebugLogging(parsedHours);
    res.redirect('/admin/health?success=debug_on');
  } catch (err) {
    log.error('Failed to change debug logging:', err);
    res.redirect('/admin/health?error=debug_failed');
  }
});

export default router;
