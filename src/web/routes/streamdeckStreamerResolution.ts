// Shared by the Stream Deck routes that act on the key owner as a streamer (advanced commands,
// raffles): resolves the key's Discord user to their streamer record.
import type { Request, Response } from 'express';
import { getApprovedGuildIdsForKey, getStreamerByDiscordId, type DbStreamerEventSub } from '../../db';

/**
 * Resolves the key owner's streamer record, responding with an error if the key isn't approved
 * for any guild (the same gate as `GET /sfx`) or its owner isn't a streamer with a Twitch login.
 * @param req - The request; `req.apiKeyOwner` is set by `requireApiKey`.
 * @param res - The response, used for the error.
 * @returns The streamer (with a Twitch login), or null once an error response was sent.
 */
export async function resolveStreamerOrRespond(
  req: Request,
  res: Response,
): Promise<(DbStreamerEventSub & { twitch_name: string }) | null> {
  const discordId = req.apiKeyOwner!;
  if ((await getApprovedGuildIdsForKey(discordId)).length === 0) {
    res.status(403).json({ ok: false, error: 'Key not approved for any guild' });
    return null;
  }
  const streamer = await getStreamerByDiscordId(discordId);
  if (!streamer?.twitch_name) {
    res.status(403).json({ ok: false, error: 'not_a_streamer' });
    return null;
  }
  return { ...streamer, twitch_name: streamer.twitch_name };
}
