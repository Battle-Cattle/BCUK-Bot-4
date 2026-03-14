import { Router } from 'express';
import {
  getAllUsers,
  upsertUser,
  removeUser,
  updateAccessLevel,
  ACCESS_LEVEL_LABELS,
  AccessLevel,
  AccessLevelValue,
} from '../../db';
import { requireManager, requireAdmin } from '../middleware';

const router = Router();

// View user list (Manager+)
router.get('/users', requireManager, async (req, res) => {
  try {
    const users = await getAllUsers();
    res.render('admin', {
      user: req.session.user,
      users,
      accessLevelLabels: ACCESS_LEVEL_LABELS,
      error: req.query.error ?? null,
    });
  } catch (err) {
    console.error('[Web] Admin users error:', err);
    res.status(500).render('error', { message: 'Failed to load users.', user: req.session.user ?? null });
  }
});

// Add or update a user (Admin only)
router.post('/users/add', requireAdmin, async (req, res) => {
  const { discord_id, discord_name, access_level } = req.body as {
    discord_id?: string;
    discord_name?: string;
    access_level?: string;
  };
  if (!discord_id || !access_level) return res.redirect('/admin/users');
  const level = parseInt(access_level, 10);
  if (!Number.isFinite(level)) return res.status(400).render('error', { message: 'Invalid access level.', user: req.session.user ?? null });
  if (!(Object.values(AccessLevel) as number[]).includes(level)) return res.status(400).render('error', { message: 'Invalid access level.', user: req.session.user ?? null });
  try {
    await upsertUser(discord_id.trim(), (discord_name ?? '').trim(), level as AccessLevelValue);
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

export default router;
