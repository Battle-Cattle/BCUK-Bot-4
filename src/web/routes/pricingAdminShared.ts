import type { Request, Response } from 'express';
import { getStreamerByDiscordId } from '../../db';
import type { DbStreamerEventSub } from '../../db';

/**
 * Loads the requesting user's streamer record, redirecting to `/pricing?error=not_a_streamer`
 * if they aren't one. Kept separate from overlayAdminShared's requireStreamer (which redirects
 * to `/overlay/settings`), so the two admin pages stay fully decoupled.
 */
export async function requireStreamer(req: Request, res: Response): Promise<DbStreamerEventSub | null> {
  const streamer = await getStreamerByDiscordId(req.session.user!.discordId);
  if (!streamer) {
    res.redirect('/pricing?error=not_a_streamer');
    return null;
  }
  return streamer;
}

/**
 * Parses a required positive integer form field (e.g. base_cost, cooldown_seconds).
 * Rejects arrays (repeated fields), non-numeric input, and non-positive values.
 */
export function parsePositiveIntField(value: string | string[] | undefined): number | null {
  if (Array.isArray(value)) return null;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Parses a required non-negative decimal form field (e.g. max_multiplier, redemption_increment).
 * Rejects arrays (repeated fields), non-numeric input, and negative values.
 */
export function parseNonNegativeNumberField(value: string | string[] | undefined): number | null {
  if (Array.isArray(value)) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Parses a required strictly-positive decimal form field (e.g. curve, decay_half_life_periods).
 * Rejects arrays (repeated fields), non-numeric input, and non-positive values.
 */
export function parsePositiveNumberField(value: string | string[] | undefined): number | null {
  if (Array.isArray(value)) return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}
