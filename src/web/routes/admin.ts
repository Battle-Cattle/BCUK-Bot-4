import { Router } from 'express';
import {
  getAllUsers,
  findUser,
  upsertUser,
  removeUser,
  updateAccessLevel,
  updateDiscordName,
  updateTwitchBotEnabled,
  ACCESS_LEVEL_LABELS,
  AccessLevel,
  AccessLevelValue,
} from '../../db';
import { requireManager, requireAdmin } from '../middleware';
import { fetchMemberDisplayName } from '../../discordBot';
import { joinTwitchChannel, partTwitchChannel } from '../../twitchBot';

const router = Router();

const KNOWN_ERRORS = new Set(['add_failed', 'update_failed', 'remove_failed', 'toggle_failed']);

// View user list (Manager+)
router.get('/users', requireManager, async (req, res) => {
  try {
    const users = await getAllUsers();
    res.render('admin', {
      user: req.session.user,
      users,
      accessLevelLabels: ACCESS_LEVEL_LABELS,
      error: KNOWN_ERRORS.has(req.query.error as string) ? (req.query.error as string) : null,
      refreshed: req.query.refreshed === '1',
    });
  } catch (err) {
    console.error('[Web] Admin users error:', err);
    res.status(500).render('error', { message: 'Failed to load users.', user: req.session.user ?? null });
  }
});

// Add or update a user (Admin only)
router.post('/users/add', requireAdmin, async (req, res) => {
  const { discord_id, discord_name, access_level, twitch_name } = req.body as {
    discord_id?: string;
    discord_name?: string;
    access_level?: string;
    twitch_name?: string;
  };
  if (!discord_id || !access_level) return res.redirect('/admin/users');
  const level = parseInt(access_level, 10);
  if (!Number.isFinite(level)) return res.status(400).render('error', { message: 'Invalid access level.', user: req.session.user ?? null });
  if (!(Object.values(AccessLevel) as number[]).includes(level)) return res.status(400).render('error', { message: 'Invalid access level.', user: req.session.user ?? null });
  try {
    await upsertUser(discord_id.trim(), (discord_name ?? '').trim(), level as AccessLevelValue, twitch_name);
  } catch (err) {
    console.error('[Web] Add user error:', err);
    return res.redirect('/admin/users?error=add_failed');
  }
  res.redirect('/admin/users');
});

// Update access level (Admin only)
router.post('/users/update', requireAdmin, async (req, res) => {
  const { discord_id, access_level } = req.body as { discord_id?: string; access_level?: string };
  if (!discord_id || access_level === undefined) return res.redirect('/admin/users');
  const level = parseInt(access_level, 10);
  if (!Number.isFinite(level)) return res.status(400).render('error', { message: 'Invalid access level.', user: req.session.user ?? null });
  if (!(Object.values(AccessLevel) as number[]).includes(level)) return res.status(400).render('error', { message: 'Invalid access level.', user: req.session.user ?? null });

  // Prevent demoting yourself
  if (discord_id === req.session.user!.discordId) {
    return res.status(400).render('error', {
      message: 'You cannot change your own access level.',
      user: req.session.user ?? null,
    });
  }
  try {
    await updateAccessLevel(discord_id, level);
  } catch (err) {
    console.error('[Web] Update access level error:', err);
    return res.redirect('/admin/users?error=update_failed');
  }
  res.redirect('/admin/users');
});

// Remove a user (Admin only)
router.post('/users/remove', requireAdmin, async (req, res) => {
  const { discord_id } = req.body as { discord_id?: string };
  if (!discord_id) return res.redirect('/admin/users');

  if (discord_id === req.session.user!.discordId) {
    return res.status(400).render('error', {
      message: 'You cannot remove yourself.',
      user: req.session.user ?? null,
    });
  }
  try {
    await removeUser(discord_id);
  } catch (err) {
    console.error('[Web] Remove user error:', err);
    return res.redirect('/admin/users?error=remove_failed');
  }
  res.redirect('/admin/users');
});

// Toggle twitch bot participation for a user (Manager+)
router.post('/users/toggle-twitch', requireManager, async (req, res) => {
  const { discord_id } = req.body as { discord_id?: string };
  if (!discord_id) return res.redirect('/admin/users');

  try {
    const user = await findUser(discord_id);
    if (!user || !user.twitch_name) {
      return res.redirect('/admin/users?error=toggle_failed');
    }

    const nextEnabled = !user.is_twitch_bot_enabled;
    await updateTwitchBotEnabled(discord_id, nextEnabled);

    if (nextEnabled) {
      await joinTwitchChannel(user.twitch_name);
    } else {
      await partTwitchChannel(user.twitch_name);
    }
  } catch (err) {
    console.error('[Web] Toggle twitch user error:', err);
    return res.redirect('/admin/users?error=toggle_failed');
  }

  res.redirect('/admin/users');
});

// Refresh Discord names for all users (Manager+)
router.post('/users/refresh-names', requireManager, async (req, res) => {
  try {
    const users = await getAllUsers();
    await Promise.allSettled(
      users.map(async (u) => {
        const name = await fetchMemberDisplayName(u.discord_id);
        if (!name || !name.trim()) return;
        await updateDiscordName(u.discord_id, name.trim());
      }),
    );
  } catch (err) {
    console.error('[Web] Refresh Discord names failed:', err);
    return res.redirect('/admin/users?error=update_failed');
  }

  res.redirect('/admin/users?refreshed=1');
});

export default router;
