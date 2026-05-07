import { DiscordAPIError, RESTJSONErrorCodes } from 'discord.js';
import { discordClient } from './discordBot';

export function isDiscordNotFoundError(err: unknown): boolean {
  return err instanceof DiscordAPIError && (
    err.code === RESTJSONErrorCodes.UnknownMessage ||
    err.code === RESTJSONErrorCodes.UnknownChannel ||
    err.status === 404
  );
}

export async function tryDeleteDiscordMessage(channelId: string, messageId: string): Promise<void> {
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
