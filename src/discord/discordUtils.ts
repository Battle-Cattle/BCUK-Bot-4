import { createLogger } from '../shared/logger';
import { DiscordAPIError, RESTJSONErrorCodes, ChannelType } from 'discord.js';
import { getDiscordClient } from './discordBot';

const log = createLogger('Discord');

export function isDiscordNotFoundError(err: unknown): boolean {
  return err instanceof DiscordAPIError && (
    err.code === RESTJSONErrorCodes.UnknownMessage ||
    err.code === RESTJSONErrorCodes.UnknownChannel ||
    err.status === 404
  );
}

/**
 * Returns true when a voice-connect error is permanent and should not be retried.
 *
 * @param err - Caught error from voice connect/reconnect flow.
 * @returns Whether the error indicates permanent misconfiguration/access/not-found.
 */
export function isPermanentVoiceMisconfigurationError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const { message } = err;
  const apiErr = err as Error & { status?: number; code?: number | string };
  const status = apiErr.status;
  const code = typeof apiErr.code === 'string' ? Number(apiErr.code) : apiErr.code;
  const isConfigError =
    message.includes('Missing DISCORD_GUILD_ID or DISCORD_VOICE_CHANNEL_ID') ||
    message.includes('Missing DISCORD_GUILD_ID or voice channel ID') ||
    message.includes('Missing guild ID or voice channel ID') ||
    message.includes('is not a voice channel');
  const isForbidden = status === 403 || code === RESTJSONErrorCodes.MissingAccess;
  return isConfigError || isForbidden || isDiscordNotFoundError(err);
}

export async function tryDeleteDiscordMessage(channelId: string, messageId: string): Promise<void> {
  const discordClient = getDiscordClient();
  if (!discordClient) return;
  try {
    const ch = await discordClient.channels.fetch(channelId);
    if (!ch || !ch.isTextBased()) return;
    const msg = await ch.messages.fetch(messageId);
    await msg.delete();
  } catch (err) {
    if (isDiscordNotFoundError(err)) return;
    log.error(`Failed to delete Discord message ${messageId} in channel ${channelId}:`, err);
    throw err;
  }
}

export interface VoiceChannelInfo {
  id: string;
  name: string;
}

/**
 * Lists a guild's voice channels from the gateway-populated channel cache —
 * channels are already kept current via CHANNEL_CREATE/UPDATE/DELETE events,
 * so this avoids an unconditional bulk REST fetch (`channels.fetch()` with no
 * ID always hits the API, never the cache, unlike fetching a single channel).
 * `guilds.fetch(guildId)` itself still checks cache first, so this stays
 * REST-free in the common case.
 *
 * @param guildId - Guild whose voice channels to list.
 * @returns The guild's voice channels, sorted by name; empty if the client isn't ready.
 */
export async function getAvailableVoiceChannels(guildId: string): Promise<VoiceChannelInfo[]> {
  const discordClient = getDiscordClient();
  if (!discordClient) return [];

  try {
    const guild = await discordClient.guilds.fetch(guildId);
    return [...guild.channels.cache.values()]
      .filter((ch) => ch.type === ChannelType.GuildVoice)
      .map((ch) => ({ id: ch.id, name: ch.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    if (isDiscordNotFoundError(err)) {
      log.warn(`Guild ${guildId} not found when fetching voice channels`);
    } else {
      log.error(`Failed to fetch voice channels for guild ${guildId}:`, err);
    }
    throw err;
  }
}
