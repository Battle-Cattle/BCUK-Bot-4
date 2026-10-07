// Discord REST lookups and DMs made through the bot's client: member display names, user
// profiles and direct messages. Separate from `discordBot.ts` so web routes and other callers
// can use them without importing the bot's lifecycle, command dispatch and gateway handling.
import type { Guild } from 'discord.js';
import { createLogger } from '../shared/logger';
import { getDiscordClient } from './discordClientStore';

const log = createLogger('Discord');

/**
 * Resolve a guild by ID from the discord.js cache, falling back to a fetch.
 * @throws if the client is not ready.
 */
async function getGuild(guildId: string): Promise<Guild> {
  const client = getDiscordClient();
  if (!client) {
    throw new Error('Discord client is not ready');
  }
  const cached = client.guilds.cache.get(guildId);
  if (cached) return cached;
  return client.guilds.fetch(guildId);
}

/**
 * Fetch the display name of a Discord guild member.
 * Returns null if the client is not ready, the guild is unavailable, or the member is not found.
 *
 * @param discordId - Discord user snowflake ID to look up.
 * @param guildId - Guild to look the member up in.
 * @param force - When true, bypasses the guild member cache and fetches fresh from the API.
 * @returns The member's server display name, or null on any failure.
 */
export async function fetchMemberDisplayName(
  discordId: string,
  guildId: string,
  force = false,
): Promise<string | null> {
  if (!getDiscordClient()) return null;
  try {
    const guild = await getGuild(guildId);
    const member = await guild.members.fetch({ user: discordId, force });
    return member.displayName;
  } catch (err) {
    log.warn(`Failed to fetch display name for ${discordId}:`, err);
    return null;
  }
}

/**
 * Fetches a user's global Discord profile (username and avatar hash) via the bot client.
 * Used by passkey login, which has no Discord OAuth `@me` response to read these from.
 * @param discordId - Discord user ID to look up.
 * @returns The user's username and avatar hash (null avatar if they use the default one),
 *   or null if the bot isn't ready or the fetch fails.
 */
export async function fetchDiscordUserProfile(
  discordId: string,
): Promise<{ username: string; avatar: string | null } | null> {
  const client = getDiscordClient();
  if (!client) return null;
  try {
    const user = await client.users.fetch(discordId);
    return { username: user.username, avatar: user.avatar };
  } catch (err) {
    log.warn(`Failed to fetch Discord profile for ${discordId}:`, err);
    return null;
  }
}

/**
 * Sends a direct message from the bot to a user, with all mentions disabled. Used for passkey
 * enrollment codes and security notices, which must reach the account owner rather than
 * whoever holds a web session.
 * @param discordId - Discord user ID to message.
 * @param content - Message text.
 * @returns True if the message was sent; false if the bot isn't ready or Discord refused it
 *   (e.g. the user doesn't accept DMs from the bot).
 */
export async function sendDiscordDirectMessage(discordId: string, content: string): Promise<boolean> {
  const client = getDiscordClient();
  if (!client) return false;
  try {
    const user = await client.users.fetch(discordId);
    await user.send({ content, allowedMentions: { parse: [] } });
    return true;
  } catch (err) {
    log.warn(`Failed to send Discord DM to ${discordId}:`, err);
    return false;
  }
}
