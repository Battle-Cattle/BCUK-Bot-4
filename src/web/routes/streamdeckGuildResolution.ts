import { Request, Response } from 'express';
import { Client } from 'discord.js';
import { isKeyApprovedForGuild } from '../../db';
import { getActiveGuildForUser } from '../../discord/voicePresence';

/**
 * Resolves which guild a voice-channel ID belongs to, or null if the channel
 * doesn't exist / isn't a guild channel.
 */
export async function resolveGuildIdFromChannelId(client: Client, channelId: string): Promise<string | null> {
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !('guildId' in channel)) return null;
    return channel.guildId ?? null;
  } catch {
    return null;
  }
}

/**
 * Confirms the request's API key is approved for `guildId`, sending a generic
 * 403 and returning false if not. Shared by every Streamdeck route so
 * approval denial always produces the same response.
 */
export async function ensureGuildApproved(req: Request, res: Response, guildId: string): Promise<boolean> {
  if (!(await isKeyApprovedForGuild(req.apiKeyOwner!, guildId))) {
    res.status(403).json({ ok: false, error: 'Key not approved for this guild' });
    return false;
  }
  return true;
}

/**
 * Resolves the guild a channel-scoped Streamdeck action (join/leave) should
 * target from the request's own `channelId`, and confirms the key is approved
 * for that guild. Sends the appropriate error response and returns null on
 * any failure.
 */
export async function resolveChannelGuildOrRespond(req: Request, res: Response, client: Client, channelId: string): Promise<string | null> {
  const guildId = await resolveGuildIdFromChannelId(client, channelId);
  if (!guildId) {
    res.status(400).json({ ok: false, error: 'Unknown voice channel' });
    return null;
  }
  return (await ensureGuildApproved(req, res, guildId)) ? guildId : null;
}

/**
 * Resolves the guild a presence-scoped Streamdeck action (e.g. play SFX)
 * should target: wherever the key owner currently has a live voice-channel
 * connection, since a Discord account can only be in one voice channel across
 * every server at a time. Sends the appropriate error response and returns
 * null on any failure.
 */
export async function resolvePresenceGuildOrRespond(req: Request, res: Response, client: Client): Promise<string | null> {
  const guildId = getActiveGuildForUser(client, req.apiKeyOwner!);
  if (!guildId) {
    res.status(503).json({ ok: false, error: 'Not currently connected to a voice channel in any server' });
    return null;
  }
  return (await ensureGuildApproved(req, res, guildId)) ? guildId : null;
}
