import { Client } from 'discord.js';
import { getRegisteredGuildIds } from './guildRegistry';

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
