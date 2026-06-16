import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import {
  getGuildMemberUsers,
  setMemberAccessLevel,
  removeGuildMember,
  ACCESS_LEVEL_LABELS,
  AccessLevelValue,
} from '../../db';
import { reloadGuildRegistry } from '../../discord/guildRegistry';
import { csrfProtection } from '../csrf';
import { requireManager, requireAdmin } from '../middleware';
import { trimField, renderError, filterQueryParam } from './shared';
import { createMutationQueue } from '../../shared/mutationQueue';
import adminRefreshRouter, { refreshState } from './adminRefresh';
import {
  DuplicateTwitchNameError,
  isDuplicateTwitchNameDbError,
  addOrUpdateUserMutation,
  toggleTwitchMutation,
} from './adminUserMutations';
import {
  accessLevelError,
  parseTwitchNameInput,
  checkManagerEditAuth,
  handleDbError,
  resolveValidDiscordId,
  resolveToggleTwitchInputs,
} from './adminUserValidation';

const log = createLogger('Web');
const router = Router();
router.use(adminRefreshRouter);

const KNOWN_ERRORS = new Set([
  'add_failed', 'duplicate_twitch_name', 'db_busy', 'update_failed', 'remove_failed', 'toggle_failed',
  'invalid_discord_id', 'invalid_access_level', 'access_level_too_high', 'invalid_twitch_name',
  'self_edit_forbidden', 'self_remove_forbidden', 'target_above_level', 'invalid_twitch_state',
]);
// Twitch membership changes are serialized per user in-process because this bot
// currently runs as a single web instance. If that changes, move this lock into
// shared storage or a DB transaction/row lock before scaling out.
const userMutationQueue = createMutationQueue();

// View the current guild's members (Manager+)
router.get('/users', requireManager, csrfProtection, async (req, res) => {
  const guildId = req.session.user!.currentGuildId!;
  try {
    const users = await getGuildMemberUsers(guildId);
    res.render('admin', {
      user: req.session.user,
      users,
      csrfToken: req.csrfToken(),
      accessLevelLabels: ACCESS_LEVEL_LABELS,
      error: filterQueryParam(req.query.error, KNOWN_ERRORS),
      refreshState,
    });
  } catch (err) {
    log.error('Admin users error:', err);
    renderError(res, 500, 'Failed to load users.', req.session.user);
  }
});

/** Refresh the guild registry after a membership change; log but never fail the request. */
async function reloadRegistrySafe(): Promise<void> {
  try {
    await reloadGuildRegistry();
  } catch (err) {
    log.error('Guild registry reload after membership change failed:', err);
  }
}

// Add a member to the current guild, or update their identity/level (Manager+;
// managers may only assign levels below their own). Identity and Twitch are global;
// the access level is written to guild_member for the current guild.
router.post('/users/add', requireManager, csrfProtection, async (req, res) => {
  const guildId = req.session.user!.currentGuildId!;

  const { discord_id, discord_name, access_level, twitch_name, clear_twitch_name } = req.body as {
    discord_id?: string;
    discord_name?: string;
    access_level?: string;
    twitch_name?: string;
    clear_twitch_name?: string;
  };
  const trimmedDiscordId = resolveValidDiscordId(res, discord_id);
  if (!trimmedDiscordId) return;
  if (!access_level) return res.redirect('/admin/users');

  const levelErr = accessLevelError(access_level);
  if (levelErr) return res.redirect(`/admin/users?error=${levelErr}`);

  const level = Number(access_level) as AccessLevelValue;
  const { normalizedTwitchName, shouldClearTwitchName, error: twitchErr } = parseTwitchNameInput(twitch_name, clear_twitch_name);
  if (twitchErr) return res.redirect(`/admin/users?error=${twitchErr}`);

  const addAuthErr = await checkManagerEditAuth(req.session.user!, trimmedDiscordId, level, guildId);
  if (addAuthErr) return res.redirect(`/admin/users?error=${addAuthErr}`);
  try {
    const trimmedDiscordName = trimField(discord_name);
    await userMutationQueue.run(trimmedDiscordId, async () => {
      // Ensure the global user row (whitelist + Twitch identity) exists, then grant
      // membership of the current guild at the chosen level.
      await addOrUpdateUserMutation({
        discordId: trimmedDiscordId,
        discordName: trimmedDiscordName,
        level,
        normalizedTwitchName,
        shouldClearTwitchName,
      });
      await setMemberAccessLevel(guildId, trimmedDiscordId, level);
    });
  } catch (err) {
    if (err instanceof DuplicateTwitchNameError || isDuplicateTwitchNameDbError(err)) {
      return res.redirect('/admin/users?error=duplicate_twitch_name');
    }
    return handleDbError(err, res, 'add_failed', 'Add user');
  }
  // A newly-added member may have provisioned a previously-inert guild.
  await reloadRegistrySafe();
  res.redirect('/admin/users');
});

