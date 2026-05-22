import { createLogger } from '../../logger';
import { Router } from 'express';
import {
  getAllUsers,
  updateAccessLevel,
  ACCESS_LEVEL_LABELS,
  AccessLevel,
  AccessLevelValue,
} from '../../db';
import { csrfProtection } from '../csrf';
import { requireManager, requireAdmin } from '../middleware';
import { normalizeTwitchChannelName } from '../../twitchChannelName';
import { createMutationQueue } from '../../mutationQueue';
import adminRefreshRouter, { refreshState } from './adminRefresh';
import {
  DuplicateTwitchNameError,
  isDuplicateTwitchNameDbError,
  isLockWaitTimeoutDbError,
  addOrUpdateUserMutation,
  removeUserMutation,
  toggleTwitchMutation,
} from './adminUserMutations';

const log = createLogger('Web');
const router = Router();
router.use(adminRefreshRouter);

const KNOWN_ERRORS = new Set(['add_failed', 'duplicate_twitch_name', 'db_busy', 'update_failed', 'remove_failed', 'toggle_failed']);
// Twitch membership changes are serialized per user in-process because this bot
// currently runs as a single web instance. If that changes, move this lock into
// shared storage or a DB transaction/row lock before scaling out.
const userMutationQueue = createMutationQueue();

// View user list (Manager+)
router.get('/users', requireManager, csrfProtection, async (req, res) => {
  try {
    const users = await getAllUsers();
    res.render('admin', {
      user: req.session.user,
      users,
      csrfToken: req.csrfToken(),
      accessLevelLabels: ACCESS_LEVEL_LABELS,
      error: KNOWN_ERRORS.has(req.query.error as string) ? (req.query.error as string) : null,
      refreshState,
    });
  } catch (err) {
    log.error('Admin users error:', err);
    res.status(500).render('error', { message: 'Failed to load users.', user: req.session.user ?? null });
  }
});

// Add or update a user (Admin only)
router.post('/users/add', requireAdmin, csrfProtection, async (req, res) => {
  const { discord_id, discord_name, access_level, twitch_name, clear_twitch_name } = req.body as {
    discord_id?: string;
    discord_name?: string;
    access_level?: string;
    twitch_name?: string;
    clear_twitch_name?: string;
  };
  const trimmedDiscordId = (discord_id ?? '').trim();
  if (!trimmedDiscordId || !access_level) return res.redirect('/admin/users');
  const submittedTwitchName = (twitch_name ?? '').trim();
  const shouldClearTwitchName = clear_twitch_name === '1';
  const normalizedTwitchName = submittedTwitchName ? normalizeTwitchChannelName(submittedTwitchName) : null;
  const level = parseInt(access_level, 10);
  if (!Number.isFinite(level)) return res.status(400).render('error', { message: 'Invalid access level.', user: req.session.user ?? null });
  if (!(Object.values(AccessLevel) as number[]).includes(level)) return res.status(400).render('error', { message: 'Invalid access level.', user: req.session.user ?? null });
  if (!shouldClearTwitchName && submittedTwitchName && !normalizedTwitchName) {
    return res.status(400).render('error', { message: 'Invalid Twitch name.', user: req.session.user ?? null });
  }
  if (trimmedDiscordId === req.session.user?.discordId) {
    return res.status(400).render('error', {
      message: 'You cannot update your own account from this form.',
      user: req.session.user ?? null,
    });
  }
  try {
    const trimmedDiscordName = (discord_name ?? '').trim();
    await userMutationQueue.run(trimmedDiscordId, () => addOrUpdateUserMutation({
      discordId: trimmedDiscordId,
      discordName: trimmedDiscordName,
      level: level as AccessLevelValue,
      normalizedTwitchName,
      shouldClearTwitchName,
    }));
  } catch (err) {
    log.error('Add user error:', err);
    if (err instanceof DuplicateTwitchNameError || isDuplicateTwitchNameDbError(err)) {
      return res.redirect('/admin/users?error=duplicate_twitch_name');
    }
    if (isLockWaitTimeoutDbError(err)) {
      return res.redirect('/admin/users?error=db_busy');
    }
    return res.redirect('/admin/users?error=add_failed');
  }
  res.redirect('/admin/users');
});

// Update access level (Admin only)
router.post('/users/update', requireAdmin, csrfProtection, async (req, res) => {
  const { discord_id, access_level } = req.body as { discord_id?: string; access_level?: string };
  const trimmedDiscordId = (discord_id ?? '').trim();
  if (!trimmedDiscordId || access_level === undefined) return res.redirect('/admin/users');
  const level = parseInt(access_level, 10);
  if (!Number.isFinite(level)) return res.status(400).render('error', { message: 'Invalid access level.', user: req.session.user ?? null });
  if (!(Object.values(AccessLevel) as number[]).includes(level)) return res.status(400).render('error', { message: 'Invalid access level.', user: req.session.user ?? null });

  if (trimmedDiscordId === req.session.user!.discordId) {
    return res.status(400).render('error', {
      message: 'You cannot change your own access level.',
      user: req.session.user ?? null,
    });
  }
  try {
    await userMutationQueue.run(trimmedDiscordId, () => updateAccessLevel(trimmedDiscordId, level));
  } catch (err) {
    log.error('Update access level error:', err);
    if (isLockWaitTimeoutDbError(err)) return res.redirect('/admin/users?error=db_busy');
    return res.redirect('/admin/users?error=update_failed');
  }
  res.redirect('/admin/users');
});

// Remove a user (Admin only)
router.post('/users/remove', requireAdmin, csrfProtection, async (req, res) => {
  const { discord_id } = req.body as { discord_id?: string };
  const trimmedDiscordId = (discord_id ?? '').trim();
  if (!trimmedDiscordId) return res.redirect('/admin/users');

  if (trimmedDiscordId === req.session.user!.discordId) {
    return res.status(400).render('error', {
      message: 'You cannot remove yourself.',
      user: req.session.user ?? null,
    });
  }
  try {
    await userMutationQueue.run(trimmedDiscordId, () => removeUserMutation(trimmedDiscordId));
  } catch (err) {
    log.error('Remove user error:', err);
    if (isLockWaitTimeoutDbError(err)) return res.redirect('/admin/users?error=db_busy');
    return res.redirect('/admin/users?error=remove_failed');
  }
  res.redirect('/admin/users');
});

// Toggle twitch bot participation for a user (Manager+)
router.post('/users/toggle-twitch', requireManager, csrfProtection, async (req, res) => {
  const { discord_id, is_twitch_bot_enabled } = req.body as {
    discord_id?: string;
    is_twitch_bot_enabled?: string;
  };
  const trimmedDiscordId = (discord_id ?? '').trim();
  if (!trimmedDiscordId) return res.redirect('/admin/users');

  let nextEnabled: boolean;
  if (is_twitch_bot_enabled === 'true' || is_twitch_bot_enabled === '1') {
    nextEnabled = true;
  } else if (is_twitch_bot_enabled === 'false' || is_twitch_bot_enabled === '0') {
    nextEnabled = false;
  } else {
    return res.status(400).render('error', {
      message: 'Invalid Twitch enabled state.',
      user: req.session.user ?? null,
    });
  }

  try {
    await userMutationQueue.run(trimmedDiscordId, () => toggleTwitchMutation(trimmedDiscordId, nextEnabled));
  } catch (err) {
    log.error('Toggle twitch user error:', err);
    if (isLockWaitTimeoutDbError(err)) return res.redirect('/admin/users?error=db_busy');
    return res.redirect('/admin/users?error=toggle_failed');
  }
  res.redirect('/admin/users');
});

export default router;
