// Discord REST lookups and DMs made through the bot's client: member display names, user
// profiles and direct messages. Separate from `discordBot.ts` so web routes and other callers
// can use them without importing the bot's lifecycle, command dispatch and gateway handling.
import { makeURLSearchParams } from '@discordjs/rest';
import { Routes, type APIGuildMember } from 'discord-api-types/v10';
import type { Guild } from 'discord.js';
import { createLogger } from '../shared/logger';
import { getDiscordClient } from './discordClientStore';

const log = createLogger('Discord');

/**
 * Resolve a guild by ID from the discord.js cache, falling back to a fetch.
 * @param guildId - Discord snowflake of the guild.
 * @returns The cached or freshly fetched guild.
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

/** Page size for {@link fetchAllMemberDisplayNames}: the most Discord's List Guild Members endpoint returns per request. */
const MEMBER_LIST_PAGE_SIZE = 1000;

/**
 * A raw member's server display name, by the same precedence as discord.js's
 * `GuildMember#displayName`: server nickname, then global display name, then username.
 * @param member - Member object from Discord's REST API.
 * @returns The display name.
 */
function apiMemberDisplayName(member: APIGuildMember): string {
  return member.nick ?? member.user.global_name ?? member.user.username;
}

/**
 * Fetches every member's display name in a guild via the paginated List Guild Members REST
 * endpoint. Calls the endpoint directly rather than `guild.members.list()`, which would add every
 * member's `User` to the client's unbounded user cache even with `cache: false`. Discord only
 * allows this when the Server Members privileged intent is enabled for the application in the
 * developer portal (the gateway intent itself need not be requested), so callers must be ready to
 * fall back to per-member lookups.
 * @param guildId - Guild whose members to list.
 * @returns Display names keyed by Discord user id, or null if the client isn't ready or any page
 *   fails (e.g. Missing Access because the intent is off, or a page that doesn't advance).
 */
export async function fetchAllMemberDisplayNames(guildId: string): Promise<Map<string, string> | null> {
  const client = getDiscordClient();
  if (!client) return null;
  try {
    const names = new Map<string, string>();
    let after = '0';
    for (;;) {
      const page = await client.rest.get(Routes.guildMembers(guildId), {
        query: makeURLSearchParams({ limit: MEMBER_LIST_PAGE_SIZE, after }),
      }) as APIGuildMember[];
      for (const member of page) names.set(member.user.id, apiMemberDisplayName(member));
      const last = page.at(-1)?.user.id;
      if (page.length < MEMBER_LIST_PAGE_SIZE || last === undefined) return names;
      // A full page that doesn't move the cursor would loop forever; treat it as a failed listing.
      if (last === after) throw new Error(`Member listing cursor did not advance past ${after}`);
      after = last;
    }
  } catch (err) {
    log.warn(`Failed to list members of guild ${guildId}:`, err);
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