// Update a member's access level within the current guild (Manager+; managers may
// only set levels below their own and cannot modify members at their level or above)
router.post('/users/update', requireManager, csrfProtection, async (req, res) => {
  const guildId = req.session.user!.currentGuildId!;

  const { discord_id, access_level } = req.body as { discord_id?: string; access_level?: string };
  if (access_level === undefined) return res.redirect('/admin/users');
  const trimmedDiscordId = resolveValidDiscordId(res, discord_id);
  if (!trimmedDiscordId) return;

  const levelErr = accessLevelError(access_level);
  if (levelErr) return res.redirect(`/admin/users?error=${levelErr}`);

  const level = Number(access_level);
  const updateAuthErr = await checkManagerEditAuth(req.session.user!, trimmedDiscordId, level, guildId);
  if (updateAuthErr) return res.redirect(`/admin/users?error=${updateAuthErr}`);
  try {
    await userMutationQueue.run(trimmedDiscordId, () => setMemberAccessLevel(guildId, trimmedDiscordId, level));
  } catch (err) {
    return handleDbError(err, res, 'update_failed', 'Update access level');
  }
  res.redirect('/admin/users');
});

// Remove a member from the current guild (Admin only). The global user row and
// Twitch identity are left intact — they may belong to other guilds.
router.post('/users/remove', requireAdmin, csrfProtection, async (req, res) => {
  const guildId = req.session.user!.currentGuildId!;

  const { discord_id } = req.body as { discord_id?: string };
  const trimmedDiscordId = resolveValidDiscordId(res, discord_id);
  if (!trimmedDiscordId) return;

  if (trimmedDiscordId === req.session.user!.discordId) {
    return res.redirect('/admin/users?error=self_remove_forbidden');
  }
  try {
    await userMutationQueue.run(trimmedDiscordId, () => removeGuildMember(guildId, trimmedDiscordId));
  } catch (err) {
    return handleDbError(err, res, 'remove_failed', 'Remove user');
  }
  // Removing the guild's last member un-provisions it; refresh the registry.
  await reloadRegistrySafe();
  res.redirect('/admin/users');
});

// Toggle twitch bot participation for a user (Manager+)
router.post('/users/toggle-twitch', requireManager, csrfProtection, async (req, res) => {
  const guildId = req.session.user!.currentGuildId!;

  const { discord_id, is_twitch_bot_enabled } = req.body as {
    discord_id?: string;
    is_twitch_bot_enabled?: string;
  };
  const trimmedDiscordId = resolveValidDiscordId(res, discord_id);
  if (!trimmedDiscordId) return;

  const nextEnabled = await resolveToggleTwitchInputs(res, guildId, trimmedDiscordId, is_twitch_bot_enabled);
  if (nextEnabled === null) return;

  try {
    await userMutationQueue.run(trimmedDiscordId, () => toggleTwitchMutation(trimmedDiscordId, nextEnabled));
  } catch (err) {
    return handleDbError(err, res, 'toggle_failed', 'Toggle twitch user');
  }
  res.redirect('/admin/users');
});

export default router;
