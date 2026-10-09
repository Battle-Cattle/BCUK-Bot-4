import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import { addStreamer, removeStreamer, findUser, getMemberAccessLevel } from '../../db';
import { csrfProtection } from '../csrf';
import { requireManager } from '../middleware';
import { getCurrentGuildId } from '../session';
import { parsePositiveIntId, normalizeDiscordId } from './validation';
import { redirectStreamsInvalid, redirectStreamsFailure, type StreamsErrorCode } from './streamsErrors';
import { triggerRestart } from './streamRestart';

const log = createLogger('Web');
const router = Router();

/** The validated form fields for adding a streamer. */
interface AddStreamerFields {
  discordId: string;
  groupId: number;
}

/**
 * Validates the add-streamer form body. Repeated fields (arriving as arrays) are rejected, like
 * everywhere else `normalizeDiscordId`/`parsePositiveIntId` are used.
 * @param body - The raw request body.
 * @returns The parsed fields, or the error code to redirect with: `missing_fields` when either
 *   field is absent or `discord_id` isn't a valid snowflake, `invalid_id` for a malformed `group_id`.
 */
function parseAddStreamerFields(body: { discord_id?: unknown; group_id?: string | string[] }): AddStreamerFields | StreamsErrorCode {
  const discordId = normalizeDiscordId(body.discord_id);
  if (!discordId || !body.group_id) return 'missing_fields';
  const groupId = parsePositiveIntId(body.group_id);
  return groupId === null ? 'invalid_id' : { discordId, groupId };
}

/**
 * Checks that a user can be added as a streamer in a guild: they need a linked Twitch name and
 * must be a member of the guild.
 * @param guildId - The current guild's ID.
 * @param discordId - The user to add.
 * @returns `missing_fields` if the user has no Twitch name (or doesn't exist),
 *   `streamer_not_member` if they aren't in the guild, or null if they can be added.
 */
async function findStreamerEligibilityError(guildId: string, discordId: string): Promise<StreamsErrorCode | null> {
  const user = await findUser(discordId);
  if (!user?.twitch_name) return 'missing_fields';
  const accessLevel = await getMemberAccessLevel(guildId, discordId);
  return accessLevel === null ? 'streamer_not_member' : null;
}

/**
 * POST /streams/streamers/add — adds a user (who must already have a Twitch
 * name and be a member of the current guild) as a streamer in a stream group,
 * then restarts the Twitch monitor.
 * @param req - Express request; reads `discord_id` and `group_id` from
 *   `req.body`.
 * @param res - Express response; redirects to `/admin/streams` on success, or to
 *   `/admin/streams?error=<code>` for missing/invalid fields or no Twitch name
 *   (`missing_fields`), a malformed or repeated `group_id` (`invalid_id`), a user
 *   who isn't a member of the current guild (`streamer_not_member`), or a DB
 *   failure (`add_streamer_failed`).
 */
router.post('/streams/streamers/add', requireManager, csrfProtection, async (req, res) => {
  const fields = parseAddStreamerFields(req.body as { discord_id?: unknown; group_id?: string | string[] });
  if (typeof fields === 'string') return redirectStreamsInvalid(res, fields);

  try {
    const guildId = getCurrentGuildId(req);
    const eligibilityError = await findStreamerEligibilityError(guildId, fields.discordId);
    if (eligibilityError) return redirectStreamsInvalid(res, eligibilityError);
    await addStreamer(fields.discordId, fields.groupId, guildId);
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
