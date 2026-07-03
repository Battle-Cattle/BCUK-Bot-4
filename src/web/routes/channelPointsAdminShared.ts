import type { Request, Response } from 'express';
import { getStreamerByDiscordId } from '../../db';
import type { DbStreamerEventSub } from '../../db';

/**
 * Loads the requesting user's streamer record, redirecting to
 * `/channel-points?error=not_a_streamer` if they aren't one. Kept separate from
 * overlayAdminShared's requireStreamer (which redirects to `/overlay/settings`), so the two
 * admin pages stay fully decoupled.
 */
export async function requireStreamer(req: Request, res: Response): Promise<DbStreamerEventSub | null> {
  const streamer = await getStreamerByDiscordId(req.session.user!.discordId);
  if (!streamer) {
    res.redirect('/channel-points?error=not_a_streamer');
    return null;
  }
  return streamer;
}

/**
 * Parses an HTML checkbox field: present and `'on'` means checked. Absent (checkbox
 * unchecked) or an array (repeated field) is treated as unchecked.
 */
export function parseCheckboxField(value: string | string[] | undefined): boolean {
  return !Array.isArray(value) && value === 'on';
}

/**
 * Parses an optional `#rrggbb` hex color form field. Blank/missing input is valid and means
 * "no preference" (`undefined`, so the field is omitted from the Twitch API call). An array
 * (repeated field) or a non-blank value that doesn't match the hex format is a validation
 * error (`null`) — distinct from "not provided" so the caller can reject the whole form.
 */
export function parseHexColorField(value: string | string[] | undefined): string | null | undefined {
  if (Array.isArray(value)) return null;
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (trimmed === '') return undefined;
  return /^#[0-9A-Fa-f]{6}$/.test(trimmed) ? trimmed : null;
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
 * Rejects arrays (repeated fields), empty/whitespace input, non-numeric input, and negative values.
 */
export function parseNonNegativeNumberField(value: string | string[] | undefined): number | null {
  if (Array.isArray(value)) return null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Parses a required strictly-positive decimal form field (e.g. curve, decay_half_life_periods).
 * Rejects arrays (repeated fields), empty/whitespace input, non-numeric input, and non-positive values.
 */
export function parsePositiveNumberField(value: string | string[] | undefined): number | null {
  if (Array.isArray(value)) return null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}
