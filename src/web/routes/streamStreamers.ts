import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import { addStreamer, removeStreamer, findUser } from '../../db';
import { csrfProtection } from '../csrf';
import { requireManager } from '../middleware';
import { getCurrentGuildId } from '../session';
import { parsePositiveIntId, normalizeDiscordId } from './validation';
import { redirectStreamsInvalid, redirectStreamsFailure } from './streamsErrors';
import { triggerRestart } from './streamRestart';

const log = createLogger('Web');
const router = Router();

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
  if (!discordId || !groupId) return redirectStreamsInvalid(res, 'missing_fields');
  const parsedGroupId = parsePositiveIntId(groupId);
  if (parsedGroupId === null) return redirectStreamsInvalid(res, 'invalid_id');

  try {
    const user = await findUser(discordId);
    if (!user?.twitch_name) return redirectStreamsInvalid(res, 'missing_fields');
    await addStreamer(discordId, parsedGroupId, getCurrentGuildId(req));
    triggerRestart();
  } catch (err) {
    return redirectStreamsFailure(res, log, 'Add streamer error:', err, 'add_streamer_failed');
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
  if (!streamer_id) return redirectStreamsInvalid(res, 'missing_fields');
  const parsedStreamerId = parsePositiveIntId(streamer_id);
  if (parsedStreamerId === null) return redirectStreamsInvalid(res, 'invalid_id');

  try {
    const removed = await removeStreamer(parsedStreamerId, getCurrentGuildId(req));
    if (!removed) return redirectStreamsInvalid(res, 'remove_streamer_failed');
    triggerRestart();
  } catch (err) {
    return redirectStreamsFailure(res, log, 'Remove streamer error:', err, 'remove_streamer_failed');
  }
  res.redirect('/admin/streams');
});

export default router;
