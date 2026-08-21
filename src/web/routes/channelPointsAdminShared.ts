import type { Request, Response } from 'express';
import type { Logger } from 'winston';
import { DEFAULT_PRICING_COOLDOWN_SECONDS } from '../../db';
import type { DbStreamerEventSub } from '../../db';
import type { CustomRewardInput, TwitchCustomReward } from '../../twitch/twitchApi';
import { trimField, parsePositiveIntId, parseRewardIdParam, parseCheckboxField } from './validation';
import { requireStreamer } from './viewHelpers';
import { logAndRedirectError } from './errorHandling';

/** Redirect target used when the requester isn't a streamer, scoped to the channel-points admin page. */
const NOT_A_STREAMER_REDIRECT = '/channel-points?error=not_a_streamer';

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
    const streamer = await requireStreamer(req, res, NOT_A_STREAMER_REDIRECT);
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

const VALID_ROUND_TO_NEAREST = new Set([0, 5, 10]);

/**
 * Parses the optional "round to nearest" pricing field (0/5/10 points). Missing or blank
 * input defaults to `0` (rounding off) rather than being rejected, since the setting is
 * optional. An array (repeated field) or any value outside `{0, 5, 10}` is a validation error.
 */
export function parseRoundToNearestField(value: string | string[] | undefined): number | null {
  if (Array.isArray(value)) return null;
  if (typeof value !== 'string' || value.trim() === '') return 0;
  const n = Number(value);
  return VALID_ROUND_TO_NEAREST.has(n) ? n : null;
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

const TITLE_MAX_LENGTH = 45; // Twitch's own limit for a custom reward's title
const PROMPT_MAX_LENGTH = 200; // Twitch's own limit for a custom reward's prompt

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
  const cost = parsePositiveIntId(body.cost);
  const prompt = trimField(body.prompt);
  const isUserInputRequired = parseCheckboxField(body.is_user_input_required);
  const backgroundColor = parseHexColorField(body.background_color); // null = malformed; undefined = not provided (fine)
  const isMaxPerStreamEnabled = parseCheckboxField(body.is_max_per_stream_enabled);
  const maxPerStream = parsePositiveIntId(body.max_per_stream);
  const isMaxPerUserPerStreamEnabled = parseCheckboxField(body.is_max_per_user_per_stream_enabled);
  const maxPerUserPerStream = parsePositiveIntId(body.max_per_user_per_stream);
  const isGlobalCooldownEnabled = parseCheckboxField(body.is_global_cooldown_enabled);
  const globalCooldownSeconds = parsePositiveIntId(body.global_cooldown_seconds);

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
