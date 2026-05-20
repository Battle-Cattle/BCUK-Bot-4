import { DiscordAPIError, RESTJSONErrorCodes } from 'discord.js';
import { getDiscordClient } from './discordBot';

export function isDiscordNotFoundError(err: unknown): boolean {
  return err instanceof DiscordAPIError && (
    err.code === RESTJSONErrorCodes.UnknownMessage ||
    err.code === RESTJSONErrorCodes.UnknownChannel ||
    err.status === 404
  );
}

export function isPermanentVoiceMisconfigurationError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const { message } = err;
  const apiErr = err as Error & { status?: number; code?: number | string };
  const status = apiErr.status;
  const code = typeof apiErr.code === 'string' ? Number(apiErr.code) : apiErr.code;
  const isConfigError =
    message.includes('Missing DISCORD_GUILD_ID or DISCORD_VOICE_CHANNEL_ID') ||
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
    console.error(`[discordUtils] Failed to delete Discord message ${messageId} in channel ${channelId}:`, err);
    throw err;
  }
}
