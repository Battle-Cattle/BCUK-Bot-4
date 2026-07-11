import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import { getStreamGroupsForGuild, getStreamersForGuild, getAllEventSubStreamers, getAllUsers } from '../../db';
import { csrfProtection } from '../csrf';
import { requireManager } from '../middleware';
import { getLiveStates } from '../../twitch/monitor/twitchMonitor';
import { AccessLevel } from '../../db';
import { filterQueryParam, renderView, renderError } from './shared';
import groupsRouter from './streamGroups';
import streamersRouter from './streamStreamers';

const log = createLogger('Web');
const router = Router();

const KNOWN_ERRORS = new Set([
  'missing_fields', 'invalid_id',
  'add_group_failed', 'update_group_failed', 'remove_group_failed',
  'add_streamer_failed', 'remove_streamer_failed',
  'eventsub_disconnect_failed',
]);
const KNOWN_SUCCESSES = new Set<string>([]);

export const ERROR_MESSAGES: Record<string, string> = {
  missing_fields:             'All required fields must be filled in.',
  invalid_id:                 'Invalid ID — please try again.',
  add_group_failed:           'Failed to add stream group. Please try again.',
  update_group_failed:        'Failed to update stream group. Please try again.',
  remove_group_failed:        'Failed to remove stream group. Please try again.',
  add_streamer_failed:        'Failed to add streamer. Please try again.',
  remove_streamer_failed:     'Failed to remove streamer. Please try again.',
  eventsub_disconnect_failed: 'Failed to disconnect Twitch account. Please try again.',
};

function getFriendlyError(key: string): string {
  return ERROR_MESSAGES[key] ?? `An error occurred (${key}).`;
}

// ─── View ─────────────────────────────────────────────────────────────────────

/**
 * GET /streams — renders the streams page with the session's current guild's
 * stream groups, streamers, and (admin only) EventSub status per streamer.
 * @param req - Express request; reads `req.session.user` (including
 *   `currentGuildId`), `error`, and `success` query params.
 * @param res - Express response; renders the `streams` view, or a 500 error page
 *   if loading streams data fails.
 */
router.get('/streams', requireManager, csrfProtection, async (req, res) => {
  try {
    const isAdmin = (req.session.user?.accessLevel ?? 0) >= AccessLevel.ADMIN;
    const guildId = req.session.user!.currentGuildId!;
    const [groups, streamers, eventSubStreamers, allUsers] = await Promise.all([
      getStreamGroupsForGuild(guildId),
      getStreamersForGuild(guildId),
      isAdmin ? getAllEventSubStreamers() : Promise.resolve([]),
      getAllUsers(),
    ]);

    // EventSub status keyed by streamer row id — admin only
    const eventSubById: Record<number, (typeof eventSubStreamers)[0]> = {};
    for (const s of eventSubStreamers) eventSubById[s.id] = s;

    // Users eligible to be added as streamers: have a Twitch name, not already a streamer
    const existingStreamerIds = new Set(streamers.map((s) => s.discord_id));
    const eligibleUsers = allUsers.filter(
      (u) => u.twitch_name && !existingStreamerIds.has(u.discord_id),
    );

    renderView(res, 'streams', {
      user: req.session.user,
      groups,
      streamers,
      isAdmin,
      eventSubById,
      eligibleUsers,
      csrfToken: req.csrfToken(),
      error:   filterQueryParam(req.query.error,   KNOWN_ERRORS),
      success: filterQueryParam(req.query.success, KNOWN_SUCCESSES),
      getFriendlyError,
    });
  } catch (err) {
    log.error('Streams page error:', err);
    renderError(res, 500, 'Failed to load streams page.', req.session.user);
  }
});

// ─── Live state snapshot ──────────────────────────────────────────────────────

/**
 * GET /streams/live — JSON snapshot of current live states for the session's
 * current guild, polled by the streams page frontend.
 * @param req - Express request; reads `req.session.user.currentGuildId`.
 * @param res - Express response; returns `{ streams }` from `getLiveStates(guildId)`.
 */
router.get('/streams/live', requireManager, (req, res) => {
  res.json({ streams: getLiveStates(req.session.user!.currentGuildId!) });
});

router.use(groupsRouter);
router.use(streamersRouter);

export default router;
