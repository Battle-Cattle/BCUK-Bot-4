import { Client } from 'discord.js';
import { getRegisteredGuildIds } from './guildRegistry';
import { getDiscordClient } from './discordBot';

/**
 * Returns the guild ID in which the given Discord user currently has a live
 * voice-channel connection, scanning only the bot's registered guilds.
 * Returns null if the user isn't connected to voice in any registered guild
 * (e.g. a command fired before they joined voice) — callers must treat that
 * as "no target guild, no-op" rather than guessing a default.
 *
 * A Discord account can only be connected to one voice channel across every
 * server at any given moment, so a match here is always unambiguous even when
 * the bot itself is simultaneously playing audio in more than one guild.
 *
 * @param client - Ready Discord client, used to read cached voice states.
 * @param discordId - Discord snowflake of the user to locate.
 * @returns The guild ID the user is currently in voice in, or null.
 */
export function getActiveGuildForUser(client: Client, discordId: string): string | null {
  for (const guildId of getRegisteredGuildIds()) {
    const guild = client.guilds.cache.get(guildId);
    const channelId = guild?.voiceStates.cache.get(discordId)?.channelId;
    if (channelId) return guildId;
  }
  return null;
}

/**
 * Resolves which guild a chat command targeting `discordId` should be routed to:
 * the guild in which that Discord user currently has a live voice-channel
 * connection. Used by `twitchBot.ts`'s guild resolution, which arrives at a
 * `discordId` via a per-channel cache.
 *
 * Returns null if `discordId` is null/empty, the Discord client isn't ready yet
 * (`getDiscordClient()` returns null), or the user isn't in voice anywhere — in
 * every case the caller should treat that as "no target guild, no-op".
 *
 * @param discordId - Discord snowflake to resolve a target guild for, or null if unresolved.
 * @returns The guild ID the user is currently in voice in, or null.
 */
export function resolveGuildIdForDiscordId(discordId: string | null): string | null {
  if (!discordId) return null;
  const discordClient = getDiscordClient();
  if (!discordClient) return null;
  return getActiveGuildForUser(discordClient, discordId);
}
