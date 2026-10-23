// Pure validation/normalisation for advanced-command writes, split from `advancedCommands.ts` so
// the SQL module stays small and these rules can be unit-tested without a DB mock.
import { ALERT_TEXT_ANIMATIONS, type TextAnimation } from './alertConfig';
import { assertNotReservedCommand } from './reservedCommands';
import { hasCommandPrefix } from '../shared/commandPrefix';

/** Lowest chat role allowed to use an advanced command (the broadcaster always can). */
export type AdvancedCommandRole = 'everyone' | 'subscriber' | 'vip' | 'moderator';

export const ADVANCED_COMMAND_ROLES: readonly AdvancedCommandRole[] = ['everyone', 'subscriber', 'vip', 'moderator'];

const MAX_ADVANCED_COMMAND_NAME_LENGTH = 64;
const MAX_ADVANCED_COMMAND_TRIGGER_LENGTH = 255;
const MAX_ADVANCED_COMMAND_RESPONSE_LENGTH = 2000;
export const MAX_ADVANCED_COMMAND_PARAMS = 10;
const MAX_ADVANCED_COMMAND_PARAM_KEY_LENGTH = 32;
const MAX_ADVANCED_COMMAND_PARAM_VALUE_LENGTH = 255;
const MAX_ADVANCED_COMMAND_ALERT_MESSAGE_LENGTH = 500;
/** Upper bound on any cost, cooldown or cap field — keeps every value inside the INT columns. */
const MAX_ADVANCED_COMMAND_NUMBER = 1_000_000_000;

const PARAM_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;

/** The editable settings of an advanced command (everything but its effects). */
export interface AdvancedCommandSettings {
  name: string;
  triggerString: string | null;
  isEnabled: boolean;
  response: string | null;
  pointCost: number;
  priceStep: number;
  maxCost: number | null;
  globalCooldownSeconds: number;
  userCooldownSeconds: number;
  minRole: AdvancedCommandRole;
  liveOnly: boolean;
  maxUsesPerStream: number | null;
  maxUsesPerUserPerStream: number | null;
  companionEnabled: boolean;
}

/** An advanced command's optional alerts-overlay alert. */
export interface AdvancedCommandAlert {
  messageTemplate: string;
  imageFilename: string | null;
  soundFilename: string | null;
  durationMs: number;
  textAnimation: TextAnimation;
}

/** One companion-event parameter. */
export interface AdvancedCommandParam {
  key: string;
  value: string;
}

/** One weighted overlay video assignment. */
interface AdvancedCommandVideoInput {
  videoId: number;
  weight: number;
}

/**
 * The alert fields saved from the effects form. The image and sound filenames aren't part of it:
 * they're only ever set by the upload route, so a form can't point an alert at an arbitrary file.
 */
export type AdvancedCommandAlertInput = Omit<AdvancedCommandAlert, 'imageFilename' | 'soundFilename'>;

/** The effects saved alongside a command: companion parameters, overlay videos and an alert. */
export interface AdvancedCommandEffectsInput {
  params: AdvancedCommandParam[];
  videos: AdvancedCommandVideoInput[];
  alert: AdvancedCommandAlertInput | null;
}

/**
 * Thrown when an advanced-command write fails validation. `code` is a stable, URL-safe error code
 * the web layer passes through as `?error=`.
 */
export class AdvancedCommandValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'AdvancedCommandValidationError';
    this.code = code;
  }
}

/**
 * Throws an {@link AdvancedCommandValidationError} unless `value` is an integer in `[min, MAX]`.
 * @param value - The number to check.
 * @param field - Field name, used in the error code (`invalid_<field>`).
 * @param min - Smallest allowed value.
 */
function assertIntInRange(value: number, field: string, min: number): void {
  if (!Number.isInteger(value) || value < min || value > MAX_ADVANCED_COMMAND_NUMBER) {
    throw new AdvancedCommandValidationError(`invalid_${field}`, `${field} must be a whole number of at least ${min}`);
  }
}

/**
 * Same as {@link assertIntInRange}, but `null` (meaning "no limit") is also allowed.
 * @param value - The number to check, or null.
 * @param field - Field name, used in the error code.
 * @param min - Smallest allowed value when set.
 */
function assertOptionalIntInRange(value: number | null, field: string, min: number): void {
  if (value !== null) assertIntInRange(value, field, min);
}

/**
 * Normalises a chat trigger: trimmed and lowercased, a single word starting with a command
 * prefix (`!` or `#`, the only messages chat treats as commands), not a built-in command.
 * @param trigger - The raw trigger, or null/blank for a Stream Deck-only command.
 * @returns The normalised trigger, or null when none was given.
 * @throws {@link AdvancedCommandValidationError} on whitespace, a missing prefix or an over-long trigger, and
 *   `ReservedCommandError` on a built-in command.
 */
export function normalizeAdvancedTrigger(trigger: string | null): string | null {
  const normalized = (trigger ?? '').trim().toLowerCase();
  if (!normalized) return null;
  if (/\s/.test(normalized) || !hasCommandPrefix(normalized) || normalized.length > MAX_ADVANCED_COMMAND_TRIGGER_LENGTH) {
    throw new AdvancedCommandValidationError('invalid_trigger', 'Trigger must be a single word starting with ! or #');
  }
  assertNotReservedCommand(normalized);
  return normalized;
}

/**
 * Normalises a command name: trimmed, 1–64 characters.
 * @param name - The raw name.
 * @returns The trimmed name.
 */
