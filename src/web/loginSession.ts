// Builds the dashboard session for a whitelisted user once they have proved who they are. Shared
// by both sign-in methods — Discord OAuth (`routes/auth.ts`) and passkeys
// (`routes/passkeysLogin.ts`) — so both produce an identical session.
import type { Request } from 'express';
import { promisify } from 'util';
import { createLogger } from '../shared/logger';
import {
  updateDiscordName,
  getAllGuilds,
  getGuildsForMember,
  getEffectiveAccessLevelForUser,
  AccessLevel,
  type DbGuild,
  type DbUser,
} from '../db';
import { fetchMemberDisplayName } from '../discord/discordBot';
import { runUserMutation } from '../shared/userMutationQueue';
import type { SessionUser } from '../types/express';

const log = createLogger('Web');

/** Discord's minimal `@me` profile shape used by the OAuth2 callback (and rebuilt from the bot client by passkey login). */
export interface DiscordProfile {
  id: string;
  username: string;
  avatar: string | null;
}

/**
 * Resolves the guilds a whitelisted user may act in. Owners get every guild;
 * everyone else gets the guilds they have a membership row in.
 * @param dbUser - The whitelisted user row from `findUser`.
 * @returns The user's accessible guilds (empty if not provisioned anywhere).
 */
export async function resolveAccessibleGuilds(dbUser: DbUser): Promise<DbGuild[]> {
  return dbUser.is_owner ? getAllGuilds() : getGuildsForMember(dbUser.discord_id);
}

/**
 * Best-effort sync of the user's display name from Discord (display names are
 * per-guild; this looks up one guild at login time), persisting the change
 * through `runUserMutation` if it differs from the stored name. Never throws —
 * a failed lookup or write just falls back to the previously stored name, so
 * the session never shows a name that didn't actually get persisted.
 * @param profile - The Discord profile from `fetchDiscordProfile`.
 * @param dbUser - The whitelisted user row from `findUser`.
 * @param lookupGuildId - Guild ID to resolve the per-guild display name against.
 * @returns The synced (or unchanged) display name.
 */
async function syncDiscordName(profile: DiscordProfile, dbUser: DbUser, lookupGuildId: string): Promise<string> {
  const storedDiscordName = dbUser.discord_name?.trim() || profile.username;
  try {
    const displayName = await fetchMemberDisplayName(profile.id, lookupGuildId, true);
    const trimmedDisplayName = displayName?.trim();
    const candidateName = trimmedDisplayName || storedDiscordName;
    if (candidateName !== dbUser.discord_name) {
      await runUserMutation(profile.id, () => updateDiscordName(profile.id, candidateName));
    }
    return candidateName;
  } catch (syncErr) {
    log.warn('Non-blocking discord_name sync failed:', syncErr);
    return storedDiscordName;
  }
}

/**
 * Resolves the initial guild/access-level pair for a freshly logged-in session.
 * Auto-selects when there is only one accessible guild; otherwise leaves the
 * guild unpicked (forcing the guild picker) with access level defaulted to User.
 * @param accessibleGuilds - Guilds resolved by `resolveAccessibleGuilds`.
 * @param dbUser - The whitelisted user row from `findUser`.
 * @returns The guild to activate (or null) and the matching access level.
 */
async function resolveInitialGuildAndAccessLevel(
  accessibleGuilds: DbGuild[],
  dbUser: DbUser,
): Promise<{ currentGuildId: string | null; accessLevel: SessionUser['accessLevel'] }> {
  const currentGuildId = accessibleGuilds.length === 1 ? accessibleGuilds[0]!.guild_id : null; // length checked
  const accessLevel = currentGuildId
    ? ((await getEffectiveAccessLevelForUser(currentGuildId, dbUser)) as SessionUser['accessLevel'])
    : AccessLevel.USER;
  return { currentGuildId, accessLevel };
}

/**
 * Builds the dashboard session's `user` payload from the resolved login data.
 * @param profile - The Discord profile from `fetchDiscordProfile`.
 * @param dbUser - The whitelisted user row from `findUser`.
 * @param syncedDiscordName - Display name from `syncDiscordName`.
 * @param accessibleGuilds - Guilds resolved by `resolveAccessibleGuilds`.
 * @param guildAndAccessLevel - Result of `resolveInitialGuildAndAccessLevel`.
 * @returns The `SessionUser` to store on `req.session.user`.
 */
function buildSessionUser(
  profile: DiscordProfile,
  dbUser: DbUser,
  syncedDiscordName: string,
  accessibleGuilds: DbGuild[],
  guildAndAccessLevel: { currentGuildId: string | null; accessLevel: SessionUser['accessLevel'] },
): SessionUser {
  const rawAvatar = profile.avatar
    ? `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.png`
    : null;
  return {
    discordId: profile.id,
    discordName: syncedDiscordName,
    discordAvatar: rawAvatar?.startsWith('https://cdn.discordapp.com/') ? rawAvatar : null,
    isOwner: dbUser.is_owner,
    ...guildAndAccessLevel,
    guilds: accessibleGuilds.map((g) => ({ guildId: g.guild_id, name: g.name })),
  };
}

/**
 * Regenerates the session ID (to prevent session fixation) and saves the
 * given user payload onto the fresh session.
 * @param req - Express request whose session is regenerated and saved.
 * @param userData - The `SessionUser` payload to store.
 * @param discordAuthAt - When the user completed Discord OAuth, for a Discord login; omitted for
 *   a passkey sign-in, so the new session carries no recent-Discord-login timestamp.
 * @returns Resolves once the regenerated session has been saved.
 */
async function saveSessionUser(req: Request, userData: SessionUser, discordAuthAt: number | undefined): Promise<void> {
  await promisify(req.session.regenerate.bind(req.session))();
  // regenerate() replaces req.session, so read it again only after it has finished.
  req.session.user = userData;
  if (discordAuthAt !== undefined) req.session.discordAuthAt = discordAuthAt;
  await promisify(req.session.save.bind(req.session))();
}

/**
 * Creates the dashboard session for a whitelisted user with at least one accessible guild:
 * syncs their display name, picks the initial guild/access level, then regenerates and saves
 * the session. Shared by the Discord OAuth callback and passkey sign-in so both produce an
 * identical session.
 * @param req - Express request whose session is regenerated and populated.
 * @param profile - The user's Discord profile (id, username, avatar hash).
 * @param dbUser - The whitelisted user row from `findUser`.
 * @param accessibleGuilds - Non-empty result of `resolveAccessibleGuilds`.
 * @param options - `discordAuthAt`: set only by the Discord OAuth callback, recording when the
 *   user last proved control of their Discord account (checked before adding a passkey).
 * @returns Resolves once the new session has been saved.
 * @throws If `accessibleGuilds` is empty (callers reject that case before calling).
 */
export async function establishDashboardSession(
  req: Request,
  profile: DiscordProfile,
  dbUser: DbUser,
  accessibleGuilds: DbGuild[],
  options: { discordAuthAt?: number } = {},
): Promise<void> {
  const firstGuild = accessibleGuilds[0];
  if (!firstGuild) throw new Error('establishDashboardSession: accessibleGuilds must be non-empty');
  const syncedDiscordName = await syncDiscordName(profile, dbUser, firstGuild.guild_id);
  const guildAndAccessLevel = await resolveInitialGuildAndAccessLevel(accessibleGuilds, dbUser);
  const userData = buildSessionUser(profile, dbUser, syncedDiscordName, accessibleGuilds, guildAndAccessLevel);
  await saveSessionUser(req, userData, options.discordAuthAt);
}
