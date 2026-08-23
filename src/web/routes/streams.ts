import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import { getStreamGroupsForGuild, getStreamersForGuild, getAllEventSubStreamers, getAllUsers } from '../../db';
import { csrfProtection } from '../csrf';
import { requireManager, requireManagerJson } from '../middleware';
import { getCurrentGuildId } from '../session';
import { getLiveStates } from '../../twitch/monitor/twitchMonitor';
import { AccessLevel } from '../../db';
import { filterQueryParam } from './validation';
import { renderView, renderError } from './viewHelpers';
import { STREAMS_ERROR_CODES, STREAMS_ERROR_MESSAGES, type StreamsErrorCode } from './streamsErrors';
import groupsRouter from './streamGroups';
import streamersRouter from './streamStreamers';

const log = createLogger('Web');
const router = Router();

const KNOWN_ERRORS: ReadonlySet<StreamsErrorCode> = new Set(STREAMS_ERROR_CODES);
const KNOWN_SUCCESSES = new Set<string>([]);

export const ERROR_MESSAGES = STREAMS_ERROR_MESSAGES;

function getFriendlyError(key: string): string {
  return (ERROR_MESSAGES as Record<string, string>)[key] ?? `An error occurred (${key}).`;
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
    const guildId = getCurrentGuildId(req);
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
router.get('/streams/live', requireManagerJson, (req, res) => {
  res.json({ streams: getLiveStates(getCurrentGuildId(req)) });
});

router.use(groupsRouter);
router.use(streamersRouter);

export default router;
