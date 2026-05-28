import { createLogger } from '../../logger';
import { Router, Response } from 'express';
import {
  findUser,
  getAllUsers,
  updateAccessLevel,
  ACCESS_LEVEL_LABELS,
  AccessLevel,
  AccessLevelValue,
} from '../../db';
import { csrfProtection } from '../csrf';
import { requireManager, requireAdmin } from '../middleware';
import { trimField, renderError } from './shared';
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

const DISCORD_ID_RE = /^\d{17,20}$/;
const KNOWN_ERRORS = new Set([
  'add_failed', 'duplicate_twitch_name', 'db_busy', 'update_failed', 'remove_failed', 'toggle_failed',
  'invalid_discord_id', 'invalid_access_level', 'access_level_too_high', 'invalid_twitch_name',
  'self_edit_forbidden', 'self_remove_forbidden', 'target_above_level', 'invalid_twitch_state',
]);
// Twitch membership changes are serialized per user in-process because this bot
// currently runs as a single web instance. If that changes, move this lock into
// shared storage or a DB transaction/row lock before scaling out.
const userMutationQueue = createMutationQueue();

function discordIdError(id: string): string | null {
  return DISCORD_ID_RE.test(id) ? null : 'invalid_discord_id';
}

function accessLevelError(levelStr: string): string | null {
  if (!/^\d+$/.test(levelStr)) return 'invalid_access_level';
  return (Object.values(AccessLevel) as number[]).includes(Number(levelStr)) ? null : 'invalid_access_level';
}

function parseTwitchEnabled(val: string | undefined): boolean | null {
  if (val === 'true' || val === '1') return true;
  if (val === 'false' || val === '0') return false;
  return null;
}

function handleDbError(err: unknown, res: Response, failCode: string, context: string): void {
  if (isLockWaitTimeoutDbError(err)) {
    log.warn(`${context} DB lock timeout`, err);
    res.redirect('/admin/users?error=db_busy');
  } else {
    log.error(`${context} error:`, err);
    res.redirect(`/admin/users?error=${failCode}`);
  }
}

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
    renderError(res, 500, 'Failed to load users.', req.session.user);
  }
});

// Add or update a user (Manager+; managers may only assign levels below their own)
router.post('/users/add', requireManager, csrfProtection, async (req, res) => {
  const { discord_id, discord_name, access_level, twitch_name, clear_twitch_name } = req.body as {
    discord_id?: string;
    discord_name?: string;
    access_level?: string;
    twitch_name?: string;
    clear_twitch_name?: string;
  };
  const trimmedDiscordId = trimField(discord_id);
  if (!trimmedDiscordId || !access_level) return res.redirect('/admin/users');

  const idErr = discordIdError(trimmedDiscordId);
  if (idErr) return res.redirect(`/admin/users?error=${idErr}`);

  const levelErr = accessLevelError(access_level);
  if (levelErr) return res.redirect(`/admin/users?error=${levelErr}`);

  const level = Number(access_level) as AccessLevelValue;
  const submittedTwitchName = trimField(twitch_name);
  const shouldClearTwitchName = clear_twitch_name === '1';
  const normalizedTwitchName = submittedTwitchName ? normalizeTwitchChannelName(submittedTwitchName) : null;

  if (!shouldClearTwitchName && submittedTwitchName && !normalizedTwitchName) {
    return res.redirect('/admin/users?error=invalid_twitch_name');
  }
  if (trimmedDiscordId === req.session.user?.discordId) {
    return res.redirect('/admin/users?error=self_edit_forbidden');
  }
  if (req.session.user!.accessLevel < AccessLevel.ADMIN && level >= req.session.user!.accessLevel) {
    return res.redirect('/admin/users?error=access_level_too_high');
  }
  if (req.session.user!.accessLevel < AccessLevel.ADMIN) {
    const existingUser = await findUser(trimmedDiscordId);
    if (existingUser && existingUser.access_level >= req.session.user!.accessLevel) {
      return res.redirect('/admin/users?error=target_above_level');
    }
  }
  try {
    const trimmedDiscordName = trimField(discord_name);
    await userMutationQueue.run(trimmedDiscordId, () => addOrUpdateUserMutation({
      discordId: trimmedDiscordId,
      discordName: trimmedDiscordName,
      level,
      normalizedTwitchName,
      shouldClearTwitchName,
    }));
  } catch (err) {
    if (err instanceof DuplicateTwitchNameError || isDuplicateTwitchNameDbError(err)) {
      return res.redirect('/admin/users?error=duplicate_twitch_name');
    }
    return handleDbError(err, res, 'add_failed', 'Add user');
  }
  res.redirect('/admin/users');
});

