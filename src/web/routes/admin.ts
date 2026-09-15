import { createLogger } from '../../shared/logger';
import { Router, type Response } from 'express';
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
import { getSessionUser, getCurrentGuildId } from '../session';
import { trimField, filterQueryParam } from './validation';
import { renderView } from './viewHelpers';
import { renderOrError } from './errorHandling';
import { runUserMutationForActorAndTarget } from './adminUserMutationQueue';
import adminRefreshRouter, { getRefreshState } from './adminRefresh';
import {
  DuplicateTwitchNameError,
  isDuplicateTwitchNameDbError,
  addOrUpdateUserMutation,
  toggleTwitchMutation,
} from './adminUserMutations';
import {
  accessLevelError,
  parseTwitchNameInput,
  parseTwitchEnabled,
  checkManagerEditAuth,
  checkRemoveAuth,
  checkToggleTwitchAuth,
  ManagerEditAuthError,
  handleDbError,
  resolveValidDiscordId,
} from './adminUserValidation';

const log = createLogger('Web');
const router = Router();
router.use(adminRefreshRouter);

const KNOWN_ERRORS = new Set([
  'add_failed', 'duplicate_twitch_name', 'db_busy', 'update_failed', 'remove_failed', 'toggle_failed',
  'invalid_discord_id', 'invalid_access_level', 'access_level_too_high', 'invalid_twitch_name',
  'self_edit_forbidden', 'self_remove_forbidden', 'target_above_level', 'invalid_twitch_state',
]);
// View the current guild's members (Manager+)

/**
 * GET /admin/users — renders the member-management page for the current guild,
 * listing every member with their access level and Twitch state.
 * @param req - Express request; reads `getCurrentGuildId(req)` and the
 *   `error` query param.
 * @param res - Express response; renders the `admin` view, or a 500 error page if
 *   loading members fails.
 */
router.get('/users', requireManager, csrfProtection, async (req, res) => {
  const guildId = getCurrentGuildId(req);
  await renderOrError({ res, log, logLabel: 'Admin users error:', sessionUser: req.session.user, errorMessage: 'Failed to load users.' }, async () => {
    const users = await getGuildMemberUsers(guildId);
    renderView(res, 'admin', {
      user: req.session.user,
      users,
      csrfToken: req.csrfToken(),
      accessLevelLabels: ACCESS_LEVEL_LABELS,
      error: filterQueryParam(req.query.error, KNOWN_ERRORS),
      refreshState: getRefreshState(guildId),
    });
  });
});

/** Refresh the guild registry after a membership change; log but never fail the request. */
async function reloadRegistrySafe(): Promise<void> {
  try {
    await reloadGuildRegistry();
  } catch (err) {
    log.error('Guild registry reload after membership change failed:', err);
  }
}

/**
 * Runs `operation` (typically a `checkManagerEditAuth`/`checkToggleTwitchAuth` check followed by
 * the write it guards) inside `runUserMutationForActorAndTarget` for `actorId`/`targetId`,
 * centralizing the `ManagerEditAuthError` → `?error=<code>` redirect shared by every queued
 * mutation route below so it isn't repeated at each call site. Any other error is handled by
 * `onOtherError` instead.
 *
 * Serializing against both ids (not just `targetId`) matters here specifically because
 * `operation`'s authorization check re-reads the *acting* user's own current access level — see
 * `runUserMutationForActorAndTarget`'s doc comment for why a target-only lock still leaves that
 * read racing a concurrent demotion of the actor.
 * @param res - Express response, used to redirect on a `ManagerEditAuthError`.
 * @param actorId - The acting user's discordId.
 * @param targetId - The user whose mutations `operation` should serialize against.
 * @param operation - The auth-check-then-write to run inside the queue.
 * @param onOtherError - Called (and expected to redirect) for any error other than
 *   `ManagerEditAuthError`.
 * @returns true if `operation` succeeded — the caller should continue with any post-success side
 *   effects and its own final redirect; false if it failed and a redirect has already been sent.
 */
