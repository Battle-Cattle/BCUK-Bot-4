import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import {
  getStreamGroupsForGuild,
  addStreamGroup,
  updateStreamGroup,
  removeStreamGroup,
  getStreamersForGuild,
  addStreamer,
  removeStreamer,
  removeStreamersByGroup,
  getAllEventSubStreamers,
  getAllUsers,
  findUser,
} from '../../db';
import { csrfProtection } from '../csrf';
import { requireManager } from '../middleware';
import { restartTwitchMonitor, getLiveStates } from '../../twitch/monitor/twitchMonitor';
import { AccessLevel } from '../../db';
import { logAndRedirectError, parsePositiveIntId, filterQueryParam, normalizeDiscordId, renderView, renderError } from './shared';

const log = createLogger('Web');
const router = Router();

function hasMissingValues(...values: Array<string | undefined>): boolean {
  return values.some((value) => typeof value !== 'string' || value.trim().length === 0);
}

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
 * GET /streams — renders the streams page with stream groups, streamers, and
 * (admin only) EventSub status per streamer.
 * @param req - Express request; reads `req.session.user`, `error`, and `success`
 *   query params.
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
 * GET /streams/live — JSON snapshot of current live states, polled by the
 * streams page frontend.
 * @param _req - Express request (unused).
 * @param res - Express response; returns `{ streams }` from `getLiveStates()`.
 */
router.get('/streams/live', requireManager, (_req, res) => {
  res.json({ streams: getLiveStates() });
});

// ─── Groups ───────────────────────────────────────────────────────────────────

/**
 * POST /streams/groups/add — creates a new stream group (Discord channel, live
 * and new-game messages, multi-twitch/delete-old-posts flags) and restarts the
 * Twitch monitor.
 * @param req - Express request; reads `name`, `discord_channel`, `live_message`,
 *   `new_game_message`, `multi_twitch`, and `delete_old_posts` from `req.body`.
 * @param res - Express response; redirects to `/admin/streams` on success, or to
 *   `/admin/streams?error=<code>` for missing fields (`missing_fields`) or a DB
 *   failure (`add_group_failed`).
 */
router.post('/streams/groups/add', requireManager, csrfProtection, async (req, res) => {
  const { name, discord_channel, live_message, new_game_message } = req.body as Record<string, string | undefined>;
  const multi_twitch = req.body.multi_twitch === 'on';
  const delete_old_posts = req.body.delete_old_posts === 'on';

  if (hasMissingValues(name, discord_channel, live_message, new_game_message)) {
    return res.redirect('/admin/streams?error=missing_fields');
  }

  try {
    await addStreamGroup({
      guildId: req.session.user!.currentGuildId!,
      name: name!.trim().slice(0, 100),
      discordChannel: discord_channel!.trim().slice(0, 20),
      liveMessage: live_message!.trim().slice(0, 2000),
      newGameMessage: new_game_message!.trim().slice(0, 2000),
      multiTwitch: multi_twitch,
      deleteOldPosts: delete_old_posts,
    });
    triggerRestart();
  } catch (err) {
    return logAndRedirectError({ res, log, logLabel: 'Add stream group error:', err, basePath: '/admin/streams', errorCode: 'add_group_failed' });
  }
  res.redirect('/admin/streams');
});

/**
 * POST /streams/groups/update — updates an existing stream group's channel,
 * messages, and flags, then restarts the Twitch monitor.
 * @param req - Express request; reads `group_id`, `name`, `discord_channel`,
 *   `live_message`, `new_game_message`, `multi_twitch`, and `delete_old_posts`
 *   from `req.body`.
 * @param res - Express response; redirects to `/admin/streams` on success, or to
 *   `/admin/streams?error=<code>` for missing fields (`missing_fields`), a
 *   malformed `group_id` (`invalid_id`), or a DB failure (`update_group_failed`).
 */
router.post('/streams/groups/update', requireManager, csrfProtection, async (req, res) => {
  const { group_id, name, discord_channel, live_message, new_game_message } = req.body as Record<string, string | undefined>;
  const multi_twitch = req.body.multi_twitch === 'on';
  const delete_old_posts = req.body.delete_old_posts === 'on';

  if (hasMissingValues(group_id, name, discord_channel, live_message, new_game_message)) {
    return res.redirect('/admin/streams?error=missing_fields');
  }

  const parsedGroupId = parsePositiveIntId(group_id);
  if (parsedGroupId === null) return res.redirect('/admin/streams?error=invalid_id');

  try {
    await updateStreamGroup({
      id: parsedGroupId,
      guildId: req.session.user!.currentGuildId!,
      name: name!.trim().slice(0, 100),
      discordChannel: discord_channel!.trim().slice(0, 20),
      liveMessage: live_message!.trim().slice(0, 2000),
      newGameMessage: new_game_message!.trim().slice(0, 2000),
      multiTwitch: multi_twitch,
      deleteOldPosts: delete_old_posts,
    });
    triggerRestart();
  } catch (err) {
    return logAndRedirectError({ res, log, logLabel: 'Update stream group error:', err, basePath: '/admin/streams', errorCode: 'update_group_failed' });
  }
  res.redirect('/admin/streams');
});