// Update access level (Manager+; managers may only set levels below their own and cannot modify users at their level or above)
router.post('/users/update', requireManager, csrfProtection, async (req, res) => {
  const { discord_id, access_level } = req.body as { discord_id?: string; access_level?: string };
  const trimmedDiscordId = trimField(discord_id);
  if (!trimmedDiscordId || access_level === undefined) return res.redirect('/admin/users');

  const idErr = discordIdError(trimmedDiscordId);
  if (idErr) return res.redirect(`/admin/users?error=${idErr}`);

  const levelErr = accessLevelError(access_level);
  if (levelErr) return res.redirect(`/admin/users?error=${levelErr}`);

  const level = Number(access_level);
  if (trimmedDiscordId === req.session.user!.discordId) {
    return res.redirect('/admin/users?error=self_edit_forbidden');
  }
  if (req.session.user!.accessLevel < AccessLevel.ADMIN && level >= req.session.user!.accessLevel) {
    return res.redirect('/admin/users?error=access_level_too_high');
  }
  if (req.session.user!.accessLevel < AccessLevel.ADMIN) {
    const targetUser = await findUser(trimmedDiscordId);
    if (targetUser && targetUser.access_level >= req.session.user!.accessLevel) {
      return res.redirect('/admin/users?error=target_above_level');
    }
  }
  try {
    await userMutationQueue.run(trimmedDiscordId, () => updateAccessLevel(trimmedDiscordId, level));
  } catch (err) {
    return handleDbError(err, res, 'update_failed', 'Update access level');
  }
  res.redirect('/admin/users');
});

// Remove a user (Admin only)
router.post('/users/remove', requireAdmin, csrfProtection, async (req, res) => {
  const { discord_id } = req.body as { discord_id?: string };
  const trimmedDiscordId = trimField(discord_id);
  if (!trimmedDiscordId) return res.redirect('/admin/users');

  const idErr = discordIdError(trimmedDiscordId);
  if (idErr) return res.redirect(`/admin/users?error=${idErr}`);

  if (trimmedDiscordId === req.session.user!.discordId) {
    return res.redirect('/admin/users?error=self_remove_forbidden');
  }
  try {
    await userMutationQueue.run(trimmedDiscordId, () => removeUserMutation(trimmedDiscordId));
  } catch (err) {
    return handleDbError(err, res, 'remove_failed', 'Remove user');
  }
  res.redirect('/admin/users');
});

// Toggle twitch bot participation for a user (Manager+)
router.post('/users/toggle-twitch', requireManager, csrfProtection, async (req, res) => {
  const { discord_id, is_twitch_bot_enabled } = req.body as {
    discord_id?: string;
    is_twitch_bot_enabled?: string;
  };
  const trimmedDiscordId = trimField(discord_id);
  if (!trimmedDiscordId) return res.redirect('/admin/users');

  const idErr = discordIdError(trimmedDiscordId);
  if (idErr) return res.redirect(`/admin/users?error=${idErr}`);

  const nextEnabled = parseTwitchEnabled(is_twitch_bot_enabled);
  if (nextEnabled === null) return res.redirect('/admin/users?error=invalid_twitch_state');

  try {
    await userMutationQueue.run(trimmedDiscordId, () => toggleTwitchMutation(trimmedDiscordId, nextEnabled));
  } catch (err) {
    return handleDbError(err, res, 'toggle_failed', 'Toggle twitch user');
  }
  res.redirect('/admin/users');
});

export default router;
