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
} from '../../db';
import { csrfProtection } from '../csrf';
import { requireManager } from '../middleware';
import { getMonitorEnabled, setMonitorEnabled } from '../../monitorSettings';
import { restartTwitchMonitor, getLiveStates, catchUpDiscordPosts } from '../../twitchMonitor';

const router = Router();

function parsePositiveIntId(value: string | undefined): number | null {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    return null;
  }

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function hasMissingValues(...values: Array<string | undefined>): boolean {
  return values.some((value) => value === undefined || value.trim().length === 0);
}

const KNOWN_ERRORS = new Set([
  'missing_fields', 'invalid_id',
  'add_group_failed', 'update_group_failed', 'remove_group_failed',
  'add_streamer_failed', 'remove_streamer_failed',
]);

// ─── View ─────────────────────────────────────────────────────────────────────

router.get('/streams', requireManager, csrfProtection, async (req, res) => {
  try {
    const [groups, streamers] = await Promise.all([getAllStreamGroups(), getAllStreamers()]);
    res.render('streams', {
      user: req.session.user,
      groups,
      streamers,
      csrfToken: req.csrfToken(),
      monitorEnabled: getMonitorEnabled(),
      error: KNOWN_ERRORS.has(req.query.error as string) ? (req.query.error as string) : null,
    });
  } catch (err) {
    console.error('[Web] Streams page error:', err);
    res.status(500).render('error', { message: 'Failed to load streams page.', user: req.session.user ?? null });
  }
});

// ─── Toggle ───────────────────────────────────────────────────────────────────

router.post('/streams/toggle', requireManager, csrfProtection, (req, res) => {
  const wasEnabled = getMonitorEnabled();
  setMonitorEnabled(!wasEnabled);

  if (!wasEnabled) {
    // Turning ON — post announcements for any currently tracked live streams
    catchUpDiscordPosts().catch((err) =>
      console.error('[Web] TwitchMonitor catch-up error:', err),
    );
  }
  // Turning OFF — nothing to do; monitor keeps running, Discord posts are silenced

  res.redirect('/admin/streams');
});

// ─── Live state snapshot ──────────────────────────────────────────────────────

router.get('/streams/live', requireManager, (_req, res) => {
  res.json({ enabled: getMonitorEnabled(), streams: getLiveStates() });
});

// ─── Groups ───────────────────────────────────────────────────────────────────

router.post('/streams/groups/add', requireManager, csrfProtection, async (req, res) => {
  const { name, discord_channel, live_message, new_game_message, multi_twitch_message } = req.body as Record<string, string | undefined>;
  const multi_twitch = req.body.multi_twitch === 'on';
  const delete_old_posts = req.body.delete_old_posts === 'on';

  if (hasMissingValues(name, discord_channel, live_message, new_game_message)) {
    return res.redirect('/admin/streams?error=missing_fields');
  }

  const normalizedName = (name ?? '').trim();
  const normalizedDiscordChannel = (discord_channel ?? '').trim();
  const normalizedLiveMessage = (live_message ?? '').trim();
  const normalizedNewGameMessage = (new_game_message ?? '').trim();

  try {
    await addStreamGroup({
      name: normalizedName,
      discordChannel: normalizedDiscordChannel,
      liveMessage: normalizedLiveMessage,
      newGameMessage: normalizedNewGameMessage,
      multiTwitch: multi_twitch,
      multiTwitchMessage: (multi_twitch_message ?? '').trim(),
      deleteOldPosts: delete_old_posts,
    });
    triggerRestart();
  } catch (err) {
    console.error('[Web] Add stream group error:', err);
    return res.redirect('/admin/streams?error=add_group_failed');
  }
  res.redirect('/admin/streams');
});

router.post('/streams/groups/update', requireManager, csrfProtection, async (req, res) => {
  const { group_id, name, discord_channel, live_message, new_game_message, multi_twitch_message } = req.body as Record<string, string | undefined>;
  const multi_twitch = req.body.multi_twitch === 'on';
  const delete_old_posts = req.body.delete_old_posts === 'on';

  if (hasMissingValues(group_id, name, discord_channel, live_message, new_game_message)) {
    return res.redirect('/admin/streams?error=missing_fields');
  }

  const normalizedName = (name ?? '').trim();
  const normalizedDiscordChannel = (discord_channel ?? '').trim();
  const normalizedLiveMessage = (live_message ?? '').trim();
  const normalizedNewGameMessage = (new_game_message ?? '').trim();

  const parsedGroupId = parsePositiveIntId(group_id);
  if (parsedGroupId === null) return res.redirect('/admin/streams?error=invalid_id');

  try {
    await updateStreamGroup({
      id: parsedGroupId,
      name: normalizedName,
      discordChannel: normalizedDiscordChannel,
      liveMessage: normalizedLiveMessage,
      newGameMessage: normalizedNewGameMessage,
      multiTwitch: multi_twitch,
      multiTwitchMessage: (multi_twitch_message ?? '').trim(),
      deleteOldPosts: delete_old_posts,
    });
    triggerRestart();
  } catch (err) {
    console.error('[Web] Update stream group error:', err);
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
    console.error('[Web] Remove stream group error:', err);
    return res.redirect('/admin/streams?error=remove_group_failed');
  }
  res.redirect('/admin/streams');
});

// ─── Streamers ────────────────────────────────────────────────────────────────

router.post('/streams/streamers/add', requireManager, csrfProtection, async (req, res) => {
  const { name, group_id } = req.body as { name?: string; group_id?: string };
  if (!name || !group_id) return res.redirect('/admin/streams');
  const parsedGroupId = parsePositiveIntId(group_id);
  if (parsedGroupId === null) return res.redirect('/admin/streams?error=invalid_id');

  try {
    await addStreamer(name.trim(), parsedGroupId);
    triggerRestart();
  } catch (err) {
    console.error('[Web] Add streamer error:', err);
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
    console.error('[Web] Remove streamer error:', err);
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
    .catch((err) => console.error('[Web] TwitchMonitor restart error:', err));
}

export default router;
