import type { Request, Response } from 'express';
import { getStreamerByDiscordId } from '../../db';
import type { DbStreamerEventSub } from '../../db';

export async function requireStreamer(req: Request, res: Response): Promise<DbStreamerEventSub | null> {
  const streamer = await getStreamerByDiscordId(req.session.user!.discordId);
  if (!streamer) {
    res.redirect('/overlay/settings?error=not_a_streamer');
    return null;
  }
  return streamer;
}

export function toStringArray(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}

export function parseWeight(raw: string | string[] | undefined): number {
  const n = Number(Array.isArray(raw) ? raw[0] : raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}
