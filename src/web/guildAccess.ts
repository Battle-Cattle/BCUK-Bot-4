import type { Request } from 'express';
import {
  AccessLevel,
  findUser,
  getAllGuilds,
  getEffectiveAccessLevelForUser,
  getGuildsForMember,
  type AccessLevelValue,
  type DbGuild,
  type DbUser,
} from '../db';

/** Result of {@link fetchLiveGuildsForUser}. */
export interface LiveGuildsResult {
  /** Every guild this user currently has access to, freshly read from the DB. */
  guilds: DbGuild[];
  /**
   * For a non-owner, this user's access level per guild id — already returned by
   * {@link getGuildsForMember}, so {@link resolveAccessLevelForGuild} can read it
   * straight off this map instead of a second `guild_member` query. `null` for an
   * owner, whose access level is resolved via {@link getEffectiveAccessLevelForUser}
   * instead (which short-circuits to Admin without a query).
   */
  accessLevelByGuildId: Map<string, number> | null;
}

/**
 * Fetches `dbUser`'s live guild list: every guild, for an owner, or just the guilds
 * they're a member of otherwise. Always reads fresh from the DB (never a cached
 * session value), so a membership or owner-flag change since login takes effect
 * immediately rather than only at next login.
 * @param dbUser - The user to fetch guilds for.
 * @returns The user's live guilds, plus a per-guild access-level map for a non-owner.
 */
export async function fetchLiveGuildsForUser(dbUser: DbUser): Promise<LiveGuildsResult> {
  if (dbUser.is_owner) {
    return { guilds: await getAllGuilds(), accessLevelByGuildId: null };
  }
  const memberships = await getGuildsForMember(dbUser.discord_id);
  return {
    guilds: memberships,
    accessLevelByGuildId: new Map(memberships.map((g) => [g.guild_id, g.access_level])),
  };
}

/**
 * Resolves `dbUser`'s effective access level for `guildId`. Reads it off
 * `accessLevelByGuildId` (from {@link fetchLiveGuildsForUser}) when given — the
 * non-owner path — or calls {@link getEffectiveAccessLevelForUser} otherwise, which
 * short-circuits to Admin for an owner without a query.
 * @param dbUser - The user to resolve an access level for.
 * @param guildId - The guild to resolve the access level in.
 * @param accessLevelByGuildId - The map from {@link fetchLiveGuildsForUser}'s result, or
 *   `null` to always resolve via {@link getEffectiveAccessLevelForUser}.
 * @returns The resolved access level, defaulting to `AccessLevel.USER` when `guildId`
 *   is absent from `accessLevelByGuildId`.
 */
export async function resolveAccessLevelForGuild(
  dbUser: DbUser,
  guildId: string,
  accessLevelByGuildId: Map<string, number> | null,
): Promise<AccessLevelValue> {
  return (
    accessLevelByGuildId
      ? accessLevelByGuildId.get(guildId) ?? AccessLevel.USER
      : await getEffectiveAccessLevelForUser(guildId, dbUser)
  ) as AccessLevelValue;
}

/** A signed-in user's live user row and guilds, read by {@link getLiveAccessForRequest}. */
export interface LiveAccess {
  /** The user's current `user` row. */
  dbUser: DbUser;
  /** The user's current guilds and per-guild access levels. */
  live: LiveGuildsResult;
}

/**
 * One lookup per request. Several routers share a mount prefix and each runs `requireAuth` (and
 * `requireGuildContext` reuses the result), so without this one request could read the same
 * rows several times.
 */
const liveAccessByRequest = new WeakMap<Request, Promise<LiveAccess | null>>();

/**
 * Reads the signed-in user's `user` row and live guilds from the database, once per request:
 * later calls for the same request get the same promise.
 * @param req - The request, used as the memo key.
 * @param discordId - Discord snowflake of the session's user.
 * @returns The live user row and guilds, or null when the user row no longer exists.
 */
export function getLiveAccessForRequest(req: Request, discordId: string): Promise<LiveAccess | null> {
  let pending = liveAccessByRequest.get(req);
  if (!pending) {
    pending = (async () => {
      const dbUser = await findUser(discordId);
      if (!dbUser) return null;
      return { dbUser, live: await fetchLiveGuildsForUser(dbUser) };
    })();
    liveAccessByRequest.set(req, pending);
  }
  return pending;
}

/**
 * Whether a live lookup still lets the user use the panel: the user row exists, and they are the
 * bot owner or still belong to at least one guild. The same rule sign-in applies.
 * @param access - The result of {@link getLiveAccessForRequest}.
 * @returns True when the session may continue.
 */
export function hasPanelAccess(access: LiveAccess | null): access is LiveAccess {
  return access !== null && (access.dbUser.is_owner || access.live.guilds.length > 0);
}
