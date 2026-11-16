import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import { setMemberAccessLevel, updateMemberAccessLevel, removeGuildMember } from '../../db';
import { csrfProtection } from '../csrf';
import { requireFormGuild } from '../formGuild';
import { requireManager, requireAdmin } from '../middleware';
import { getSessionUser, getCurrentGuildId } from '../session';
import { closeRemovedMemberConnections } from './memberRemovalConnections';
import {
  DuplicateTwitchNameError,
  isDuplicateTwitchNameDbError,
  addOrUpdateUserMutation,
  toggleTwitchMutation,
} from './adminUserMutations';
import { parseAccessLevel, parseAddUserForm, parseTwitchEnabled, resolveValidDiscordId } from './adminUserValidation';
import {
  checkManagerEditAuth,
  checkRemoveAuth,
  checkToggleTwitchAuth,
  canEditGlobalUserFields,
} from './adminUserAuth';
import { handleDbError } from './adminUserErrors';
import { reloadRegistrySafe, runGuardedUserMutation } from './adminUsersMutationRunner';

// The member-mutation routes of the /admin/users page (add, update level, remove, toggle Twitch),
// mounted by `admin.ts`, which serves the page itself. Each route validates its input, then runs
// its authorization check and write together in the per-user mutation queue (see
// `runGuardedUserMutation`).

const log = createLogger('Web');
export const router = Router();

// Every form on the page carries the guild it was rendered for; see formGuild.ts.
const requireUsersPageGuild = requireFormGuild('/admin/users');

// Add a member to the current guild, or update their identity/level (Manager+;
// managers may only assign levels below their own). Identity and Twitch are global;
// the access level is written to guild_member for the current guild.

/**
 * POST /admin/users/add — adds a Discord user (creating/updating their global user
 * row and Twitch identity) and grants them membership of the current guild at the
 * requested access level. For an existing user the actor may not rewrite globally
 * (see `canEditGlobalUserFields`), only the membership is granted and the submitted
 * name/Twitch fields are ignored. Reloads the guild registry afterwards, since a new member
 * may provision a previously-inert guild.
 * @param req - Express request; reads `discord_id`, `discord_name`, `access_level`,
 *   `twitch_name`, `clear_twitch_name` and `guild_id` from `req.body`, plus the acting manager's
 *   `getSessionUser(req)` and current guild.
 * @param res - Express response; redirects to `/admin/users` on success, or to
 *   `/admin/users?error=<code>` for validation failures (e.g. `invalid_discord_id`,
 *   `invalid_access_level`, `access_level_too_high`, `invalid_twitch_name`,
 *   `duplicate_twitch_name`, `guild_changed`) or a DB failure (`add_failed`).
 */
router.post('/users/add', requireManager, csrfProtection, requireUsersPageGuild, async (req, res) => {
  const guildId = getCurrentGuildId(req);
  const form = parseAddUserForm(res, req.body as Record<string, string | undefined>);
  if (!form) return;

  const sessionUser = getSessionUser(req);
  await runGuardedUserMutation(res, sessionUser.discordId, form.discordId, {
    authorize: () => checkManagerEditAuth(sessionUser, form.discordId, form.level, guildId),
    write: async () => {
      // Ensure the global user row (whitelist + Twitch identity) exists, then grant
      // membership of the current guild at the chosen level. An existing user this actor may
      // not rewrite globally (e.g. one who only belongs to other guilds) just gets the
      // membership — see canEditGlobalUserFields.
      if (await canEditGlobalUserFields(sessionUser, form.discordId, guildId)) {
        await addOrUpdateUserMutation(form);
      } else {
        log.info(`Add user: ${form.discordId} is managed by other guilds; granting membership of ${guildId} without changing their global user fields`);
      }
      await setMemberAccessLevel(guildId, form.discordId, form.level);
      // Reloaded here, inside the guarded operation, rather than after runGuardedUserMutation
      // returns: a newly-added member may have provisioned a previously-inert guild, and
      // runUserMutationForActorAndTarget's timeout only bounds what the *caller* observes — the
      // operation itself keeps running and can still commit after the caller's promise has
      // rejected. Reloading here means that still happens even when the HTTP request times out
      // waiting, instead of leaving the in-memory registry stale until some later mutation happens
      // to reload it.
      await reloadRegistrySafe();
    },
    onError: (err) => {
      if (err instanceof DuplicateTwitchNameError || isDuplicateTwitchNameDbError(err)) {
        res.redirect('/admin/users?error=duplicate_twitch_name');
      } else {
        handleDbError(err, res, 'add_failed', 'Add user');
      }
    },
  });
});

// Update a member's access level within the current guild (Manager+; managers may
// only set levels below their own and cannot modify members at their level or above)

