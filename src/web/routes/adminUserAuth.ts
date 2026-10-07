// Authorization checks for the admin user-management routes: who may edit, remove or toggle
// which users, given the actor's rank in each guild they share with the target. Input parsing
// and validation live in `adminUserValidation.ts`.
import { findUser, getMemberAccessLevel, getEffectiveAccessLevelForUser, getGuildsForMember, AccessLevel } from '../../db';

/**
 * Thrown by an authorization check run inside a `runUserMutation` callback (see
 * `adminUserMutationQueue.ts`) so the check is evaluated atomically with the write it guards,
 * rather than before the write is even enqueued — see `checkManagerEditAuth`'s and
 * `checkToggleTwitchAuth`'s own doc comments for why that ordering matters. Callers catch this
 * specifically to redirect with `code` instead of falling through to a generic DB-failure redirect.
 */
export class ManagerEditAuthError extends Error {
  constructor(public readonly code: string) {
    super(`Manager edit auth check failed: ${code}`);
    this.name = 'ManagerEditAuthError';
  }
}

/**
 * Authorizes a Manager/Admin editing a user's access level within a guild.
 * Returns an error code string, or null when the edit is permitted.
 *
 * Rules: nobody edits themselves through this form; only an owner may edit an
 * owner; and a non-Admin actor may neither assign a level at or above their own
 * nor modify a target who already sits at or above their own level **in this
 * guild** (the target's level is read from `guild_member`, not the global column).
 *
 * Callers must run this *inside* the `runUserMutation` callback for `targetDiscordId` (throwing
 * a {@link ManagerEditAuthError} on a non-null result), not before enqueueing it — evaluating it
 * beforehand would read the target's level, then let an unrelated concurrent write for the same
 * user land in between the check and this call's own write, so the decision here could be stale
 * by the time it takes effect. Running it as the first thing inside the queued callback means it
 * always sees the latest committed state, since `runUserMutation` strictly serializes writes per
 * `discordId` and never releases a user's queue slot before its operation actually settles.
 *
 * The actor's own access level and owner flag are likewise re-read from the DB here rather than
 * trusted from `sessionUser`/the session cache: the session value was current when the request
 * came in, but by the time this runs the actor's own queue slot may have already processed an
 * unrelated demotion of them — re-reading closes that gap the same way the target's level is
 * re-read fresh above, instead of authorizing against a possibly-stale snapshot.
 *
 * @param sessionUser The acting user's identity (only `discordId` is used — their access level
 *   and owner flag are re-resolved from the DB, not read off this object).
 * @param targetDiscordId The user being edited.
 * @param targetLevel The access level being assigned.
 * @param guildId The guild the edit applies to.
 */
export async function checkManagerEditAuth(
  sessionUser: { discordId: string },
  targetDiscordId: string,
  targetLevel: number,
  guildId: string,
): Promise<string | null> {
  if (targetDiscordId === sessionUser.discordId) return 'self_edit_forbidden';
  const actingUser = await findUser(sessionUser.discordId);
  const actingIsOwner = actingUser?.is_owner ?? false;
  const actingAccessLevel = actingUser ? await getEffectiveAccessLevelForUser(guildId, actingUser) : AccessLevel.USER;
  // Bot owners are global super-admins — only another owner may touch them.
  const existingUser = await findUser(targetDiscordId);
  if (existingUser?.is_owner && !actingIsOwner) return 'target_above_level';
  if (actingAccessLevel < AccessLevel.ADMIN) {
    if (targetLevel >= actingAccessLevel) return 'access_level_too_high';
    const targetCurrentLevel = await getMemberAccessLevel(guildId, targetDiscordId);
    if (targetCurrentLevel !== null && targetCurrentLevel >= actingAccessLevel) return 'target_above_level';
  }
  return null;
}

/**
 * Authorizes an Admin removing a member from the current guild. Returns an error code string,
 * or null when the removal is permitted.
 *
 * `/users/remove` is already gated `requireAdmin` at the route level, but that check runs against
 * the session's access level at request time, before the operation waits on the target's mutation
 * queue slot — the same staleness `checkManagerEditAuth`'s doc comment describes. An actor whose
 * own Admin access was revoked between the request landing and this operation actually running
 * could otherwise still have their now-unauthorized removal go through.
 *
 * Callers must run this *inside* the `runUserMutation`/`runUserMutationForActorAndTarget` callback
 * for `targetDiscordId` (throwing a {@link ManagerEditAuthError} on a non-null result) — see
 * `checkManagerEditAuth`'s doc comment for why evaluating it before the write is enqueued would
 * let it go stale, including why the actor's own access level is re-read from the DB here rather
 * than trusted from `sessionUser`/the `requireAdmin` middleware's session check.
 *
 * @param sessionUser The acting user's identity (only `discordId` is used — their access level is
 *   re-resolved from the DB, not read off this object or the session).
 * @param guildId The guild to check the actor's current access level in.
 */
export async function checkRemoveAuth(
  sessionUser: { discordId: string },
  guildId: string,
): Promise<string | null> {
  const actingUser = await findUser(sessionUser.discordId);
  const actingAccessLevel = actingUser ? await getEffectiveAccessLevelForUser(guildId, actingUser) : AccessLevel.USER;
  if (actingAccessLevel < AccessLevel.ADMIN) return 'target_above_level';
  return null;
}

