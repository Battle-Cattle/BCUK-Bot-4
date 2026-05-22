import { createLogger } from '../../logger';
import { Router } from 'express';
import {
  getAllStreamGroups,
  addStreamGroup,
  updateStreamGroup,
  removeStreamGroup,
  getAllStreamers,
  addStreamer,
  removeStreamer,
  removeStreamersByGroup,
  getAllEventSubStreamers,
  getAllUsers,
  findUser,
} from '../../db';
import { csrfProtection } from '../csrf';
import { requireManager } from '../middleware';
import { restartTwitchMonitor, getLiveStates } from '../../twitchMonitor';
import { AccessLevel } from '../../db';
import { parsePositiveIntId } from './shared';

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

router.get('/streams', requireManager, csrfProtection, async (req, res) => {
  try {
    const isAdmin = (req.session.user?.accessLevel ?? 0) >= AccessLevel.ADMIN;
    const [groups, streamers, eventSubStreamers, allUsers] = await Promise.all([
      getAllStreamGroups(),
      getAllStreamers(),
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

    res.render('streams', {
      user: req.session.user,
      groups,
      streamers,
      isAdmin,
      eventSubById,
      eligibleUsers,
      csrfToken: req.csrfToken(),
      error: KNOWN_ERRORS.has(req.query.error as string) ? (req.query.error as string) : null,
      success: req.query.success as string | undefined,
      getFriendlyError,
    });
  } catch (err) {
    log.error('Streams page error:', err);
    res.status(500).render('error', { message: 'Failed to load streams page.', user: req.session.user ?? null });
  }
});

// ─── Live state snapshot ──────────────────────────────────────────────────────

router.get('/streams/live', requireManager, (_req, res) => {
  res.json({ streams: getLiveStates() });
});

// ─── Groups ───────────────────────────────────────────────────────────────────

router.post('/streams/groups/add', requireManager, csrfProtection, async (req, res) => {
  const { name, discord_channel, live_message, new_game_message } = req.body as Record<string, string | undefined>;
  const multi_twitch = req.body.multi_twitch === 'on';
  const delete_old_posts = req.body.delete_old_posts === 'on';

  if (hasMissingValues(name, discord_channel, live_message, new_game_message)) {
    return res.redirect('/admin/streams?error=missing_fields');
  }

  try {
    await addStreamGroup({
      name: name!.trim(),
      discordChannel: discord_channel!.trim(),
      liveMessage: live_message!.trim(),
      newGameMessage: new_game_message!.trim(),
      multiTwitch: multi_twitch,
      deleteOldPosts: delete_old_posts,
    });
    triggerRestart();
  } catch (err) {
    log.error('Add stream group error:', err);
    return res.redirect('/admin/streams?error=add_group_failed');
  }
  res.redirect('/admin/streams');
});

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
      name: name!.trim(),
      discordChannel: discord_channel!.trim(),
      liveMessage: live_message!.trim(),
      newGameMessage: new_game_message!.trim(),
      multiTwitch: multi_twitch,
      deleteOldPosts: delete_old_posts,
    });
    triggerRestart();
  } catch (err) {
    log.error('Update stream group error:', err);
    return res.redirect('/admin/streams?error=update_group_failed');
  }
  res.redirect('/admin/streams');
});

router.post('/streams/groups/remove', requireManager, csrfProtection, async (req, res) => {
  const { group_id } = req.body as { group_id?: string };
  if (!group_id) return res.redirect('/admin/streams');
  const parsedGroupId = parsePositiveIntId(group_id);
  if (parsedGroupId === null) return res.redirect('/admin/streams?error=invalid_id');

  try {
    // Delete streamers in the group first (avoids FK constraint errors)
    await removeStreamersByGroup(parsedGroupId);
    await removeStreamGroup(parsedGroupId);
    triggerRestart();
  } catch (err) {
    log.error('Remove stream group error:', err);
    return res.redirect('/admin/streams?error=remove_group_failed');
  }
  res.redirect('/admin/streams');
});

// ─── Streamers ────────────────────────────────────────────────────────────────

router.post('/streams/streamers/add', requireManager, csrfProtection, async (req, res) => {
  const { discord_id, group_id } = req.body as { discord_id?: string; group_id?: string };
  if (!discord_id || !group_id) return res.redirect('/admin/streams?error=missing_fields');
  const parsedGroupId = parsePositiveIntId(group_id);
  if (parsedGroupId === null) return res.redirect('/admin/streams?error=invalid_id');

  try {
    const user = await findUser(discord_id.trim());
    if (!user?.twitch_name) return res.redirect('/admin/streams?error=missing_fields');
    await addStreamer(discord_id.trim(), parsedGroupId);
    triggerRestart();
  } catch (err) {
    log.error('Add streamer error:', err);
    return res.redirect('/admin/streams?error=add_streamer_failed');
  }
  res.redirect('/admin/streams');
});

router.post('/streams/streamers/remove', requireManager, csrfProtection, async (req, res) => {
  const { streamer_id } = req.body as { streamer_id?: string };
  if (!streamer_id) return res.redirect('/admin/streams');
  const parsedStreamerId = parsePositiveIntId(streamer_id);
  if (parsedStreamerId === null) return res.redirect('/admin/streams?error=invalid_id');

  try {
    await removeStreamer(parsedStreamerId);
    triggerRestart();
  } catch (err) {
    log.error('Remove streamer error:', err);
    return res.redirect('/admin/streams?error=remove_streamer_failed');
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