function normalizeName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > MAX_ADVANCED_COMMAND_NAME_LENGTH) {
    throw new AdvancedCommandValidationError('invalid_name', `Name must be 1-${MAX_ADVANCED_COMMAND_NAME_LENGTH} characters`);
  }
  return trimmed;
}

/**
 * Normalises the optional chat reply: blank becomes null, and it can't exceed 2000 characters.
 * @param response - The raw reply, or null.
 * @returns The trimmed reply, or null.
 */
function normalizeResponse(response: string | null): string | null {
  const trimmed = (response ?? '').trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_ADVANCED_COMMAND_RESPONSE_LENGTH) {
    throw new AdvancedCommandValidationError('invalid_response', 'Response is too long');
  }
  return trimmed;
}

/**
 * Validates the numeric settings (costs, cooldowns and caps).
 * @param settings - The settings to check.
 */
function assertNumericSettings(settings: AdvancedCommandSettings): void {
  assertIntInRange(settings.pointCost, 'point_cost', 0);
  assertIntInRange(settings.priceStep, 'price_step', 0);
  assertOptionalIntInRange(settings.maxCost, 'max_cost', settings.pointCost);
  assertIntInRange(settings.globalCooldownSeconds, 'global_cooldown', 0);
  assertIntInRange(settings.userCooldownSeconds, 'user_cooldown', 0);
  assertOptionalIntInRange(settings.maxUsesPerStream, 'max_uses', 1);
  assertOptionalIntInRange(settings.maxUsesPerUserPerStream, 'max_user_uses', 1);
}

/**
 * Validates and normalises an advanced command's settings before they're written.
 * @param settings - The settings as submitted.
 * @returns A copy with the name, trigger and response normalised.
 * @throws {@link AdvancedCommandValidationError} on any invalid field, or `ReservedCommandError`
 *   if the trigger is a built-in command.
 */
export function normalizeAdvancedCommandSettings(settings: AdvancedCommandSettings): AdvancedCommandSettings {
  if (!ADVANCED_COMMAND_ROLES.includes(settings.minRole)) {
    throw new AdvancedCommandValidationError('invalid_role', 'Unknown role');
  }
  assertNumericSettings(settings);
  return {
    ...settings,
    name: normalizeName(settings.name),
    triggerString: normalizeAdvancedTrigger(settings.triggerString),
    response: normalizeResponse(settings.response),
  };
}

/**
 * Validates companion parameters: at most 10, unique keys of letters/digits/`_`/`-`, and bounded
 * lengths. Keys and values are trimmed; a blank key is an error.
 * @param params - The parameters as submitted.
 * @returns The trimmed parameters.
 */
function normalizeParams(params: AdvancedCommandParam[]): AdvancedCommandParam[] {
  if (params.length > MAX_ADVANCED_COMMAND_PARAMS) {
    throw new AdvancedCommandValidationError('too_many_params', `At most ${MAX_ADVANCED_COMMAND_PARAMS} parameters`);
  }
  const seen = new Set<string>();
  return params.map(({ key, value }) => {
    const k = key.trim();
    const v = value.trim();
    const badKey = !PARAM_KEY_PATTERN.test(k) || k.length > MAX_ADVANCED_COMMAND_PARAM_KEY_LENGTH || seen.has(k);
    if (badKey || v.length > MAX_ADVANCED_COMMAND_PARAM_VALUE_LENGTH) {
      throw new AdvancedCommandValidationError('invalid_param', `Invalid parameter '${k}'`);
    }
    seen.add(k);
    return { key: k, value: v };
  });
}

/**
 * Validates the optional alert: a non-blank message of at most 500 characters, a positive
 * duration and a known animation.
 * @param alert - The alert as submitted, or null for none.
 * @returns The alert with its message trimmed, or null.
 */
function normalizeAlert(alert: AdvancedCommandAlertInput | null): AdvancedCommandAlertInput | null {
  if (!alert) return null;
  const message = alert.messageTemplate.trim();
  if (!message || message.length > MAX_ADVANCED_COMMAND_ALERT_MESSAGE_LENGTH) {
    throw new AdvancedCommandValidationError('invalid_alert_message', 'Alert message must be 1-500 characters');
  }
  assertIntInRange(alert.durationMs, 'alert_duration', 1);
  if (!ALERT_TEXT_ANIMATIONS.includes(alert.textAnimation)) {
    throw new AdvancedCommandValidationError('invalid_alert_animation', 'Unknown animation');
  }
  return { ...alert, messageTemplate: message };
}

/**
 * Validates and normalises a command's effects. Video ownership is checked by the write itself.
 * @param effects - The effects as submitted.
 * @returns The normalised effects, with video weights clamped to at least 1 and duplicate
 *   videos dropped (first wins).
 */
export function normalizeAdvancedCommandEffects(effects: AdvancedCommandEffectsInput): AdvancedCommandEffectsInput {
  const seenVideos = new Set<number>();
  const videos = effects.videos.filter((v) => {
    if (!Number.isInteger(v.videoId) || seenVideos.has(v.videoId)) return false;
    seenVideos.add(v.videoId);
    return true;
  }).map((v) => ({ videoId: v.videoId, weight: Number.isInteger(v.weight) ? Math.max(1, Math.min(v.weight, 1000)) : 1 }));
  return { params: normalizeParams(effects.params), videos, alert: normalizeAlert(effects.alert) };
}
