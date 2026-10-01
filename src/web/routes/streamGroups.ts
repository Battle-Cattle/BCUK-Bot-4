import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import { addStreamGroup, updateStreamGroup, removeStreamGroupAndStreamers } from '../../db';
import { csrfProtection } from '../csrf';
import { requireManager } from '../middleware';
import { getCurrentGuildId } from '../session';
import { parsePositiveIntId, parseCheckboxField } from './validation';
import { redirectStreamsInvalid, redirectStreamsFailure } from './streamsErrors';
import { triggerRestart } from './streamRestart';
import { DiscordAPIError } from 'discord.js';
import { getDiscordClient } from '../../discord/discordClientStore';
import { isDiscordNotFoundError } from '../../discord/discordUtils';
import type { StreamsErrorCode } from './streamsErrors';

const log = createLogger('Web');
const router = Router();

/** Returns true if any of the given form values is missing, non-string, or blank after trimming. */
function hasMissingValues(...values: Array<string | undefined>): boolean {
  return values.some((value) => typeof value !== 'string' || value.trim().length === 0);
}

/** A Discord snowflake channel ID — 17–20 decimal digits. */
const DISCORD_CHANNEL_ID_RE = /^\d{17,20}$/;

/**
 * Confirms `channelId` is a text-based channel in `guildId`, so a Manager can
 * only point announcements at a channel in the guild they're managing (the
 * Twitch monitor later posts `live_message` there via `client.channels.fetch`).
 * A not-found or missing-access fetch counts as an invalid channel; any other
 * Discord error is rethrown for the caller's catch-and-redirect.
 * @param guildId - The session's current guild ID.
 * @param channelId - The trimmed `discord_channel` form value.
 * @returns `null` when valid, otherwise the error code to redirect with
 *   (`invalid_channel`, or `discord_unavailable` before the bot is connected).
 */
async function checkGuildTextChannel(guildId: string, channelId: string): Promise<StreamsErrorCode | null> {
  if (!DISCORD_CHANNEL_ID_RE.test(channelId)) return 'invalid_channel';
  const client = getDiscordClient();
  if (!client) return 'discord_unavailable';
  let channel;
  try {
    channel = await client.channels.fetch(channelId);
  } catch (err) {
    if (isDiscordNotFoundError(err) || (err instanceof DiscordAPIError && err.status === 403)) {
      return 'invalid_channel';
    }
    throw err;
  }
  if (!channel || !('guildId' in channel) || channel.guildId !== guildId || !channel.isTextBased()) {
    return 'invalid_channel';
  }
  return null;
}

/**
 * POST /streams/groups/add — creates a new stream group (Discord channel, live
 * and new-game messages, multi-twitch/delete-old-posts flags) and restarts the
 * Twitch monitor.
 * @param req - Express request; reads `name`, `discord_channel`, `live_message`,
 *   `new_game_message`, `multi_twitch`, and `delete_old_posts` from `req.body`.
 * @param res - Express response; redirects to `/admin/streams` on success, or to
 *   `/admin/streams?error=<code>` for missing fields (`missing_fields`), a
 *   channel that isn't a text channel in the current guild (`invalid_channel`),
 *   the Discord bot not being connected (`discord_unavailable`), or a DB/Discord
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
    const guildId = getCurrentGuildId(req);
    const discordChannel = discord_channel!.trim();
    const channelError = await checkGuildTextChannel(guildId, discordChannel);
    if (channelError) return redirectStreamsInvalid(res, channelError);
    const created = await addStreamGroup({
      guildId,
      name: name!.trim().slice(0, 100),
      discordChannel,
      liveMessage: live_message!.trim().slice(0, 2000),
      newGameMessage: new_game_message!.trim().slice(0, 2000),
      multiTwitch: multi_twitch,
      deleteOldPosts: delete_old_posts,
    });
    if (!created) return redirectStreamsInvalid(res, 'duplicate_group_name');
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
 *   malformed `group_id` (`invalid_id`), a channel that isn't a text channel in
 *   the current guild (`invalid_channel`), the Discord bot not being connected
 *   (`discord_unavailable`), or a DB/Discord failure (`update_group_failed`).
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
    const guildId = getCurrentGuildId(req);
    const discordChannel = discord_channel!.trim();
    const channelError = await checkGuildTextChannel(guildId, discordChannel);
    if (channelError) return redirectStreamsInvalid(res, channelError);
    const updated = await updateStreamGroup({
      id: parsedGroupId,
      guildId,
      name: name!.trim().slice(0, 100),
      discordChannel,
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
    const guildId = getCurrentGuildId(req);
    const removed = await removeStreamGroupAndStreamers(parsedGroupId, guildId);
    if (!removed) return redirectStreamsInvalid(res, 'remove_group_failed');
    triggerRestart();
  } catch (err) {
    return redirectStreamsFailure(res, log, 'Remove stream group error:', err, 'remove_group_failed');
  }
  res.redirect('/admin/streams');
});

export default router;