async function runGuardedUserMutation(
  res: Response,
  actorId: string,
  targetId: string,
  operation: () => Promise<void>,
  onOtherError: (err: unknown) => void,
): Promise<boolean> {
  try {
    await runUserMutationForActorAndTarget(actorId, targetId, operation);
    return true;
  } catch (err) {
    if (err instanceof ManagerEditAuthError) {
      res.redirect(`/admin/users?error=${err.code}`);
    } else {
      onOtherError(err);
    }
    return false;
  }
}

// Add a member to the current guild, or update their identity/level (Manager+;
// managers may only assign levels below their own). Identity and Twitch are global;
// the access level is written to guild_member for the current guild.

/**
 * POST /admin/users/add — adds a Discord user (creating/updating their global user
 * row and Twitch identity) and grants them membership of the current guild at the
 * requested access level. Reloads the guild registry afterwards, since a new member
 * may provision a previously-inert guild.
 * @param req - Express request; reads `discord_id`, `discord_name`, `access_level`,
 *   `twitch_name`, and `clear_twitch_name` from `req.body`, plus the acting manager's
 *   `getSessionUser(req)` and current guild.
 * @param res - Express response; redirects to `/admin/users` on success, or to
 *   `/admin/users?error=<code>` for validation failures (e.g. `invalid_discord_id`,
 *   `invalid_access_level`, `access_level_too_high`, `invalid_twitch_name`,
 *   `duplicate_twitch_name`) or a DB failure (`add_failed`).
 */
router.post('/users/add', requireManager, csrfProtection, async (req, res) => {
  const guildId = getCurrentGuildId(req);

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

  const sessionUser = getSessionUser(req);
  const trimmedDiscordName = trimField(discord_name);
  const ok = await runGuardedUserMutation(res, sessionUser.discordId, trimmedDiscordId, async () => {
    // Re-checked here, not before enqueueing — see checkManagerEditAuth's doc comment.
    const addAuthErr = await checkManagerEditAuth(sessionUser, trimmedDiscordId, level, guildId);
    if (addAuthErr) throw new ManagerEditAuthError(addAuthErr);
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
    // Reloaded here, inside the guarded operation, rather than after runGuardedUserMutation
    // returns: a newly-added member may have provisioned a previously-inert guild, and
    // runUserMutationForActorAndTarget's timeout only bounds what the *caller* observes — the
    // operation itself keeps running and can still commit after the caller's promise has
    // rejected. Reloading here means that still happens even when the HTTP request times out
    // waiting, instead of leaving the in-memory registry stale until some later mutation happens
    // to reload it.
    await reloadRegistrySafe();
  }, (err) => {
    if (err instanceof DuplicateTwitchNameError || isDuplicateTwitchNameDbError(err)) {
      res.redirect('/admin/users?error=duplicate_twitch_name');
    } else {
      handleDbError(err, res, 'add_failed', 'Add user');
    }
  });
  if (!ok) return;
  res.redirect('/admin/users');
});

// Update a member's access level within the current guild (Manager+; managers may
// only set levels below their own and cannot modify members at their level or above)

/**
 * POST /admin/users/update — updates a member's access level within the current guild.
 * @param req - Express request; reads `discord_id` and `access_level` from `req.body`.
 * @param res - Express response; redirects to `/admin/users` on success, or to
 *   `/admin/users?error=<code>` for validation failures (e.g. `invalid_discord_id`,
 *   `invalid_access_level`, `access_level_too_high`, `target_above_level`) or a DB
 *   failure (`update_failed`).
 */
router.post('/users/update', requireManager, csrfProtection, async (req, res) => {
  const guildId = getCurrentGuildId(req);

  const { discord_id, access_level } = req.body as { discord_id?: string; access_level?: string };
  if (access_level === undefined) return res.redirect('/admin/users');
  const trimmedDiscordId = resolveValidDiscordId(res, discord_id);
  if (!trimmedDiscordId) return;

  const levelErr = accessLevelError(access_level);
  if (levelErr) return res.redirect(`/admin/users?error=${levelErr}`);

  const level = Number(access_level);
  const sessionUser = getSessionUser(req);
  const ok = await runGuardedUserMutation(res, sessionUser.discordId, trimmedDiscordId, async () => {
    // Re-checked here, not before enqueueing — see checkManagerEditAuth's doc comment.
    const updateAuthErr = await checkManagerEditAuth(sessionUser, trimmedDiscordId, level, guildId);
    if (updateAuthErr) throw new ManagerEditAuthError(updateAuthErr);
    await setMemberAccessLevel(guildId, trimmedDiscordId, level);
  }, (err) => handleDbError(err, res, 'update_failed', 'Update access level'));
  if (!ok) return;
  res.redirect('/admin/users');
});