/**
 * POST /streams/groups/remove — deletes a stream group, first removing its
 * streamers to avoid FK constraint errors, then restarts the Twitch monitor.
 * @param req - Express request; reads `group_id` from `req.body`.
 * @param res - Express response; redirects to `/admin/streams` on success, or to
 *   `/admin/streams?error=<code>` if `group_id` is malformed (`invalid_id`) or the
 *   delete fails (`remove_group_failed`).
 */
router.post('/streams/groups/remove', requireManager, csrfProtection, async (req, res) => {
  const { group_id } = req.body as { group_id?: string };
  if (!group_id) return res.redirect('/admin/streams');
  const parsedGroupId = parsePositiveIntId(group_id);
  if (parsedGroupId === null) return res.redirect('/admin/streams?error=invalid_id');

  try {
    const guildId = req.session.user!.currentGuildId!;
    // Delete streamers in the group first (avoids FK constraint errors)
    await removeStreamersByGroup(parsedGroupId, guildId);
    await removeStreamGroup(parsedGroupId, guildId);
    triggerRestart();
  } catch (err) {
    return logAndRedirectError({ res, log, logLabel: 'Remove stream group error:', err, basePath: '/admin/streams', errorCode: 'remove_group_failed' });
  }
  res.redirect('/admin/streams');
});

// ─── Streamers ────────────────────────────────────────────────────────────────

/**
 * POST /streams/streamers/add — adds a user (who must already have a Twitch
 * name) as a streamer in a stream group, then restarts the Twitch monitor.
 * @param req - Express request; reads `discord_id` and `group_id` from
 *   `req.body`.
 * @param res - Express response; redirects to `/admin/streams` on success, or to
 *   `/admin/streams?error=<code>` for missing/invalid fields or no Twitch name
 *   (`missing_fields`), a malformed `group_id` (`invalid_id`), or a DB failure
 *   (`add_streamer_failed`).
 */
router.post('/streams/streamers/add', requireManager, csrfProtection, async (req, res) => {
  const { discord_id, group_id } = req.body as { discord_id?: string | string[]; group_id?: string | string[] };
  const discordId = normalizeDiscordId(typeof discord_id === 'string' ? discord_id : undefined);
  const rawGroupId = Array.isArray(group_id) ? group_id[0] : group_id;
  const groupId = typeof rawGroupId === 'string' ? rawGroupId.trim() : null;
  if (!discordId || !groupId) return res.redirect('/admin/streams?error=missing_fields');
  const parsedGroupId = parsePositiveIntId(groupId);
  if (parsedGroupId === null) return res.redirect('/admin/streams?error=invalid_id');

  try {
    const user = await findUser(discordId);
    if (!user?.twitch_name) return res.redirect('/admin/streams?error=missing_fields');
    await addStreamer(discordId, parsedGroupId, req.session.user!.currentGuildId!);
    triggerRestart();
  } catch (err) {
    return logAndRedirectError({ res, log, logLabel: 'Add streamer error:', err, basePath: '/admin/streams', errorCode: 'add_streamer_failed' });
  }
  res.redirect('/admin/streams');
});

/**
 * POST /streams/streamers/remove — removes a streamer, then restarts the
 * Twitch monitor.
 * @param req - Express request; reads `streamer_id` from `req.body`.
 * @param res - Express response; redirects to `/admin/streams` on success, or to
 *   `/admin/streams?error=<code>` if `streamer_id` is malformed (`invalid_id`) or
 *   the delete fails (`remove_streamer_failed`).
 */
router.post('/streams/streamers/remove', requireManager, csrfProtection, async (req, res) => {
  const { streamer_id } = req.body as { streamer_id?: string };
  if (!streamer_id) return res.redirect('/admin/streams');
  const parsedStreamerId = parsePositiveIntId(streamer_id);
  if (parsedStreamerId === null) return res.redirect('/admin/streams?error=invalid_id');

  try {
    await removeStreamer(parsedStreamerId, req.session.user!.currentGuildId!);
    triggerRestart();
  } catch (err) {
    return logAndRedirectError({ res, log, logLabel: 'Remove streamer error:', err, basePath: '/admin/streams', errorCode: 'remove_streamer_failed' });
  }
  res.redirect('/admin/streams');
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Fire-and-forget monitor restart serialised via a promise chain so concurrent
 * CRUD operations cannot interleave teardown and startTwitchMonitor. */
let restartChain: Promise<void> = Promise.resolve();

function triggerRestart(): void {
  restartChain = restartChain
    .then(() => restartTwitchMonitor())
    .catch((err) => { log.error('TwitchMonitor restart error:', err); });
}

export default router;