/**
 * Checks whether `actorId` outranks `targetId` in **every** guild the target is a member of:
 * in each such guild the actor must also be a member, and either be an Admin there or sit
 * strictly above the target's level there. A target with no memberships passes vacuously.
 *
 * Used to gate writes to *global* user state (the `user` row's name/level/Twitch name and the
 * Twitch-bot flag), which affect every guild the target belongs to — so authority in just the
 * current guild isn't enough. Bot owners are not special-cased here; callers exempt them.
 *
 * @param actorId The acting user's discordId.
 * @param targetId The user whose global state would be changed.
 * @returns True when the actor outranks the target in all of the target's guilds.
 */
export async function actorOutranksTargetInAllGuilds(actorId: string, targetId: string): Promise<boolean> {
  const [actorGuilds, targetGuilds] = await Promise.all([getGuildsForMember(actorId), getGuildsForMember(targetId)]);
  const actorLevels = new Map(actorGuilds.map((g) => [g.guild_id, g.access_level]));
  return targetGuilds.every((g) => {
    const actorLevel = actorLevels.get(g.guild_id);
    return actorLevel !== undefined && (actorLevel >= AccessLevel.ADMIN || actorLevel > g.access_level);
  });
}

/**
 * Decides whether a `/users/add` submission may rewrite the target's *global* user row
 * (Discord name, legacy global access level, Twitch name — including clearing it, which disables
 * the bot for them and parts their channel). When it may not, the route only grants membership
 * of the current guild and leaves the global row untouched.
 *
 * Permitted when the target has no user row yet (this request creates it), when the actor is a
 * bot owner, or when the target is already a member of `guildId` *and* the actor outranks them in
 * every guild they belong to (see {@link actorOutranksTargetInAllGuilds}). An existing user who
 * isn't a member of the current guild is therefore never rewritten by a guild-local Manager/Admin.
 *
 * Like {@link checkManagerEditAuth}, callers must run this inside the queued mutation callback so
 * it reads the latest committed state.
 *
 * @param sessionUser The acting user's identity (owner flag is re-read from the DB).
 * @param targetDiscordId The user being added.
 * @param guildId The guild the add applies to.
 * @returns True when the global user fields may be written.
 */
export async function canEditGlobalUserFields(
  sessionUser: { discordId: string },
  targetDiscordId: string,
  guildId: string,
): Promise<boolean> {
  const targetUser = await findUser(targetDiscordId);
  if (!targetUser) return true;
  const actingUser = await findUser(sessionUser.discordId);
  if (actingUser?.is_owner) return true;
  if ((await getMemberAccessLevel(guildId, targetDiscordId)) === null) return false;
  return actorOutranksTargetInAllGuilds(sessionUser.discordId, targetDiscordId);
}

/**
 * Authorizes a Manager/Admin toggling a user's Twitch-bot participation within a guild.
 * Returns an error code string, or null when the toggle is permitted.
 *
 * Checks that the target is a member of the current guild, that only an owner may toggle
 * another owner's Twitch state, and that the acting user outranks the target (mirrors
 * `checkManagerEditAuth`'s rules: a non-Admin actor may not modify a target already at or
 * above their own level). Because the Twitch-bot flag is global, a non-owner actor must also
 * outrank the target in every other guild the target belongs to (see
 * {@link actorOutranksTargetInAllGuilds}) — authority in the current guild alone isn't enough.
 *
 * Callers must run this *inside* the `runUserMutation` callback for `targetDiscordId` (throwing
 * a {@link ManagerEditAuthError} on a non-null result) — see `checkManagerEditAuth`'s doc comment
 * for why evaluating it before the write is enqueued would let it go stale, including why the
 * actor's own access level and owner flag are re-read from the DB here rather than trusted from
 * `sessionUser`.
 *
 * @param sessionUser The acting user's identity (only `discordId` is used — their access level
 *   and owner flag are re-resolved from the DB, not read off this object).
 * @param guildId The guild to verify membership in.
 * @param targetDiscordId The user whose Twitch state is being toggled.
 */
export async function checkToggleTwitchAuth(
  sessionUser: { discordId: string },
  guildId: string,
  targetDiscordId: string,
): Promise<string | null> {
  const memberLevel = await getMemberAccessLevel(guildId, targetDiscordId);
  if (memberLevel === null) return 'target_above_level';
  const actingUser = await findUser(sessionUser.discordId);
  const actingIsOwner = actingUser?.is_owner ?? false;
  const actingAccessLevel = actingUser ? await getEffectiveAccessLevelForUser(guildId, actingUser) : AccessLevel.USER;
  // Bot owners are global super-admins — only another owner may touch them, even an Admin.
  const existingUser = await findUser(targetDiscordId);
  if (existingUser?.is_owner && !actingIsOwner) return 'target_above_level';
  if (actingIsOwner) return null;
  if (actingAccessLevel < AccessLevel.ADMIN && memberLevel >= actingAccessLevel) return 'target_above_level';
  return (await actorOutranksTargetInAllGuilds(sessionUser.discordId, targetDiscordId)) ? null : 'target_above_level';
}
