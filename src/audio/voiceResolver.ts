import { createLogger } from '../shared/logger';
import { Client } from 'discord.js';
import { DISCORD_GUILD_ID, DISCORD_VOICE_CHANNEL_ID } from '../shared/config';
import { findUserByTwitchName, findUserByDiscordGuildId } from '../db';
import type { GuildAudioContext } from './audioTypes';

const log = createLogger('VoiceResolver');

/**
 * Find the voice channel the given Discord user is currently sitting in within the guild.
 * Returns null if the user is not in a voice channel or cannot be fetched.
 */
export async function resolveCurrentVoiceChannel(
  client: Client,
  guildId: string,
  discordUserId: string,
): Promise<string | null> {
  try {
    const guild = await client.guilds.fetch(guildId);
    const member = await guild.members.fetch({ user: discordUserId, force: true });
    return member.voice.channelId ?? null;
  } catch (err) {
    log.warn(`[${guildId}] Could not resolve voice channel for user ${discordUserId}:`, err);
    return null;
  }
}

/**
 * Build a GuildAudioContext for the owner of the given Twitch channel.
 * Looks up the user by twitch_name, then finds which voice channel they are currently in.
 * Returns null if no user is found, no guild is configured, or the user is not in voice.
 */
export async function resolveContextForTwitchChannel(
  client: Client,
  twitchChannel: string,
): Promise<GuildAudioContext | null> {
  const user = await findUserByTwitchName(twitchChannel);
  if (!user?.discord_guild_id) {
    return getFallbackContext(client);
  }

  const voiceChannelId = await resolveCurrentVoiceChannel(client, user.discord_guild_id, user.discord_id);
  if (!voiceChannelId) {
    log.info(`[twitch:${twitchChannel}] Streamer not in a voice channel in guild ${user.discord_guild_id} — skipping SFX`);
    return null;
  }

  return { guildId: user.discord_guild_id, voiceChannelId };
}

/**
 * Build a GuildAudioContext for the given Discord guild.
 * Finds the user configured for that guild, then resolves which voice channel they are in.
 * Returns null if no user is found or the user is not in a voice channel.
 */
export async function resolveContextForDiscordGuild(
  client: Client,
  guildId: string,
): Promise<GuildAudioContext | null> {
  const user = await findUserByDiscordGuildId(guildId);
  if (!user) {
    // Unknown guild — check if it's the default guild, fall back if so
    if (guildId === DISCORD_GUILD_ID) {
      return getFallbackContext(client);
    }
    log.info(`[discord:${guildId}] No user configured for this guild — skipping SFX`);
    return null;
  }

  const voiceChannelId = await resolveCurrentVoiceChannel(client, guildId, user.discord_id);
  if (!voiceChannelId) {
    log.info(`[discord:${guildId}] Streamer not in a voice channel — skipping SFX`);
    return null;
  }

  return { guildId, voiceChannelId };
}

/**
 * Fall back to the env-var default guild, using DISCORD_VOICE_CHANNEL_ID as a static channel.
 * Used when no per-user routing is configured.
 */
async function getFallbackContext(_client: Client): Promise<GuildAudioContext | null> {
  if (!DISCORD_GUILD_ID || !DISCORD_VOICE_CHANNEL_ID) return null;
  return { guildId: DISCORD_GUILD_ID, voiceChannelId: DISCORD_VOICE_CHANNEL_ID };
}
