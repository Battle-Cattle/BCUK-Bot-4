import { createLogger } from '../../shared/logger';
import { findUser, getGuildsForMember } from '../../db';
import { disconnectGuildStatusConnectionsForMember } from './dashboardStatusEvents';
import { disconnectCompanionConnections } from './companionEvents';

// Closes the live connections a member opened before being removed from a guild, for
// `POST /admin/users/remove` (adminUsersMutations.ts). Their web session ends on its next request on its own
// (requireAuth re-checks membership); open event streams don't make new requests, so they are
// closed here.

const log = createLogger('Web');

/**
 * Closes a member's open companion app event streams once they have no panel access left: no
 * guild membership and not the bot owner. Their token is already refused from then on (see
 * `findDiscordIdByTokenHash`), but a stream opened before the removal would otherwise stay open.
 * A failed lookup is logged, never thrown: the removal itself succeeded, and the token is refused
 * on its next use anyway.
 * @param discordId - Discord snowflake of the member just removed from a guild.
 * @returns Resolves once the check (and any disconnect) is done.
 */
async function disconnectCompanionIfNoAccessLeft(discordId: string): Promise<void> {
  try {
    const [user, guilds] = await Promise.all([findUser(discordId), getGuildsForMember(discordId)]);
    if (guilds.length === 0 && !user?.is_owner) {
      disconnectCompanionConnections(discordId);
    }
  } catch (err) {
    log.error(`Failed to check companion access for removed member ${discordId}:`, err);
  }
}

/**
 * Closes what a just-removed member still has open: their dashboard status streams for the guild,
 * and their companion app streams if that was their last guild. Never throws.
 * @param guildId - Discord snowflake of the guild they were removed from.
 * @param discordId - Discord snowflake of the removed member.
 * @returns Resolves once both are done.
 */
export async function closeRemovedMemberConnections(guildId: string, discordId: string): Promise<void> {
  disconnectGuildStatusConnectionsForMember(guildId, discordId);
  await disconnectCompanionIfNoAccessLeft(discordId);
}
