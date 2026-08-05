import { createLogger } from '../shared/logger';
import { DiscordAPIError, RESTJSONErrorCodes, ChannelType, type Client, type MessageEditOptions, type TextBasedChannel } from 'discord.js';
import { getDiscordClient } from './discordClientStore';

const log = createLogger('Discord');

/**
 * Checks whether `err` represents a Discord "not found" condition (unknown
 * message/channel or an HTTP 404) that callers should treat as a benign no-op
 * rather than a failure to log/retry.
 *
 * @param err - Caught error to inspect.
 * @returns True if `err` is a Discord not-found error.
 */
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

/**
 * Fetches `messageId` from `channelId` and deletes it, if a Discord client is
 * available and the channel is text-based. Not-found errors (message/channel
 * already gone) are swallowed; any other error is logged and rethrown.
 *
 * @param channelId - ID of the channel containing the message.
 * @param messageId - ID of the message to delete.
 * @returns Resolves once the delete (or a no-op) has completed.
 */
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

/**
 * Fetches `channelId` from `client` and returns it only if it resolves to a
 * text-based channel. Mirrors the fetch+`isTextBased()` guard duplicated across
 * `twitchMonitorAnnouncements.ts`, `twitchMonitorMultitwitch.ts`, and
 * `twitchMonitorStartup.ts` before sending or editing a Discord message.
 *
 * @param client - Discord client to fetch the channel from.
 * @param channelId - ID of the channel to fetch.
 * @returns The text-based channel, or null if it doesn't exist or isn't text-based.
 */
export async function getTextChannel(client: Client, channelId: string): Promise<TextBasedChannel | null> {
  const channel = await client.channels.fetch(channelId);
  if (!channel || !channel.isTextBased()) return null;
  return channel;
}

/**
 * Fetches `messageId` from `channelId` (via `client`) and edits it with `payload`.
 * Returns false — without throwing — when the channel isn't text-based/doesn't
 * exist, or the channel/message fetch fails with a Discord not-found error (see
 * {@link isDiscordNotFoundError}), exactly like {@link tryDeleteDiscordMessage}'s
 * not-found handling. Any other error is logged and rethrown.
 *
 * @param client - Discord client to fetch the channel/message from.
 * @param channelId - ID of the channel containing the message.
 * @param messageId - ID of the message to edit.
 * @param payload - Edit payload passed through to `message.edit`.
 * @returns True if the message was edited; false if the channel/message could not be found.
 */
export async function tryEditDiscordMessage(
  client: Client,
  channelId: string,
  messageId: string,
  payload: MessageEditOptions,
): Promise<boolean> {
  try {
    const channel = await getTextChannel(client, channelId);
    if (!channel) return false;
    const message = await channel.messages.fetch(messageId);
    await message.edit(payload);
    return true;
  } catch (err) {
    if (isDiscordNotFoundError(err)) return false;
    log.error(`Failed to edit Discord message ${messageId} in channel ${channelId}:`, err);
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
