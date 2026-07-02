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

/**
 * Parse a weight form field into a positive integer ≥ 1 (floored), or null when
 * the value is missing, non-numeric, not positive, or an array (repeated field).
 * Rejecting arrays is consistent with parsePositiveIntId — a duplicated weight
 * field can't slip through silently.
 * @param raw - Raw value from a form field.
 * @returns A positive integer weight, or null when invalid.
 */
export function parseWeight(raw: string | string[] | undefined): number | null {
  if (Array.isArray(raw)) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.floor(n);
}
