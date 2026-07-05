import type { Request, Response } from 'express';
import type { Logger } from 'winston';
import { getStreamerByDiscordId, DEFAULT_PRICING_COOLDOWN_SECONDS } from '../../db';
import type { DbStreamerEventSub } from '../../db';
import type { CustomRewardInput, TwitchCustomReward } from '../../twitch/twitchApi';
import { trimField, logAndRedirectError } from './shared';

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
 * Shared body for reward-scoped "delete" routes (deleting a reward entirely, or just turning
 * off its dynamic pricing): resolves the requester's streamer record and the `:twitchRewardId`
 * route param, runs `action`, then redirects to `/channel-points` with `success=<successCode>`
 * or (on a thrown error) `error=<errorCode>` via `logAndRedirectError`. Shared between
 * `channelPointsAdminMutations.ts` and `channelPointsAdminPricingMutations.ts`.
 */
export async function handleRewardDeleteAction(
  req: Request,
  res: Response,
  action: (streamer: DbStreamerEventSub, twitchRewardId: string) => Promise<void>,
  opts: { log: Logger; successCode: string; errorLogLabel: string; errorCode: string },
): Promise<void> {
  try {
    const streamer = await requireStreamer(req, res);
    if (!streamer) return;

    const twitchRewardId = parseRewardIdParam(req.params.twitchRewardId);
    if (twitchRewardId === null) return res.redirect('/channel-points?error=invalid_reward_id');

    await action(streamer, twitchRewardId);

    res.redirect(`/channel-points?success=${opts.successCode}`);
  } catch (err) {
    logAndRedirectError({ res, log: opts.log, logLabel: opts.errorLogLabel, err, basePath: '/channel-points', errorCode: opts.errorCode });
  }
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
 * Parses a required non-negative decimal form field (e.g. max_multiplier).
 * Rejects arrays (repeated fields), empty/whitespace input, non-numeric input, and negative values.
 */
export function parseNonNegativeNumberField(value: string | string[] | undefined): number | null {
  if (Array.isArray(value)) return null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Parses a required strictly-positive decimal form field (e.g. curve, half_life_minutes).
 * Rejects arrays (repeated fields), empty/whitespace input, non-numeric input, and non-positive values.
 */
export function parsePositiveNumberField(value: string | string[] | undefined): number | null {
  if (Array.isArray(value)) return null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * The cooldown (seconds) dynamic pricing should use for a reward: its own Twitch global
 * cooldown when enabled, otherwise a fallback default — keeps pricing's `cooldown_seconds`
 * mirroring the reward's real Twitch cooldown instead of a separately-edited value.
 */
export function effectiveCooldownSeconds(reward: Pick<TwitchCustomReward, 'global_cooldown_setting'>): number {
  return reward.global_cooldown_setting.is_enabled
    ? reward.global_cooldown_setting.global_cooldown_seconds
    : DEFAULT_PRICING_COOLDOWN_SECONDS;
}

const REWARD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TITLE_MAX_LENGTH = 45; // Twitch's own limit for a custom reward's title
const PROMPT_MAX_LENGTH = 200; // Twitch's own limit for a custom reward's prompt

/** Extracts and validates a `:twitchRewardId` route param, or null if malformed/repeated. */
export function parseRewardIdParam(value: string | string[]): string | null {
  if (Array.isArray(value)) return null;
  return REWARD_ID_RE.test(value) ? value : null;
}

/** True unless `condition` holds without `requirement` also holding — e.g. a limit's checkbox is checked but its numeric field is missing. */
function impliesTruth(condition: boolean, requirement: boolean): boolean {
  return !condition || requirement;
}

/**
 * Parses and validates the full set of Twitch custom reward fields shared by the create and
 * edit forms. Returns `null` if any field is invalid — including cross-field rules Twitch
 * itself enforces (a prompt is required when user input is required; a limit's numeric value
 * is required when that limit's "enabled" checkbox is checked).
 */
export function parseRewardFields(body: Record<string, string | string[] | undefined>): CustomRewardInput | null {
  const title = trimField(body.title);
  const cost = parsePositiveIntField(body.cost);
  const prompt = trimField(body.prompt);
  const isUserInputRequired = parseCheckboxField(body.is_user_input_required);
  const backgroundColor = parseHexColorField(body.background_color); // null = malformed; undefined = not provided (fine)
  const isMaxPerStreamEnabled = parseCheckboxField(body.is_max_per_stream_enabled);
  const maxPerStream = parsePositiveIntField(body.max_per_stream);
  const isMaxPerUserPerStreamEnabled = parseCheckboxField(body.is_max_per_user_per_stream_enabled);
  const maxPerUserPerStream = parsePositiveIntField(body.max_per_user_per_stream);
  const isGlobalCooldownEnabled = parseCheckboxField(body.is_global_cooldown_enabled);
  const globalCooldownSeconds = parsePositiveIntField(body.global_cooldown_seconds);

  const isValid = [
    title !== '' && title.length <= TITLE_MAX_LENGTH,
    cost !== null,
    prompt.length <= PROMPT_MAX_LENGTH,
    backgroundColor !== null,
    impliesTruth(isUserInputRequired, prompt !== ''),
    impliesTruth(isMaxPerStreamEnabled, maxPerStream !== null),
    impliesTruth(isMaxPerUserPerStreamEnabled, maxPerUserPerStream !== null),
    impliesTruth(isGlobalCooldownEnabled, globalCooldownSeconds !== null),
  ].every(Boolean);
  if (!isValid) return null;

  return {
    title,
    cost: cost!,
    prompt: prompt || undefined,
    is_enabled: parseCheckboxField(body.is_enabled),
    background_color: backgroundColor ?? undefined,
    is_user_input_required: isUserInputRequired,
    is_max_per_stream_enabled: isMaxPerStreamEnabled,
    max_per_stream: isMaxPerStreamEnabled ? maxPerStream! : undefined,
    is_max_per_user_per_stream_enabled: isMaxPerUserPerStreamEnabled,
    max_per_user_per_stream: isMaxPerUserPerStreamEnabled ? maxPerUserPerStream! : undefined,
    is_global_cooldown_enabled: isGlobalCooldownEnabled,
    global_cooldown_seconds: isGlobalCooldownEnabled ? globalCooldownSeconds! : undefined,
    should_redemptions_skip_request_queue: parseCheckboxField(body.should_redemptions_skip_request_queue),
  };
}
