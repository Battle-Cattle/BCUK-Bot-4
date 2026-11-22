// Notifying wrappers for guildMembers.ts writes that add or remove a guild's members, re-exported by the db.ts facade.
// Not wrapped: updateMemberAccessLevel, which only changes the level of an existing member (the guild's dashboard
// reads neither the level nor who is a member from it).
import {
  setMemberAccessLevel as setMemberAccessLevelRecord,
  removeGuildMember as removeGuildMemberRecord,
} from './guildMembers';
import { notifyGuildInfoChanged } from './guildInfoEvents';
import { withInvalidation } from './withInvalidation';

/**
 * Sets (inserting or updating) a user's access level within a guild, then tells guild-info listeners the guild's
 * members may have changed (the write can add a member).
 * @param guildId - Guild snowflake ID.
 * @param discordId - User snowflake ID.
 * @param accessLevel - One of the AccessLevel values (0–3); rejects invalid values.
 * @returns Resolves once the upsert (and the notification) completes.
 */
export async function setMemberAccessLevel(guildId: string, discordId: string, accessLevel: number): Promise<void> {
  await withInvalidation(() => setMemberAccessLevelRecord(guildId, discordId, accessLevel), () => notifyGuildInfoChanged(guildId));
}

/**
 * Removes a user's membership from a guild, then tells guild-info listeners the guild's members changed.
 * @param guildId - Guild snowflake ID.
 * @param discordId - User snowflake ID.
 * @returns Resolves once the delete (and the notification) completes.
 */
export async function removeGuildMember(guildId: string, discordId: string): Promise<void> {
  await withInvalidation(() => removeGuildMemberRecord(guildId, discordId), () => notifyGuildInfoChanged(guildId));
}