/**
 * POST /admin/users/update — updates an existing member's access level within the current
 * guild. Never creates a membership: a user with no row in the guild gets `not_found`.
 * @param req - Express request; reads `discord_id`, `access_level` and `guild_id` from `req.body`.
 * @param res - Express response; redirects to `/admin/users` on success, or to
 *   `/admin/users?error=<code>` for validation failures (e.g. `invalid_discord_id`,
 *   `invalid_access_level`, `access_level_too_high`, `target_above_level`), a form rendered
 *   for another guild (`guild_changed`), a non-member (`not_found`) or a DB failure
 *   (`update_failed`).
 */
router.post('/users/update', requireManager, csrfProtection, requireUsersPageGuild, async (req, res) => {
  const guildId = getCurrentGuildId(req);

  const { discord_id, access_level } = req.body as { discord_id?: string; access_level?: string };
  if (access_level === undefined) return res.redirect('/admin/users');
  const trimmedDiscordId = resolveValidDiscordId(res, discord_id);
  if (!trimmedDiscordId) return;

  const level = parseAccessLevel(access_level);
  if (level === null) return res.redirect('/admin/users?error=invalid_access_level');

  const sessionUser = getSessionUser(req);
  await runGuardedUserMutation(res, sessionUser.discordId, trimmedDiscordId, {
    authorize: () => checkManagerEditAuth(sessionUser, trimmedDiscordId, level, guildId),
    // Update-only: a level change never adds anyone to the guild (that's /users/add).
    write: async () => (await updateMemberAccessLevel(guildId, trimmedDiscordId, level)) ? null : 'not_found',
    onError: (err) => handleDbError(err, res, 'update_failed', 'Update access level'),
  });
});

// Remove a member from the current guild (Admin only). The global user row and
// Twitch identity are left intact — they may belong to other guilds.

/**
 * POST /admin/users/remove — removes a member from the current guild. Refuses to
 * let an admin remove themselves, re-checks the acting admin's own current
 * authorization inside the queued operation (see `checkRemoveAuth`'s doc comment),
 * closes the removed member's open streams (see `closeRemovedMemberConnections`),
 * and reloads the guild registry afterwards since removing the last member
 * un-provisions the guild.
 * @param req - Express request; reads `discord_id` and `guild_id` from `req.body`.
 * @param res - Express response; redirects to `/admin/users` on success, or to
 *   `/admin/users?error=<code>` if the form was rendered for another guild
 *   (`guild_changed`), `discord_id` is invalid (`invalid_discord_id`),
 *   the target is the acting admin (`self_remove_forbidden`), the actor's own
 *   access has since dropped below Admin (`target_above_level`), or removal fails
 *   (`remove_failed`).
 */
router.post('/users/remove', requireAdmin, csrfProtection, requireUsersPageGuild, async (req, res) => {
  const guildId = getCurrentGuildId(req);

  const { discord_id } = req.body as { discord_id?: string };
  const trimmedDiscordId = resolveValidDiscordId(res, discord_id);
  if (!trimmedDiscordId) return;

  const sessionUser = getSessionUser(req);
  if (trimmedDiscordId === sessionUser.discordId) {
    return res.redirect('/admin/users?error=self_remove_forbidden');
  }
  await runGuardedUserMutation(res, sessionUser.discordId, trimmedDiscordId, {
    authorize: () => checkRemoveAuth(sessionUser, guildId),
    write: async () => {
      await removeGuildMember(guildId, trimmedDiscordId);
      // Their open dashboard (and, if this was their last guild, companion) streams were admitted
      // before the removal; their web session ends on its next request.
      await closeRemovedMemberConnections(guildId, trimmedDiscordId);
      // Reloaded here, inside the guarded operation — see the /users/add route's comment on
      // reloadRegistrySafe for why (removing the guild's last member un-provisions it, and this
      // must still happen even if the caller times out waiting on the queue).
      await reloadRegistrySafe();
    },
    onError: (err) => handleDbError(err, res, 'remove_failed', 'Remove user'),
  });
});

// Toggle twitch bot participation for a user (Manager+)

/**
 * POST /admin/users/toggle-twitch — toggles whether a user participates in the
 * Twitch bot. The flag is global, so a non-owner actor must outrank the target in
 * every guild the target belongs to (see `checkToggleTwitchAuth`).
 * @param req - Express request; reads `discord_id`, `is_twitch_bot_enabled` and
 *   `guild_id` from `req.body`.
 * @param res - Express response; redirects to `/admin/users` on success, or to
 *   `/admin/users?error=<code>` for validation failures (e.g. `invalid_discord_id`,
 *   `invalid_twitch_state`, `guild_changed`) or a DB failure (`toggle_failed`).
 */
router.post('/users/toggle-twitch', requireManager, csrfProtection, requireUsersPageGuild, async (req, res) => {
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
  await runGuardedUserMutation(res, sessionUser.discordId, trimmedDiscordId, {
    authorize: () => checkToggleTwitchAuth(sessionUser, guildId, trimmedDiscordId),
    write: () => toggleTwitchMutation(trimmedDiscordId, nextEnabled),
    onError: (err) => handleDbError(err, res, 'toggle_failed', 'Toggle twitch user'),
  });
});
