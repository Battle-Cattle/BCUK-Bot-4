// Notifying wrapper for guilds.ts writes, re-exported by the db.ts facade.
import { upsertGuild as upsertGuildRecord } from './guilds';
import { notifyGuildInfoChanged } from './guildInfoEvents';
import { withInvalidation } from './withInvalidation';

/**
 * Inserts a guild row if it does not exist, otherwise refreshes its name, then tells guild-info listeners the guild's
 * name may have changed. Runs on every `guildCreate`, reconnects included, so an unchanged name notifies too: cheap, and
 * the write can't tell the two apart.
 * @param guildId - BIGINT snowflake as a string.
 * @param name - Human-friendly server name.
 * @returns Resolves once the upsert (and the notification) completes.
 */
export async function upsertGuild(guildId: string, name: string): Promise<void> {
  await withInvalidation(() => upsertGuildRecord(guildId, name), () => notifyGuildInfoChanged(guildId));
}
