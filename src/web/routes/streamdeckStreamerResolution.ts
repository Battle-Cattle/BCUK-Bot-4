// Shared by the Stream Deck routes that act on the key owner as a streamer (advanced commands,
// raffles): resolves the key's Discord user to their streamer record.
import type { Request, Response } from 'express';
import { getStreamerByDiscordId, type DbStreamerEventSub } from '../../db';
import { ensureKeyApprovedAnywhere } from './streamdeckGuildResolution';

/**
 * Resolves the key owner's streamer record, responding with an error if the key isn't approved
 * for any guild ({@link ensureKeyApprovedAnywhere}, the same gate as `GET /sfx`) or its owner isn't
 * a streamer with a Twitch login.
 * @param req - The request; `req.apiKeyOwner` is set by `requireApiKey`.
 * @param res - The response, used for the error (403, or 500 if the approval lookup fails).
 * @returns The streamer (with a Twitch login), or null once an error response was sent.
 */
export async function resolveStreamerOrRespond(
  req: Request,
  res: Response,
): Promise<(DbStreamerEventSub & { twitch_name: string }) | null> {
  if (!(await ensureKeyApprovedAnywhere(req, res))) return null;
  const streamer = await getStreamerByDiscordId(req.apiKeyOwner!);
  if (!streamer?.twitch_name) {
    res.status(403).json({ ok: false, error: 'not_a_streamer' });
    return null;
  }
  return { ...streamer, twitch_name: streamer.twitch_name };
}
