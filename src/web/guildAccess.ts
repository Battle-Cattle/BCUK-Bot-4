import {
  AccessLevel,
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