// Remove a member from the current guild (Admin only). The global user row and
// Twitch identity are left intact — they may belong to other guilds.

/**
 * POST /admin/users/remove — removes a member from the current guild. Refuses to
 * let an admin remove themselves, re-checks the acting admin's own current
 * authorization inside the queued operation (see `checkRemoveAuth`'s doc comment),
 * and reloads the guild registry afterwards since removing the last member
 * un-provisions the guild.
 * @param req - Express request; reads `discord_id` from `req.body`.
 * @param res - Express response; redirects to `/admin/users` on success, or to
 *   `/admin/users?error=<code>` if `discord_id` is invalid (`invalid_discord_id`),
 *   the target is the acting admin (`self_remove_forbidden`), the actor's own
 *   access has since dropped below Admin (`target_above_level`), or removal fails
 *   (`remove_failed`).
 */
router.post('/users/remove', requireAdmin, csrfProtection, async (req, res) => {
  const guildId = getCurrentGuildId(req);

  const { discord_id } = req.body as { discord_id?: string };
  const trimmedDiscordId = resolveValidDiscordId(res, discord_id);
  if (!trimmedDiscordId) return;

  const sessionUser = getSessionUser(req);
  if (trimmedDiscordId === sessionUser.discordId) {
    return res.redirect('/admin/users?error=self_remove_forbidden');
  }
  const ok = await runGuardedUserMutation(res, sessionUser.discordId, trimmedDiscordId, async () => {
    // Re-checked here, not before enqueueing — see checkRemoveAuth's doc comment.
    const removeAuthErr = await checkRemoveAuth(sessionUser, guildId);
    if (removeAuthErr) throw new ManagerEditAuthError(removeAuthErr);
    await removeGuildMember(guildId, trimmedDiscordId);
    // Reloaded here, inside the guarded operation — see the /users/add route's comment on
    // reloadRegistrySafe for why (removing the guild's last member un-provisions it, and this
    // must still happen even if the caller times out waiting on the queue).
    await reloadRegistrySafe();
  }, (err) => handleDbError(err, res, 'remove_failed', 'Remove user'));
  if (!ok) return;
  res.redirect('/admin/users');
});

// Toggle twitch bot participation for a user (Manager+)

/**
 * POST /admin/users/toggle-twitch — toggles whether a user participates in the
 * Twitch bot.
 * @param req - Express request; reads `discord_id` and `is_twitch_bot_enabled`
 *   from `req.body`.
 * @param res - Express response; redirects to `/admin/users` on success, or to
 *   `/admin/users?error=<code>` for validation failures (e.g. `invalid_discord_id`,
 *   `invalid_twitch_state`) or a DB failure (`toggle_failed`).
 */
router.post('/users/toggle-twitch', requireManager, csrfProtection, async (req, res) => {
  const guildId = getCurrentGuildId(req);

  const { discord_id, is_twitch_bot_enabled } = req.body as {
    discord_id?: string;
    is_twitch_bot_enabled?: string;
  };
  const trimmedDiscordId = resolveValidDiscordId(res, discord_id);
  if (!trimmedDiscordId) return;

  const nextEnabled = parseTwitchEnabled(is_twitch_bot_enabled);
  if (nextEnabled === null) return res.redirect('/admin/users?error=invalid_twitch_state');

  const sessionUser = getSessionUser(req);
  const ok = await runGuardedUserMutation(res, sessionUser.discordId, trimmedDiscordId, async () => {
    // Re-checked here, not before enqueueing — see checkManagerEditAuth's doc comment.
    const toggleAuthErr = await checkToggleTwitchAuth(sessionUser, guildId, trimmedDiscordId);
    if (toggleAuthErr) throw new ManagerEditAuthError(toggleAuthErr);
    await toggleTwitchMutation(trimmedDiscordId, nextEnabled);
  }, (err) => handleDbError(err, res, 'toggle_failed', 'Toggle twitch user'));
  if (!ok) return;
  res.redirect('/admin/users');
});

export default router;
