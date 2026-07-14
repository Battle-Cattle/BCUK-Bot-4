import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import { addStreamGroup, updateStreamGroup, removeStreamGroupAndStreamers } from '../../db';
import { csrfProtection } from '../csrf';
import { requireManager } from '../middleware';
import { getSessionUser } from '../session';
import { parsePositiveIntId, parseCheckboxField } from './shared';
import { redirectStreamsInvalid, redirectStreamsFailure } from './streamsErrors';
import { triggerRestart } from './streamRestart';

const log = createLogger('Web');
const router = Router();

/** Returns true if any of the given form values is missing, non-string, or blank after trimming. */
function hasMissingValues(...values: Array<string | undefined>): boolean {
  return values.some((value) => typeof value !== 'string' || value.trim().length === 0);
}

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
  const multi_twitch = parseCheckboxField(req.body.multi_twitch);
  const delete_old_posts = parseCheckboxField(req.body.delete_old_posts);

  if (hasMissingValues(name, discord_channel, live_message, new_game_message)) {
    return redirectStreamsInvalid(res, 'missing_fields');
  }

  try {
    await addStreamGroup({
      guildId: getSessionUser(req).currentGuildId!,
      name: name!.trim().slice(0, 100),
      discordChannel: discord_channel!.trim().slice(0, 20),
      liveMessage: live_message!.trim().slice(0, 2000),
      newGameMessage: new_game_message!.trim().slice(0, 2000),
      multiTwitch: multi_twitch,
      deleteOldPosts: delete_old_posts,
    });
    triggerRestart();
  } catch (err) {
    return redirectStreamsFailure(res, log, 'Add stream group error:', err, 'add_group_failed');
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
  const multi_twitch = parseCheckboxField(req.body.multi_twitch);
  const delete_old_posts = parseCheckboxField(req.body.delete_old_posts);

  if (hasMissingValues(group_id, name, discord_channel, live_message, new_game_message)) {
    return redirectStreamsInvalid(res, 'missing_fields');
  }

  const parsedGroupId = parsePositiveIntId(group_id);
  if (parsedGroupId === null) return redirectStreamsInvalid(res, 'invalid_id');

  try {
    const updated = await updateStreamGroup({
      id: parsedGroupId,
      guildId: getSessionUser(req).currentGuildId!,
      name: name!.trim().slice(0, 100),
      discordChannel: discord_channel!.trim().slice(0, 20),
      liveMessage: live_message!.trim().slice(0, 2000),
      newGameMessage: new_game_message!.trim().slice(0, 2000),
      multiTwitch: multi_twitch,
      deleteOldPosts: delete_old_posts,
    });
    if (!updated) return redirectStreamsInvalid(res, 'update_group_failed');
    triggerRestart();
  } catch (err) {
    return redirectStreamsFailure(res, log, 'Update stream group error:', err, 'update_group_failed');
  }
  res.redirect('/admin/streams');
});

/**
 * POST /streams/groups/remove — deletes a stream group and its streamers
 * atomically, then restarts the Twitch monitor.
 * @param req - Express request; reads `group_id` from `req.body`.
 * @param res - Express response; redirects to `/admin/streams` on success, or to
 *   `/admin/streams?error=<code>` if `group_id` is malformed (`invalid_id`) or the
 *   delete fails (`remove_group_failed`).
 */
router.post('/streams/groups/remove', requireManager, csrfProtection, async (req, res) => {
  const { group_id } = req.body as { group_id?: string };
  if (!group_id) return redirectStreamsInvalid(res, 'missing_fields');
  const parsedGroupId = parsePositiveIntId(group_id);
  if (parsedGroupId === null) return redirectStreamsInvalid(res, 'invalid_id');

  try {
    const guildId = getSessionUser(req).currentGuildId!;
    const removed = await removeStreamGroupAndStreamers(parsedGroupId, guildId);
    if (!removed) return redirectStreamsInvalid(res, 'remove_group_failed');
    triggerRestart();
  } catch (err) {
    return redirectStreamsFailure(res, log, 'Remove stream group error:', err, 'remove_group_failed');
  }
  res.redirect('/admin/streams');
});

export default router;
