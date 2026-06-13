import { createLogger } from '../shared/logger';
import { getAllGuilds, type DbGuild } from '../db/guilds';

const log = createLogger('GuildRegistry');

// ─── In-memory registry ─────────────────────────────────────────────────────
//
// The bot decides whether to process a guild's messages by consulting this
// in-memory map rather than hitting the DB on every message. It is loaded once
// at startup via reloadGuildRegistry() and refreshed whenever the set of guilds
// changes — both from the discord.js `guildCreate` handler and when the Owner
// adds/removes a guild through the web panel. Without a refresh, new-guild
// messages would be dropped until a restart (see the multi-guild plan, Pitfall #9).

let registry = new Map<string, DbGuild>();

/**
 * Reloads the in-memory guild registry from the database. Call once at startup
 * and after any change to the set of registered guilds. On failure the previous
 * registry is left intact so a transient DB error cannot blank the whitelist.
 */
export async function reloadGuildRegistry(): Promise<void> {
  const guilds = await getAllGuilds();
  const next = new Map<string, DbGuild>();
  for (const guild of guilds) {
    next.set(guild.guild_id, guild);
  }
  registry = next;
  log.info(`Loaded ${registry.size} guild(s) into the registry.`);
}

/** Returns true if the given guild ID is registered and the bot should serve it. */
export function isRegisteredGuild(guildId: string): boolean {
  return registry.has(guildId);
}

/** Returns the cached guild config for an ID, or undefined if it is not registered. */
export function getRegisteredGuild(guildId: string): DbGuild | undefined {
  return registry.get(guildId);
}

/** Returns the IDs of every registered guild. */
export function getRegisteredGuildIds(): string[] {
  return [...registry.keys()];
}

/** Returns every registered guild's config. */
export function getRegisteredGuilds(): DbGuild[] {
  return [...registry.values()];
}

/** Test-only: clears the in-memory registry so each test starts from a clean slate. */
export function __resetGuildRegistryForTests(): void {
  registry = new Map<string, DbGuild>();
}
